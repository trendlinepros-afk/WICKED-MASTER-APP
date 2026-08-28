import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type { QuotaInfo, Transfer, VaultFile, VaultStatus } from './types'
import {
  DriveApiError,
  DriveAuthError,
  about,
  downloadToFile,
  findByName,
  findOrCreateFolder,
  getFileMeta,
  listFolder,
  md5File,
  oauthAuthorize,
  refreshAccessToken,
  renameFile,
  resumableUpload,
  revokeToken,
  trashFile,
  type DriveFileRaw
} from './ipc/gdrive'

/* ------------------------------------------------------------------------ *
 *  FILE VAULT — personal cloud file storage on the user's own Google Drive.
 *
 *  Everything lives in ONE Drive folder ("WICKED Vault" at My Drive root).
 *  Costs nothing on top of the user's Drive plan: the Drive API has no usage
 *  billing, and a Workspace/Business account can register the OAuth app as
 *  "Internal" (no Google verification, refresh tokens never expire).
 *
 *  Credentials: the OAuth client id is stored plaintext (it is public by
 *  design for installed apps); the client secret and refresh token are
 *  safeStorage(DPAPI)-encrypted in this module's data folder and NEVER sent
 *  to the renderer. auth.json is excluded from Backup/Cloud Sync snapshots
 *  (see backup-core.ts) — on a new PC the user just clicks Connect again.
 *
 *  Transfers: chunked resumable uploads and Range-resume downloads run in a
 *  small queue here in main (2 at a time), pushing progress to the renderer;
 *  every completed transfer is MD5-verified against Drive's checksum, which
 *  matters when the files are executables you'll actually run.
 * ------------------------------------------------------------------------ */

const ID = 'file-vault'
const VAULT_FOLDER_NAME = 'WICKED Vault'
const MAX_ACTIVE = 2

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function register(ctx: ModuleIpcContext): void {
  const dataDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const authPath = join(dataDir, 'auth.json')

  /* ------------------------------ auth state ------------------------------ */

  interface AuthDisk {
    v: 1
    enc: boolean
    clientId: string
    clientSecret: string
    refreshToken: string
    email: string
  }

  let clientId = ''
  let clientSecret = ''
  let refreshToken = ''
  let email = ''
  let authLoaded = false
  let access: { token: string; exp: number } | null = null
  let connecting = false

  const encStr = (v: string): string =>
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(v).toString('base64')
      : Buffer.from(v, 'utf8').toString('base64')

  function saveAuth(): void {
    mkdirSync(dataDir, { recursive: true })
    const disk: AuthDisk = {
      v: 1,
      enc: safeStorage.isEncryptionAvailable(),
      clientId,
      clientSecret: clientSecret ? encStr(clientSecret) : '',
      refreshToken: refreshToken ? encStr(refreshToken) : '',
      email
    }
    writeFileSync(authPath, JSON.stringify(disk))
  }

  function ensureAuthLoaded(): void {
    if (authLoaded) return
    authLoaded = true
    try {
      if (!existsSync(authPath)) return
      const disk = JSON.parse(readFileSync(authPath, 'utf8')) as AuthDisk
      clientId = disk.clientId ?? ''
      email = disk.email ?? ''
      const dec = (b64: string): string =>
        !b64
          ? ''
          : disk.enc
            ? safeStorage.decryptString(Buffer.from(b64, 'base64'))
            : Buffer.from(b64, 'base64').toString('utf8')
      clientSecret = dec(disk.clientSecret)
      refreshToken = dec(disk.refreshToken)
    } catch {
      // e.g. the file came from another PC/user: DPAPI blobs won't decrypt.
      // Keep the (public) client id if it survived; drop the secrets so the
      // UI asks to reconnect instead of failing on every call.
      clientSecret = ''
      refreshToken = ''
    }
  }

  async function getToken(): Promise<string> {
    ensureAuthLoaded()
    if (!refreshToken) throw new Error('Not connected to Google Drive — open File Vault and click Connect.')
    if (access && Date.now() < access.exp - 60_000) return access.token
    try {
      const r = await refreshAccessToken(clientId, clientSecret, refreshToken)
      access = { token: r.accessToken, exp: Date.now() + r.expiresIn * 1000 }
      return access.token
    } catch (err) {
      if (err instanceof DriveAuthError && err.invalidGrant) {
        refreshToken = ''
        access = null
        saveAuth()
        throw new Error('Google Drive access expired or was revoked — click Connect to sign in again.')
      }
      throw err
    }
  }

  /* ------------------------------ vault folder ----------------------------- */

  async function ensureVault(token: string): Promise<string> {
    let fid = ctx.storeGet(`${ID}.folderId`, '')
    if (fid) return fid
    fid = await findOrCreateFolder(token, VAULT_FOLDER_NAME)
    ctx.storeSet(`${ID}.folderId`, fid)
    return fid
  }

  const toVaultFile = (f: DriveFileRaw): VaultFile => ({
    id: f.id,
    name: f.name,
    size: Number(f.size ?? 0),
    mimeType: f.mimeType,
    md5: f.md5Checksum ?? '',
    modifiedTime: f.modifiedTime ?? '',
    createdTime: f.createdTime ?? '',
    webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`
  })

  async function listVault(): Promise<VaultFile[]> {
    const token = await getToken()
    try {
      const fid = await ensureVault(token)
      const raw = await listFolder(token, fid)
      return raw.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder').map(toVaultFile)
    } catch (err) {
      if (err instanceof DriveApiError && err.status === 404) {
        // cached folder id points at a deleted folder — re-create and retry
        ctx.storeSet(`${ID}.folderId`, '')
        const fid = await ensureVault(token)
        const raw = await listFolder(token, fid)
        return raw.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder').map(toVaultFile)
      }
      throw err
    }
  }

  /** Resolve a vault file by id or (exact) name — shared by UI and MCP paths. */
  async function resolveFile(fileId?: string, name?: string): Promise<VaultFile> {
    const token = await getToken()
    if (fileId) return toVaultFile(await getFileMeta(token, fileId))
    if (name) {
      const fid = await ensureVault(token)
      const found = await findByName(token, fid, name)
      if (!found) throw new Error(`No file named "${name}" in the vault.`)
      return toVaultFile(found)
    }
    throw new Error('Provide a fileId or a name.')
  }

  /* ------------------------------- transfers ------------------------------- */

  const transfers: Transfer[] = []
  const aborts = new Map<string, AbortController>()

  let sendTimer: NodeJS.Timeout | null = null
  let lastSend = 0
  function sendTransfers(force = false): void {
    const emit = (): void => {
      lastSend = Date.now()
      ctx.getMainWindow()?.webContents.send(`${ID}:transfers-changed`, transfers)
    }
    if (force || Date.now() - lastSend > 250) {
      if (sendTimer) {
        clearTimeout(sendTimer)
        sendTimer = null
      }
      emit()
    } else if (!sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = null
        emit()
      }, 250)
    }
  }

  const tickSpeed = (t: Transfer): void => {
    const secs = (Date.now() - t.startedAt) / 1000
    t.bps = secs > 0.5 ? t.done / secs : 0
  }

  async function runUpload(t: Transfer, signal: AbortSignal): Promise<void> {
    const token = await getToken()
    const folderId = await ensureVault(token)
    const existing = await findByName(token, folderId, t.name)
    t.replaced = !!existing
    const file = await resumableUpload({
      localPath: t.localPath,
      size: t.size,
      name: t.name,
      folderId,
      existingFileId: existing?.id,
      getToken,
      signal,
      onProgress: (sent) => {
        t.done = sent
        tickSpeed(t)
        sendTransfers()
      }
    })
    t.fileId = file.id
    t.done = t.size
    if (file.md5Checksum) {
      t.status = 'verifying'
      sendTransfers(true)
      t.verified = (await md5File(t.localPath)) === file.md5Checksum
      if (!t.verified)
        throw new Error('Checksum mismatch after upload — the copy on Drive does not match this file. Upload it again.')
    }
  }

  async function runDownload(t: Transfer, signal: AbortSignal): Promise<void> {
    const token = await getToken()
    const meta = await getFileMeta(token, t.fileId!)
    t.size = Number(meta.size ?? 0)
    const part = `${t.localPath}.wkdownload`
    rmSync(part, { force: true })
    mkdirSync(dirname(t.localPath), { recursive: true })
    try {
      await downloadToFile({
        fileId: t.fileId!,
        destPart: part,
        getToken,
        signal,
        onProgress: (done) => {
          t.done = done
          tickSpeed(t)
          sendTransfers()
        }
      })
      if (meta.md5Checksum) {
        t.status = 'verifying'
        sendTransfers(true)
        t.verified = (await md5File(part)) === meta.md5Checksum
        if (!t.verified) throw new Error('Checksum mismatch — the downloaded copy is corrupt. Try again.')
      }
      rmSync(t.localPath, { force: true })
      renameSync(part, t.localPath)
    } catch (err) {
      rmSync(part, { force: true })
      throw err
    }
  }

  function pump(): void {
    const active = transfers.filter((t) => t.status === 'active' || t.status === 'verifying').length
    if (active >= MAX_ACTIVE) return
    const next = transfers.find((t) => t.status === 'queued')
    if (!next) return
    next.status = 'active'
    next.startedAt = Date.now()
    sendTransfers(true)
    const ac = new AbortController()
    aborts.set(next.id, ac)
    void (async () => {
      try {
        if (next.kind === 'upload') await runUpload(next, ac.signal)
        else await runDownload(next, ac.signal)
        next.status = 'done'
      } catch (err) {
        next.status = ac.signal.aborted ? 'cancelled' : 'error'
        if (next.status === 'error') next.error = errMsg(err)
      } finally {
        next.finishedAt = Date.now()
        aborts.delete(next.id)
        sendTransfers(true)
        pump()
      }
    })()
    pump() // fill the second slot if there is more queued work
  }

  function queueUpload(path: string): string | null {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      return `Not found: ${path}`
    }
    if (!st.isFile()) return `Not a file: ${path}`
    const dupe = transfers.find(
      (t) => t.kind === 'upload' && t.localPath === path && (t.status === 'queued' || t.status === 'active')
    )
    if (dupe) return null // already on its way — not an error
    transfers.push({
      id: randomBytes(8).toString('hex'),
      kind: 'upload',
      name: basename(path),
      localPath: path,
      size: st.size,
      done: 0,
      status: 'queued',
      startedAt: 0,
      bps: 0
    })
    return null
  }

  function queueDownload(file: VaultFile, dest: string): Transfer {
    const t: Transfer = {
      id: randomBytes(8).toString('hex'),
      kind: 'download',
      name: file.name,
      localPath: dest,
      fileId: file.id,
      size: file.size,
      done: 0,
      status: 'queued',
      startedAt: 0,
      bps: 0
    }
    transfers.push(t)
    return t
  }

  /* -------------------------------- handlers ------------------------------- */

  const downloadDir = (): string => ctx.storeGet(`${ID}.downloadDir`, '') || ctx.app.getPath('downloads')

  const statusPayload = (): VaultStatus => {
    ensureAuthLoaded()
    return {
      clientConfigured: !!(clientId && clientSecret),
      connected: !!refreshToken,
      email,
      clientIdTail: clientId ? `…${clientId.slice(-14)}` : '',
      encAvailable: safeStorage.isEncryptionAvailable(),
      downloadDir: downloadDir()
    }
  }

  ctx.ipcMain.handle(`${ID}:status`, () => statusPayload())

  ctx.ipcMain.handle(`${ID}:save-client`, (_e, args: { clientId: string; clientSecret: string }) => {
    ensureAuthLoaded()
    const newId = String(args?.clientId ?? '').trim()
    const newSecret = String(args?.clientSecret ?? '').trim()
    if (!newId || !newSecret) return { error: 'Both the Client ID and the Client Secret are required.' }
    if (newId !== clientId) {
      // a different OAuth client invalidates existing tokens
      refreshToken = ''
      email = ''
      access = null
    }
    clientId = newId
    clientSecret = newSecret
    saveAuth()
    return { ok: true, status: statusPayload() }
  })

  ctx.ipcMain.handle(`${ID}:connect`, async () => {
    ensureAuthLoaded()
    if (!clientId || !clientSecret) return { error: 'Save your Google OAuth Client ID and Secret first.' }
    if (connecting) return { error: 'A sign-in tab is already waiting in your browser — finish it (or wait for it to time out).' }
    connecting = true
    try {
      const r = await oauthAuthorize(clientId, clientSecret, (url) => void ctx.shell.openExternal(url))
      refreshToken = r.refreshToken
      access = { token: r.accessToken, exp: Date.now() + r.expiresIn * 1000 }
      email = (await about(r.accessToken)).email
      saveAuth()
      return { ok: true, status: statusPayload() }
    } catch (err) {
      return { error: errMsg(err) }
    } finally {
      connecting = false
    }
  })

  ctx.ipcMain.handle(`${ID}:disconnect`, () => {
    ensureAuthLoaded()
    if (refreshToken) void revokeToken(refreshToken)
    refreshToken = ''
    email = ''
    access = null
    saveAuth()
    return { ok: true, status: statusPayload() }
  })

  ctx.ipcMain.handle(`${ID}:quota`, async (): Promise<QuotaInfo | { error: string }> => {
    try {
      const a = await about(await getToken())
      if (a.email && a.email !== email) {
        email = a.email
        saveAuth()
      }
      return a
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:list`, async () => {
    try {
      return { files: await listVault() }
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:pick-upload`, async () => {
    const win = ctx.getMainWindow()
    if (!win) return { error: 'No window' }
    const r = await ctx.dialog.showOpenDialog(win, {
      title: 'Upload to your Drive vault',
      properties: ['openFile', 'multiSelections']
    })
    if (r.canceled || r.filePaths.length === 0) return { canceled: true }
    const errors: string[] = []
    for (const p of r.filePaths) {
      const e = queueUpload(p)
      if (e) errors.push(e)
    }
    pump()
    return { ok: true, queued: r.filePaths.length - errors.length, errors }
  })

  ctx.ipcMain.handle(`${ID}:upload-paths`, (_e, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return { error: 'No files given.' }
    const errors: string[] = []
    let queued = 0
    for (const p of paths.map(String)) {
      const e = queueUpload(p)
      if (e) errors.push(e)
      else queued++
    }
    pump()
    if (queued === 0 && errors.length > 0) return { error: errors.join('; ') }
    return { ok: true, queued, errors }
  })

  ctx.ipcMain.handle(`${ID}:download`, async (_e, args: { fileId: string; name: string }) => {
    try {
      const file = await resolveFile(String(args?.fileId ?? ''))
      const win = ctx.getMainWindow()
      if (!win) return { error: 'No window' }
      const r = await ctx.dialog.showSaveDialog(win, {
        title: 'Save from your Drive vault',
        defaultPath: join(downloadDir(), file.name)
      })
      if (r.canceled || !r.filePath) return { canceled: true }
      queueDownload(file, r.filePath)
      pump()
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  // MCP path: no dialog. Refuses to overwrite unless told to.
  ctx.ipcMain.handle(
    `${ID}:download-to`,
    async (_e, args: { fileId?: string; name?: string; dir?: string; overwrite?: boolean }) => {
      try {
        const file = await resolveFile(args?.fileId ? String(args.fileId) : undefined, args?.name ? String(args.name) : undefined)
        const dir = String(args?.dir ?? '') || downloadDir()
        const dest = join(dir, file.name)
        if (existsSync(dest) && !args?.overwrite) return { error: `${dest} already exists — pass overwrite to replace it.` }
        const t = queueDownload(file, dest)
        pump()
        return { ok: true, transferId: t.id, dest }
      } catch (err) {
        return { error: errMsg(err) }
      }
    }
  )

  ctx.ipcMain.handle(`${ID}:transfers`, () => transfers)

  ctx.ipcMain.handle(`${ID}:cancel`, (_e, id: string) => {
    const t = transfers.find((x) => x.id === id)
    if (!t) return { error: 'Unknown transfer' }
    if (t.status === 'queued') {
      t.status = 'cancelled'
      t.finishedAt = Date.now()
    } else {
      aborts.get(id)?.abort()
    }
    sendTransfers(true)
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:clear-done`, () => {
    for (let i = transfers.length - 1; i >= 0; i--) {
      const s = transfers[i].status
      if (s === 'done' || s === 'error' || s === 'cancelled') transfers.splice(i, 1)
    }
    sendTransfers(true)
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:delete`, async (_e, args: { fileId?: string; name?: string }) => {
    try {
      const file = await resolveFile(args?.fileId ? String(args.fileId) : undefined, args?.name ? String(args.name) : undefined)
      await trashFile(await getToken(), file.id)
      return { ok: true, name: file.name }
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:rename`, async (_e, args: { fileId: string; name: string }) => {
    try {
      const name = String(args?.name ?? '').trim()
      if (!name) return { error: 'Name cannot be empty.' }
      await renameFile(await getToken(), String(args.fileId), name)
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:open-drive`, async (_e, fileId?: string) => {
    try {
      if (fileId) {
        void ctx.shell.openExternal(`https://drive.google.com/file/d/${encodeURIComponent(String(fileId))}/view`)
      } else {
        const fid = await ensureVault(await getToken())
        void ctx.shell.openExternal(`https://drive.google.com/drive/folders/${encodeURIComponent(fid)}`)
      }
      return { ok: true }
    } catch (err) {
      return { error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:reveal`, (_e, path: string) => {
    if (path && existsSync(String(path))) ctx.shell.showItemInFolder(String(path))
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:set-download-dir`, async () => {
    const win = ctx.getMainWindow()
    if (!win) return { error: 'No window' }
    const r = await ctx.dialog.showOpenDialog(win, {
      title: 'Default download folder',
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return { canceled: true }
    ctx.storeSet(`${ID}.downloadDir`, r.filePaths[0])
    return { ok: true, status: statusPayload() }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Google credentials (encrypted)',
      path: existsSync(authPath) ? authPath : null,
      note: 'OAuth client + tokens, encrypted with Windows DPAPI; never synced or backed up'
    },
    {
      label: 'Default download folder',
      path: downloadDir(),
      note: 'Files themselves live in the "WICKED Vault" folder of your Google Drive'
    }
  ])
}

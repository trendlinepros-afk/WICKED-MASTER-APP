import { app, dialog, ipcMain, session, type BrowserWindow } from 'electron'
import { resolve, sep } from 'path'
import { runBackupFlushes } from './backup-flush'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SHELL_IPC, type BackupInfo, type BackupResult, type ShellSettings } from '@shared/types'
import { getSettings, setSettings } from './settings'
import {
  BACKUP_EXT,
  BACKUP_PREFIX,
  PENDING_MARKER,
  PORTABLE_KEYS_NAME,
  RESTORED_KEYS_STAGE,
  STAGED_ZIP,
  collectEntries,
  readManifest,
  readZipTextEntry,
  writeBackupZip
} from './backup-core'
import {
  clearBackupPassword,
  encryptKeysToStoreShape,
  getAllDecryptedKeys,
  getBackupPassword,
  hasBackupPassword,
  setBackupPassword
} from './api-keys'
import { decryptWithPassword, encryptWithPassword } from './key-portability'

/**
 * Whole-app Backup & Restore (Settings → Backup & Restore) — the settings-aware
 * half. The pure/boot-time logic (collect/zip/extract + applyPendingRestore) is
 * in backup-core.ts, which paths.ts imports so a staged restore is applied
 * before any store loads.
 *
 * A backup is a single .zip of every piece of user data under userData:
 *   wicked-settings.json, wicked-modules.json (e.g. 365 email rules),
 *   wicked-keys.json, modules/** (AI Chat DB, screenshots, …), and the renderer
 *   IndexedDB + Local Storage (where the Project Board keeps its cards/images).
 * Chromium caches and the Full Chrome profile are excluded (see backup-core).
 *
 * Restore is STAGED then applied on next boot to avoid Windows locked-file
 * failures. API keys are encrypted per-PC (OS keychain), so a restored key file
 * won't decrypt on a different computer — those need re-entering there.
 */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function defaultDestination(): string {
  try {
    return join(app.getPath('documents'), 'WICKED-Backups')
  } catch {
    return join(app.getPath('userData'), 'backups')
  }
}

function destinationDir(): string {
  const d = getSettings().backup.destination
  return d && d.trim() ? d.trim() : defaultDestination()
}

/**
 * The folder backups actually use ON THIS DEVICE. The configured destination
 * lives in wicked-settings.json, which travels inside Cloud Sync snapshots —
 * so a laptop can inherit the main PC's "X:\…" folder on a drive that doesn't
 * exist here. When the configured folder can't be created, fall back to the
 * local default instead of failing — WITHOUT rewriting the setting (persisting
 * the fallback would sync back and clobber the main PC's choice).
 */
function effectiveDestination(): { dir: string; fellBack: boolean } {
  const configured = destinationDir()
  try {
    mkdirSync(configured, { recursive: true })
    return { dir: configured, fellBack: false }
  } catch {
    return { dir: defaultDestination(), fellBack: true }
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function isBackupFile(name: string): boolean {
  return name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_EXT)
}

/** Keep only the newest `keep` backups in `dir`. */
function pruneOld(dir: string): void {
  try {
    const keep = Math.max(1, getSettings().backup.keep || 10)
    const files = readdirSync(dir)
      .filter(isBackupFile)
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(keep)) rmSync(join(dir, f.name), { force: true })
  } catch {
    /* pruning is best-effort */
  }
}

/** True when `p` resolves inside the app's own data folder. */
function insideUserData(p: string): boolean {
  const userData = resolve(app.getPath('userData'))
  const target = resolve(p)
  return target === userData || target.startsWith(userData + sep)
}

/** Record the outcome of the latest backup attempt (surfaced in Settings). */
function recordOutcome(error: string): void {
  try {
    setSettings({ backup: { ...getSettings().backup, lastBackupError: error } })
  } catch {
    /* never let bookkeeping fail a backup */
  }
}

/** Create a backup zip in `destDir` (default = configured destination, with a
 *  local-default fallback when that folder doesn't exist on this device). */
export function createBackup(destDir?: string): BackupResult {
  const userData = app.getPath('userData')
  let dir: string
  let fellBack = false
  try {
    if (destDir && destDir.trim()) {
      dir = destDir.trim()
      mkdirSync(dir, { recursive: true })
    } else {
      const eff = effectiveDestination()
      dir = eff.dir
      fellBack = eff.fellBack
      mkdirSync(dir, { recursive: true })
    }
  } catch (err) {
    recordOutcome(`Could not create the backup folder: ${errMsg(err)}`)
    return { ok: false, error: `Could not create the backup folder: ${errMsg(err)}` }
  }
  const file = join(dir, `${BACKUP_PREFIX}${stamp(new Date())}${BACKUP_EXT}`)
  try {
    // Consistency first: checkpoint open databases (module-registered flushes)
    // and flush the renderer's LevelDB stores before reading anything.
    runBackupFlushes()
    try {
      session.defaultSession.flushStorageData()
    } catch {
      /* no session yet (early startup) — proceed */
    }
    const skipped: string[] = []
    const entries = collectEntries(userData, undefined, undefined, skipped).filter(
      (e) => e.rel !== PENDING_MARKER && e.rel !== STAGED_ZIP
    )
    // If a backup password is set, add a portable (password-encrypted) copy of
    // the API-key vault so keys can move to another computer.
    const extras: { rel: string; data: string }[] = []
    let keysIncluded = false
    const pw = getBackupPassword()
    if (pw) {
      const plain = getAllDecryptedKeys()
      if (Object.keys(plain).length > 0) {
        extras.push({ rel: PORTABLE_KEYS_NAME, data: encryptWithPassword(JSON.stringify(plain), pw) })
        keysIncluded = true
      }
    }
    const count = writeBackupZip(entries, file, app.getVersion(), extras, skipped)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      /* ignore */
    }
    setSettings({
      backup: { ...getSettings().backup, lastBackupUtc: new Date().toISOString(), lastBackupError: '' }
    })
    pruneOld(dir)
    return {
      ok: true,
      file,
      size,
      fileCount: count,
      keysIncluded,
      skipped: skipped.slice(0, 50),
      ...(fellBack
        ? { note: `The configured backup folder isn't available on this device — saved to ${dir} instead (the setting was left unchanged).` }
        : {})
    }
  } catch (err) {
    try {
      rmSync(file, { force: true })
      rmSync(file + '.tmp', { force: true })
    } catch {
      /* ignore */
    }
    recordOutcome(`Backup failed: ${errMsg(err)}`)
    return { ok: false, error: `Backup failed: ${errMsg(err)}` }
  }
}

export function listBackups(destDir?: string): BackupInfo[] {
  const dir = destDir && destDir.trim() ? destDir.trim() : destinationDir()
  try {
    return readdirSync(dir)
      .filter(isBackupFile)
      .map((name) => {
        const st = statSync(join(dir, name))
        return {
          file: join(dir, name),
          name,
          size: st.size,
          modifiedUtc: new Date(st.mtimeMs).toISOString()
        }
      })
      .sort((a, b) => (a.modifiedUtc < b.modifiedUtc ? 1 : -1))
  } catch {
    return []
  }
}

/** Stage a restore and return; the caller relaunches so it applies on boot. */
export function stageRestore(file: string, password?: string): BackupResult {
  const userData = app.getPath('userData')
  if (!file || !existsSync(file)) return { ok: false, error: 'That backup file no longer exists.' }
  const manifest = readManifest(file)
  if (!manifest)
    return { ok: false, error: 'That file is not a WICKED backup (no valid backup manifest inside).' }

  // If the backup carries portable API keys, we need the password to unlock them
  // and re-encrypt for THIS machine (staged, applied after extraction on boot).
  const portable = readZipTextEntry(file, PORTABLE_KEYS_NAME)
  if (portable) {
    if (!password) return { ok: false, needPassword: true, file }
    const plainJson = decryptWithPassword(portable, password)
    if (plainJson === null) {
      return { ok: false, error: 'Wrong backup password — the API keys in this backup could not be unlocked.' }
    }
    try {
      const plain = JSON.parse(plainJson) as Record<string, string>
      const reencrypted = encryptKeysToStoreShape(plain)
      writeFileSync(join(userData, RESTORED_KEYS_STAGE), JSON.stringify(reencrypted), 'utf8')
    } catch (err) {
      return { ok: false, error: `Could not import the API keys: ${errMsg(err)}` }
    }
  }

  // The restore dialogs promise "a timestamped backup of your current data is
  // written first" — make that promise TRUE before anything is staged. If the
  // safety backup can't be written, the restore does not proceed.
  const safety = createBackup()
  if (!safety.ok) {
    return {
      ok: false,
      error:
        `Could not write the pre-restore safety backup (${safety.error ?? 'unknown error'}) — ` +
        'restore cancelled so your current data stays untouched. Fix the backup destination and retry.'
    }
  }

  try {
    writeFileSync(join(userData, STAGED_ZIP), readFileSync(file))
    writeFileSync(
      join(userData, PENDING_MARKER),
      JSON.stringify({ source: file, stagedUtc: new Date().toISOString() }, null, 2),
      'utf8'
    )
    return { ok: true, file, fileCount: manifest.fileCount, staged: true }
  } catch (err) {
    return { ok: false, error: `Could not prepare the restore: ${errMsg(err)}` }
  }
}

/* ------------------------------ scheduling ------------------------------- */

let timer: NodeJS.Timeout | null = null
let kick: NodeJS.Timeout | null = null

/** (Re)configure the scheduled-backup timer from settings. Idempotent. */
export function scheduleBackups(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (kick) {
    clearTimeout(kick)
    kick = null
  }
  const { schedule } = getSettings().backup
  if (!schedule.enabled) return
  const intervalMs = Math.max(1, schedule.intervalHours) * 3_600_000
  const check = (): void => {
    const b = getSettings().backup
    if (!b.schedule.enabled) return
    const last = b.lastBackupUtc ? Date.parse(b.lastBackupUtc) : 0
    if (Number.isNaN(last) || Date.now() - last >= intervalMs) {
      const res = createBackup()
      // failures also land in backup.lastBackupError (recordOutcome) → Settings UI
      if (!res.ok) console.error('[wicked] scheduled backup failed:', res.error)
      else console.log(`[wicked] scheduled backup written: ${res.file}`)
    }
  }
  kick = setTimeout(check, 60_000) // shortly after launch (covers "was off overnight")
  timer = setInterval(check, Math.min(intervalMs, 6 * 3_600_000))
}

/* --------------------------------- ipc ----------------------------------- */

export function registerBackupIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(SHELL_IPC.backupConfig, () => {
    const eff = effectiveDestination()
    return {
      destination: destinationDir(),
      isDefaultDestination: !getSettings().backup.destination,
      // the configured folder doesn't exist on THIS device (e.g. a synced
      // setting pointing at the main PC's X: drive) — backups fall back
      destinationUnavailable: eff.fellBack,
      effectiveDestination: eff.dir,
      backups: listBackups(eff.dir)
    }
  })

  ipcMain.handle(SHELL_IPC.backupNow, () => createBackup())

  ipcMain.handle(SHELL_IPC.backupPasswordStatus, () => ({ hasPassword: hasBackupPassword() }))
  ipcMain.handle(SHELL_IPC.backupPasswordSet, (_e, pw: unknown) =>
    setBackupPassword(typeof pw === 'string' ? pw : '')
  )
  ipcMain.handle(SHELL_IPC.backupPasswordClear, () => {
    clearBackupPassword()
    return { ok: true }
  })

  ipcMain.handle(SHELL_IPC.backupPickDestination, async () => {
    const win = getWin()
    const opts = {
      title: 'Choose where WICKED backups are saved',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: destinationDir()
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    // a destination inside userData would make every backup contain all
    // previous backups (and balloon the sync snapshot) — refuse it
    if (insideUserData(res.filePaths[0])) {
      return {
        ok: false,
        error: 'That folder is inside WICKED’s own data folder — backups there would back up themselves. Pick a folder outside the app data (e.g. Documents or another drive).'
      }
    }
    const next: ShellSettings['backup'] = { ...getSettings().backup, destination: res.filePaths[0] }
    setSettings({ backup: next })
    return { ok: true, destination: res.filePaths[0], backups: listBackups() }
  })

  ipcMain.handle(SHELL_IPC.backupRestore, async (_e, rawFile: unknown, rawPassword: unknown) => {
    const win = getWin()
    const password = typeof rawPassword === 'string' && rawPassword ? rawPassword : undefined
    let file = typeof rawFile === 'string' ? rawFile : ''
    if (!file) {
      const opts = {
        title: 'Choose a WICKED backup to restore',
        properties: ['openFile' as const],
        defaultPath: destinationDir(),
        filters: [{ name: 'WICKED backup', extensions: ['zip'] }]
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
      file = res.filePaths[0]
    }
    const manifest = readManifest(file)
    if (!manifest)
      return { ok: false, error: 'That file is not a WICKED backup (no valid backup manifest inside).' }

    // Backup carries portable keys but no password supplied yet → ask the renderer
    // to prompt, then it re-invokes with (file, password).
    const hasPortableKeys = !!readZipTextEntry(file, PORTABLE_KEYS_NAME)
    if (hasPortableKeys && !password) return { ok: false, needPassword: true, file }

    const confirmOpts = {
      type: 'warning' as const,
      buttons: ['Restore & Restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restore from backup',
      message: 'Replace this PC’s WICKED data with the backup and restart?',
      detail:
        `Backup: ${file}\n` +
        `Taken: ${manifest.createdUtc} (app v${manifest.appVersion}, ${manifest.fileCount} files)\n\n` +
        'Your settings and module data (email rules, AI Chat, Project Board, Trade Journal, …) will be ' +
        'replaced with the backup’s. WICKED restarts to apply it.' +
        (hasPortableKeys
          ? ' Your API keys will be imported and unlocked with the backup password.'
          : ' API keys are stored per-PC — set a backup password before backing up to carry them across computers.')
    }
    const confirm = win
      ? await dialog.showMessageBox(win, confirmOpts)
      : await dialog.showMessageBox(confirmOpts)
    if (confirm.response !== 0) return { ok: false, canceled: true }

    const staged = stageRestore(file, password)
    if (!staged.ok) return staged // includes needPassword / wrong-password
    app.relaunch()
    app.exit(0)
    return staged
  })
}

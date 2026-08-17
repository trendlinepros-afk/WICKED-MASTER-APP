import { app, dialog, ipcMain, safeStorage, session, type BrowserWindow } from 'electron'
import { runBackupFlushes } from './backup-flush'
import Store from 'electron-store'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import {
  SHELL_IPC,
  type SyncConfig,
  type SyncRemoteInfo,
  type SyncResult,
  type SyncSnapshot,
  type SyncSnapshotList,
  type SyncStatus
} from '@shared/types'
import { getAllDecryptedKeys } from './api-keys'
import { collectEntries, buildBackupZipBuffer, PENDING_MARKER, PORTABLE_KEYS_NAME, STAGED_ZIP } from './backup-core'
import { stageRestore } from './backup'
import { decryptBytesWithPassword, encryptBytesWithPassword, encryptWithPassword } from './key-portability'
import { getRepoInfo, listSnapshots as ghListSnapshots, probeWrite, pullManifest, pullRemote, pullSnapshotAt, pushSnapshot } from './sync-github'

/**
 * Cloud Sync (Settings → Cloud Sync): keep every device's config in a PRIVATE
 * GitHub repo. A snapshot is the same whole-app zip the Backup feature builds,
 * ENCRYPTED with the user's passphrase before it ever leaves the machine, so a
 * leaked token / repo only ever exposes ciphertext. The passphrase is cached in
 * safeStorage (per-PC) so scheduled pushes need no prompt; it is never uploaded.
 *
 * Model: auto-PUSH from the main PC on a timer (+ on close), manual PULL on other
 * devices (download → decrypt → stage → relaunch). Last-writer-wins on the whole
 * snapshot, with a version + device stamp so a pull can WARN before overwriting.
 *
 * Config, per-device state, credentials and the app-lock all live in stores that
 * are NOT in the backup include-list, so none of them travel inside a snapshot.
 */

const MANIFEST_MAGIC = 'wicked-sync'
const DOWNLOAD_TMP = '.wicked-sync-download.zip'

interface DeviceState {
  lastPushUtc: string
  lastPullUtc: string
  lastSyncedVersion: number
  /** last push failure ('' = ok) + when it happened — survives restarts so the
   *  UI can warn that the offsite copy is stale (in-memory lastError dies with
   *  the process, which is exactly when a failed close-push matters) */
  lastPushError?: string
  lastPushErrorUtc?: string
}

const DEFAULT_CONFIG: SyncConfig = {
  repo: '',
  branch: 'main',
  autoPush: false,
  intervalMinutes: 30,
  pushOnClose: false,
  deviceName: ''
}

const configStore = new Store<{ config: SyncConfig; state: DeviceState; deviceId: string }>({
  name: 'wicked-sync',
  defaults: {
    config: DEFAULT_CONFIG,
    state: { lastPushUtc: '', lastPullUtc: '', lastSyncedVersion: 0 },
    deviceId: ''
  }
})

/** token + passphrase — safeStorage-encrypted, device-local, never synced/returned. */
const secretStore = new Store<{ token?: string; passphrase?: string }>({ name: 'wicked-sync-secrets', defaults: {} })

/** app-lock PIN — stored only as a scrypt salt+hash, device-local, never synced. */
const lockStore = new Store<{ salt?: string; hash?: string }>({ name: 'wicked-lock', defaults: {} })

let busy = false
let lastRemote: SyncRemoteInfo | null = null
let lastError = ''
let timer: NodeJS.Timeout | null = null
let kick: NodeJS.Timeout | null = null

/* ------------------------------ pure helpers ----------------------------- */

/** Next version to write, so the number is monotonic across devices. */
export function nextVersion(remoteVersion: number | null, lastSynced: number): number {
  return Math.max(remoteVersion ?? 0, lastSynced) + 1
}

/** How the remote compares to what THIS device last synced. */
export function compareRemote(remoteVersion: number | null, lastSynced: number): SyncResult['compare'] {
  if (remoteVersion == null) return 'no-remote'
  if (remoteVersion > lastSynced) return 'remote-newer'
  if (remoteVersion < lastSynced) return 'local-ahead'
  return 'up-to-date'
}

/** Parse + validate our plaintext manifest; null if it isn't ours. */
export function parseRemoteManifest(text: string): SyncRemoteInfo | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown> & { magic?: string }
    if (j.magic !== MANIFEST_MAGIC) return null
    const trigger = j.trigger === 'auto' || j.trigger === 'manual' ? j.trigger : undefined
    return {
      version: Number(j.version) || 0,
      updatedUtc: String(j.updatedUtc ?? ''),
      device: String(j.device ?? ''),
      appVersion: String(j.appVersion ?? ''),
      sizeBytes: Number(j.sizeBytes) || 0,
      ...(trigger ? { trigger } : {})
    }
  } catch {
    return null
  }
}

function buildManifestText(info: SyncRemoteInfo): string {
  return JSON.stringify({ magic: MANIFEST_MAGIC, ...info }, null, 2)
}

/* ------------------------------ config/state ----------------------------- */

function deviceId(): string {
  let id = configStore.get('deviceId')
  if (!id) {
    id = randomBytes(8).toString('hex')
    configStore.set('deviceId', id)
  }
  return id
}

export function getConfig(): SyncConfig {
  const c = { ...DEFAULT_CONFIG, ...configStore.get('config') }
  if (!c.deviceName) c.deviceName = safeHostname()
  return c
}

function safeHostname(): string {
  try {
    return hostname() || 'This PC'
  } catch {
    return 'This PC'
  }
}

function getState(): DeviceState {
  const s = configStore.get('state')
  return {
    lastPushUtc: s?.lastPushUtc ?? '',
    lastPullUtc: s?.lastPullUtc ?? '',
    lastSyncedVersion: s?.lastSyncedVersion ?? 0,
    // must round-trip: dropping these here would (a) erase a persisted push
    // failure on the next setState and (b) hide it from buildStatus after a
    // restart — exactly the moment the "offsite copy is stale" warning matters
    lastPushError: s?.lastPushError ?? '',
    lastPushErrorUtc: s?.lastPushErrorUtc ?? ''
  }
}

function setState(patch: Partial<DeviceState>): void {
  configStore.set('state', { ...getState(), ...patch })
}

function getToken(): string | null {
  return decryptSecret(secretStore.get('token'))
}
function getPassphrase(): string | null {
  return decryptSecret(secretStore.get('passphrase'))
}
function decryptSecret(b64?: string): string | null {
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

export function buildStatus(): SyncStatus {
  const c = getConfig()
  const s = getState()
  const hasToken = !!secretStore.get('token')
  const hasPassphrase = !!secretStore.get('passphrase')
  return {
    ...c,
    configured: !!c.repo && hasToken && hasPassphrase,
    hasToken,
    hasPassphrase,
    deviceId: deviceId(),
    lastPushUtc: s.lastPushUtc,
    lastPullUtc: s.lastPullUtc,
    lastSyncedVersion: s.lastSyncedVersion,
    remote: lastRemote,
    busy,
    error: lastError || (s.lastPushError ? `Last push failed (${s.lastPushErrorUtc ?? ''}): ${s.lastPushError}` : '')
  }
}

/* --------------------------------- push ---------------------------------- */

/**
 * A sync snapshot holds settings + module data, so it should be a few MB. The
 * zip is base64'd into the encrypted-blob JSON (×4/3) and the GitHub blob API
 * base64s the whole payload AGAIN (×4/3 ≈ ×1.78 total), against GitHub's
 * ~100 MB blob ceiling — so the zip itself must stay ≤ ~52 MB. Also far below
 * Node's max string length, which an unbounded snapshot once hit ("Cannot
 * create a string longer than 0x1fffffe8 characters").
 */
const MAX_SNAPSHOT_BYTES = 52 * 1024 * 1024

/** Build the encrypted snapshot bytes (zip → passphrase-encrypted blob text). */
function buildEncryptedSnapshot(passphrase: string): string {
  const userData = app.getPath('userData')
  // consistency first: checkpoint module databases + flush renderer LevelDB
  runBackupFlushes()
  try {
    session.defaultSession.flushStorageData()
  } catch {
    /* no session yet — proceed */
  }
  const entries = collectEntries(userData).filter((e) => e.rel !== PENDING_MARKER && e.rel !== STAGED_ZIP)
  // API keys are per-PC (safeStorage) so include a portable copy encrypted with
  // the SAME passphrase; on pull it's re-encrypted for the destination machine.
  const extras: { rel: string; data: string }[] = []
  const plainKeys = getAllDecryptedKeys()
  if (Object.keys(plainKeys).length > 0)
    extras.push({ rel: PORTABLE_KEYS_NAME, data: encryptWithPassword(JSON.stringify(plainKeys), passphrase) })
  const zip = buildBackupZipBuffer(entries, app.getVersion(), extras)
  if (zip.length > MAX_SNAPSHOT_BYTES) {
    const biggest = entries
      .map((e) => {
        try {
          return { rel: e.rel, size: statSync(e.abs).size }
        } catch {
          return { rel: e.rel, size: 0 }
        }
      })
      .sort((a, b) => b.size - a.size)
      .slice(0, 3)
      .map((e) => `${e.rel} (${Math.round(e.size / 1048576)} MB)`)
      .join(', ')
    throw new Error(
      `Sync snapshot is ${Math.round(zip.length / 1048576)} MB — too large to push (limit ${Math.round(
        MAX_SNAPSHOT_BYTES / 1048576
      )} MB). Largest files: ${biggest}. Remove stray large files from the WICKED data folder and push again.`
    )
  }
  return encryptBytesWithPassword(zip, passphrase)
}

export async function pushNow(trigger: 'auto' | 'manual' = 'manual'): Promise<SyncResult> {
  if (busy) return { ok: false, error: 'A sync is already in progress.' }
  const c = getConfig()
  const token = getToken()
  const pass = getPassphrase()
  if (!c.repo || !token || !pass) return { ok: false, error: 'Cloud Sync isn’t set up yet — add a repo, token and passphrase.' }
  busy = true
  lastError = ''
  broadcast()
  try {
    const remoteMan = await pullManifest(token, c.repo, c.branch)
    if (!remoteMan.ok) return fail(remoteMan.error ?? 'Could not read the repo.')
    const remoteInfo = remoteMan.notFound || !remoteMan.manifestText ? null : parseRemoteManifest(remoteMan.manifestText)
    const version = nextVersion(remoteInfo?.version ?? null, getState().lastSyncedVersion)

    const blobText = buildEncryptedSnapshot(pass)
    const info: SyncRemoteInfo = {
      version,
      updatedUtc: new Date().toISOString(),
      device: c.deviceName,
      appVersion: app.getVersion(),
      sizeBytes: blobText.length,
      trigger
    }
    const res = await pushSnapshot(token, c.repo, c.branch, blobText, buildManifestText(info))
    if (!res.ok) return failPush(res.error ?? 'Push failed.')

    lastRemote = info
    setState({ lastPushUtc: info.updatedUtc, lastSyncedVersion: version, lastPushError: '', lastPushErrorUtc: '' })
    return { ok: true, remote: info, version }
  } catch (err) {
    return failPush(err instanceof Error ? err.message : String(err))
  } finally {
    busy = false
    broadcast()
  }
}

/** Push failures persist so the next launch can warn "offsite copy is stale". */
function failPush(msg: string): SyncResult {
  try {
    setState({ lastPushError: msg, lastPushErrorUtc: new Date().toISOString() })
  } catch {
    /* bookkeeping must not mask the real error */
  }
  return fail(msg)
}

/* --------------------------- check + pull -------------------------------- */

export async function checkRemote(): Promise<SyncResult> {
  const c = getConfig()
  const token = getToken()
  if (!c.repo || !token) return { ok: false, error: 'Add a repo and token first.' }
  const man = await pullManifest(token, c.repo, c.branch)
  if (!man.ok) return { ok: false, error: man.error }
  if (man.notFound || !man.manifestText) {
    lastRemote = null
    broadcast()
    return { ok: true, compare: 'no-remote', remote: null }
  }
  const info = parseRemoteManifest(man.manifestText)
  lastRemote = info
  broadcast()
  return { ok: true, remote: info, compare: compareRemote(info?.version ?? null, getState().lastSyncedVersion) }
}

/**
 * Pull: download, decrypt, stage, relaunch. DESTRUCTIVE — replaces local data
 * (a timestamped backup is written first by the staged-restore path on boot).
 */
export async function pullNow(getWin: () => BrowserWindow | null): Promise<SyncResult> {
  if (busy) return { ok: false, error: 'A sync is already in progress.' }
  const c = getConfig()
  const token = getToken()
  const pass = getPassphrase()
  if (!c.repo || !token || !pass) return { ok: false, error: 'Cloud Sync isn’t set up yet — add a repo, token and passphrase.' }
  busy = true
  lastError = ''
  broadcast()
  try {
    const pulled = await pullRemote(token, c.repo, c.branch)
    if (!pulled.ok) return fail(pulled.error ?? 'Pull failed.')
    if (pulled.notFound || !pulled.blobText || !pulled.manifestText) return fail('Nothing has been pushed to this repo yet.')
    const info = parseRemoteManifest(pulled.manifestText)
    if (!info) return fail('The repo has a sync blob but its manifest is unreadable.')

    const zip = decryptBytesWithPassword(pulled.blobText, pass)
    if (!zip) return fail('Wrong passphrase — the synced snapshot could not be decrypted on this device.')

    const state = getState()
    const compare = compareRemote(info.version, state.lastSyncedVersion)
    const win = getWin()
    const detail =
      `From: ${info.device || 'another device'} · ${info.updatedUtc} (v${info.version}, app v${info.appVersion})\n` +
      `This device last synced: v${state.lastSyncedVersion}${state.lastPushUtc || state.lastPullUtc ? ` (${state.lastPullUtc || state.lastPushUtc})` : ''}\n\n` +
      (compare === 'local-ahead'
        ? '⚠ This device is AHEAD of the cloud — pulling will REPLACE your newer local data with the older cloud copy.\n\n'
        : '') +
      'Your current settings, module data (Trade Journal, Project Board, …) and API keys will be replaced with the cloud copy, and WICKED will restart. A timestamped backup of your current data is written first.'
    const confirmOpts = {
      type: 'warning' as const,
      buttons: ['Pull & Restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Pull from cloud',
      message: 'Replace this PC’s WICKED data with the cloud copy and restart?',
      detail
    }
    const confirm = win ? await dialog.showMessageBox(win, confirmOpts) : await dialog.showMessageBox(confirmOpts)
    if (confirm.response !== 0) {
      busy = false
      broadcast()
      return { ok: false, error: 'Canceled.' }
    }

    const userData = app.getPath('userData')
    const tmp = join(userData, DOWNLOAD_TMP)
    writeFileSync(tmp, zip)
    const staged = stageRestore(tmp, pass)
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    if (!staged.ok) return fail(staged.error ?? 'Could not stage the pulled snapshot.')

    setState({ lastPullUtc: new Date().toISOString(), lastSyncedVersion: info.version })
    lastRemote = info
    app.relaunch()
    app.exit(0)
    return { ok: true, staged: true, remote: info, version: info.version }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/* --------------------------- snapshot history ---------------------------- */

/** List restorable snapshots from the repo's commit history (newest first). */
export async function listSnapshotsNow(): Promise<SyncSnapshotList> {
  const c = getConfig()
  const token = getToken()
  if (!c.repo || !token) return { ok: false, error: 'Add a repo and token first.' }
  const res = await ghListSnapshots(token, c.repo, c.branch, 40)
  if (!res.ok) return { ok: false, error: res.error }
  const mine = getState().lastSyncedVersion
  const snapshots: SyncSnapshot[] = (res.items ?? []).map((it) => {
    const info = it.manifestText ? parseRemoteManifest(it.manifestText) : null
    return {
      commitSha: it.commitSha,
      commitDate: it.commitDate,
      version: info?.version ?? 0,
      updatedUtc: info?.updatedUtc || it.commitDate,
      device: info?.device ?? '',
      appVersion: info?.appVersion ?? '',
      sizeBytes: info?.sizeBytes ?? 0,
      trigger: info?.trigger ?? 'unknown',
      isCurrent: !!info && mine > 0 && info.version === mine
    }
  })
  return { ok: true, snapshots }
}

/**
 * Restore a chosen past snapshot: fetch it at its commit, decrypt, stage,
 * relaunch. DESTRUCTIVE — replaces local data (a timestamped backup is written
 * first by the staged-restore path on boot). Confirmed via a native dialog.
 */
export async function restoreSnapshot(getWin: () => BrowserWindow | null, commitSha: string): Promise<SyncResult> {
  if (busy) return { ok: false, error: 'A sync is already in progress.' }
  const c = getConfig()
  const token = getToken()
  const pass = getPassphrase()
  if (!c.repo || !token || !pass) return { ok: false, error: 'Cloud Sync isn’t set up yet — add a repo, token and passphrase.' }
  if (!commitSha || typeof commitSha !== 'string') return { ok: false, error: 'No snapshot selected.' }
  busy = true
  lastError = ''
  broadcast()
  try {
    const pulled = await pullSnapshotAt(token, c.repo, commitSha)
    if (!pulled.ok) return fail(pulled.error ?? 'Could not fetch that snapshot.')
    if (pulled.notFound || !pulled.blobText || !pulled.manifestText) return fail('That snapshot is missing its data in the repo.')
    const info = parseRemoteManifest(pulled.manifestText)
    if (!info) return fail('That snapshot’s manifest is unreadable.')

    const zip = decryptBytesWithPassword(pulled.blobText, pass)
    if (!zip) return fail('Wrong passphrase — that snapshot could not be decrypted on this device.')

    const kind = info.trigger === 'auto' ? 'automatic' : info.trigger === 'manual' ? 'manual' : 'snapshot'
    const win = getWin()
    const detail =
      `Snapshot: v${info.version} · ${info.device || 'another device'} · ${info.updatedUtc} · ${kind} (app v${info.appVersion})\n\n` +
      'Your current settings, module data (Trade Journal, Project Board, …) and API keys on THIS PC will be replaced with this snapshot, and WICKED will restart. A timestamped backup of your current data is written first.'
    const confirmOpts = {
      type: 'warning' as const,
      buttons: ['Restore & Restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Restore snapshot',
      message: `Restore snapshot v${info.version} from ${info.device || 'another device'}?`,
      detail
    }
    const confirm = win ? await dialog.showMessageBox(win, confirmOpts) : await dialog.showMessageBox(confirmOpts)
    if (confirm.response !== 0) {
      busy = false
      broadcast()
      return { ok: false, error: 'Canceled.' }
    }

    const userData = app.getPath('userData')
    const tmp = join(userData, DOWNLOAD_TMP)
    writeFileSync(tmp, zip)
    const staged = stageRestore(tmp, pass)
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    if (!staged.ok) return fail(staged.error ?? 'Could not stage the snapshot.')

    setState({ lastPullUtc: new Date().toISOString(), lastSyncedVersion: info.version })
    lastRemote = info
    app.relaunch()
    app.exit(0)
    return { ok: true, staged: true, remote: info, version: info.version }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

function fail(msg: string): SyncResult {
  lastError = msg
  busy = false
  broadcast()
  return { ok: false, error: msg }
}

/* ------------------------------- scheduler ------------------------------- */

export function scheduleSync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (kick) {
    clearTimeout(kick)
    kick = null
  }
  const c = getConfig()
  if (!c.autoPush) return
  const intervalMs = Math.max(5, c.intervalMinutes) * 60_000
  const tick = (): void => {
    const cfg = getConfig()
    if (!cfg.autoPush) return
    if (!buildStatus().configured) return
    void pushNow('auto').then((r) => {
      if (!r.ok) console.error('[wicked] scheduled sync push failed:', r.error)
      else console.log(`[wicked] scheduled sync push: v${r.version}`)
    })
  }
  kick = setTimeout(tick, 90_000) // shortly after launch
  timer = setInterval(tick, intervalMs)
}

/** True if a final push should run as the app closes (before-quit hook). */
export function shouldPushOnClose(): boolean {
  return getConfig().pushOnClose && buildStatus().configured
}

/* ------------------------------- app lock -------------------------------- */

export function appLockEnabled(): boolean {
  return !!lockStore.get('hash') && !!lockStore.get('salt')
}

function hashPin(pin: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(pin, 'utf8'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

export function setAppLock(pin: string): { ok: boolean; error?: string } {
  const p = pin.trim()
  if (p.length < 4) return { ok: false, error: 'Use at least 4 characters.' }
  const salt = randomBytes(16)
  lockStore.set('salt', salt.toString('base64'))
  lockStore.set('hash', hashPin(p, salt).toString('base64'))
  return { ok: true }
}

export function verifyAppLock(pin: string): boolean {
  const saltB64 = lockStore.get('salt')
  const hashB64 = lockStore.get('hash')
  if (!saltB64 || !hashB64) return true // not set → nothing to unlock
  try {
    const expected = Buffer.from(hashB64, 'base64')
    const actual = hashPin(String(pin), Buffer.from(saltB64, 'base64'))
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function clearAppLock(pin: string): { ok: boolean; error?: string } {
  if (!verifyAppLock(pin)) return { ok: false, error: 'Wrong PIN.' }
  lockStore.delete('salt')
  lockStore.delete('hash')
  return { ok: true }
}

/* --------------------------------- ipc ----------------------------------- */

let winGetter: () => BrowserWindow | null = () => null

function broadcast(): void {
  const win = winGetter()
  if (win && !win.isDestroyed()) win.webContents.send(SHELL_IPC.syncEvent, buildStatus())
}

export function registerSyncIpc(getWin: () => BrowserWindow | null): void {
  winGetter = getWin

  ipcMain.handle(SHELL_IPC.syncStatus, () => buildStatus())

  ipcMain.handle(SHELL_IPC.syncSetConfig, (_e, patch: Partial<SyncConfig>) => {
    const cur = getConfig()
    const next: SyncConfig = {
      ...cur,
      ...(typeof patch?.repo === 'string' ? { repo: patch.repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '') } : {}),
      ...(typeof patch?.branch === 'string' ? { branch: patch.branch.trim() || 'main' } : {}),
      ...(typeof patch?.autoPush === 'boolean' ? { autoPush: patch.autoPush } : {}),
      ...(typeof patch?.intervalMinutes === 'number' ? { intervalMinutes: Math.max(5, Math.round(patch.intervalMinutes)) } : {}),
      ...(typeof patch?.pushOnClose === 'boolean' ? { pushOnClose: patch.pushOnClose } : {}),
      ...(typeof patch?.deviceName === 'string' ? { deviceName: patch.deviceName.trim().slice(0, 60) } : {})
    }
    configStore.set('config', next)
    scheduleSync()
    return buildStatus()
  })

  ipcMain.handle(SHELL_IPC.syncSetSecrets, (_e, raw: unknown) => {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'OS encryption unavailable — refusing to store secrets.' }
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as { token?: unknown; passphrase?: unknown }
    if (typeof o.token === 'string' && o.token.trim())
      secretStore.set('token', safeStorage.encryptString(o.token.trim()).toString('base64'))
    if (typeof o.passphrase === 'string' && o.passphrase.trim())
      secretStore.set('passphrase', safeStorage.encryptString(o.passphrase.trim()).toString('base64'))
    broadcast()
    return { ok: true }
  })

  ipcMain.handle(SHELL_IPC.syncClearSecrets, () => {
    secretStore.delete('token')
    secretStore.delete('passphrase')
    broadcast()
    return { ok: true }
  })

  ipcMain.handle(SHELL_IPC.syncTestRepo, async () => {
    const c = getConfig()
    const token = getToken()
    if (!c.repo || !token) return { ok: false, error: 'Add a repo and token first.' }
    // Last 4 chars + length so the user can verify WHICH token this device
    // actually holds (compare against the value they pasted) — reads working
    // while pushes 403 almost always means "wrong/stale token saved here".
    const tokenHint = `…${token.slice(-4)} · ${token.length} chars`
    const info = await getRepoInfo(token, c.repo)
    if (!info.ok) return { ok: false, error: info.error, canRead: false, tokenHint }
    const w = await probeWrite(token, c.repo)
    return {
      ok: true,
      defaultBranch: info.defaultBranch,
      private: info.private,
      canRead: true,
      canWrite: w.ok,
      writeInconclusive: w.inconclusive === true,
      writeError: w.error,
      tokenHint
    }
  })

  ipcMain.handle(SHELL_IPC.syncPushNow, () => pushNow('manual'))
  ipcMain.handle(SHELL_IPC.syncCheckRemote, () => checkRemote())
  ipcMain.handle(SHELL_IPC.syncPullNow, () => pullNow(getWin))
  ipcMain.handle(SHELL_IPC.syncListSnapshots, () => listSnapshotsNow())
  ipcMain.handle(SHELL_IPC.syncRestoreSnapshot, (_e, sha: unknown) => restoreSnapshot(getWin, typeof sha === 'string' ? sha : ''))

  ipcMain.handle(SHELL_IPC.appLockStatus, () => ({ enabled: appLockEnabled() }))
  ipcMain.handle(SHELL_IPC.appLockSet, (_e, pin: unknown) => setAppLock(typeof pin === 'string' ? pin : ''))
  ipcMain.handle(SHELL_IPC.appLockVerify, (_e, pin: unknown) => ({ ok: verifyAppLock(typeof pin === 'string' ? pin : '') }))
  ipcMain.handle(SHELL_IPC.appLockClear, (_e, pin: unknown) => clearAppLock(typeof pin === 'string' ? pin : ''))
}

import { Notification, powerSaveBlocker, safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs'
import { access, mkdir, rm, statfs, writeFile } from 'fs/promises'
import { hostname } from 'os'
import { basename, dirname, isAbsolute, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type {
  BackupPlan,
  DriveStatus,
  GlobalSettings,
  HistoryEntry,
  JobKind,
  JobProgress,
  Manifest,
  PlanRunSummary,
  PlanView,
  QueueState,
  RestoreRequest,
  RunStatus,
  VersionInfo
} from './types'
import { computeNextRun, DEFAULT_SCHEDULE } from './lib/schedule'
import { DEFAULT_EXCLUSIONS } from './lib/paths'
import {
  BACKUP_DIRNAME,
  CancelledError,
  acquireLock,
  browse,
  cleanupLeftovers,
  deleteVersions,
  deletionSet,
  errText,
  fileHistory,
  listVersions,
  localSource,
  planRestore,
  planRoot,
  readManifest,
  retentionVictims,
  runBackup,
  runRestore,
  search,
  validateVersion,
  writeVersionInfo,
  type JobIO
} from './ipc/engine'
import {
  cloudListing,
  cloudManifest,
  cloudSource,
  cloudVersionInfos,
  ensurePlanFolder,
  realDriveClient,
  syncToCloud,
  trashCloudVersions,
  type CloudListing,
  type DriveClient
} from './ipc/cloud'
import { ensureShare } from './ipc/netshare'
import { getDriveProvider } from '../file-vault/ipc/shared'

/* ------------------------------------------------------------------------ *
 *  BACKUP — file & folder backup plans (full or incremental), scheduled,
 *  to a local folder or network share, with an optional offsite copy in
 *  Google Drive. Browse any version and restore single files or folders.
 *
 *  Plans/history live in this module's data folder. Share passwords are
 *  safeStorage(DPAPI)-encrypted in credentials.json, never sent to the
 *  renderer, and excluded from WICKED Backup/Cloud Sync (backup-core.ts).
 *  Jobs run one at a time in a queue here in main; the scheduler ticks every
 *  30 s while WICKED is open (the Backup screen offers "start with Windows").
 * ------------------------------------------------------------------------ */

const ID = 'backup'
const MACHINE = hostname()
const PLATFORM = process.platform
const HISTORY_MAX = 300

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const sanitizeFolder = (s: string): string =>
  s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 60) || 'Backup'

export default function register(ctx: ModuleIpcContext): void {
  const dataDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const plansPath = join(dataDir, 'plans.json')
  const historyPath = join(dataDir, 'history.json')
  const credsPath = join(dataDir, 'credentials.json')
  mkdirSync(dataDir, { recursive: true })

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  function readJson<T>(path: string, fallback: T): T {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
    } catch {
      return fallback
    }
  }
  function writeJson(path: string, value: unknown): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, path)
  }

  /* --------------------------------- plans -------------------------------- */

  let plans: BackupPlan[] = readJson<BackupPlan[]>(plansPath, [])
  let history: HistoryEntry[] = readJson<HistoryEntry[]>(historyPath, [])

  const savePlans = (): void => writeJson(plansPath, plans)
  const saveHistory = (): void => writeJson(historyPath, history.slice(0, HISTORY_MAX))
  const changed = (): void => send(`${ID}:changed`, null)

  const findPlan = (id: unknown): BackupPlan => {
    const p = plans.find((x) => x.id === id)
    if (!p) throw new Error('That backup plan no longer exists.')
    return p
  }

  function lastRunOf(planId: string): PlanRunSummary | null {
    const h = history.find((e) => e.planId === planId && e.kind === 'backup')
    return h ? { at: h.endedAt, status: h.status, versionId: h.versionId, message: h.message } : null
  }

  function viewOf(p: BackupPlan): PlanView {
    return {
      ...p,
      lastRun: lastRunOf(p.id),
      isLocalMachine: p.machine === MACHINE,
      busy: running?.planId === p.id || queue.some((j) => j.planId === p.id)
    }
  }

  const schedulable = (p: BackupPlan): boolean => p.enabled && p.machine === MACHINE && p.schedule.kind !== 'manual'

  function refreshNextRun(p: BackupPlan, from = Date.now()): void {
    p.nextRun = schedulable(p) ? computeNextRun(p.schedule, from) : null
  }

  /* ------------------------------ credentials ----------------------------- */

  interface CredsDisk {
    enc: boolean
    items: Record<string, string>
  }

  function getPassword(planId: string): string | null {
    const disk = readJson<CredsDisk>(credsPath, { enc: false, items: {} })
    const b64 = disk.items[planId]
    if (!b64) return null
    try {
      return disk.enc ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      return null // DPAPI blob from another PC/user
    }
  }

  function setPassword(planId: string, password: string | null): void {
    const disk = readJson<CredsDisk>(credsPath, { enc: safeStorage.isEncryptionAvailable(), items: {} })
    const enc = safeStorage.isEncryptionAvailable()
    // re-encode existing entries if the encryption mode changed
    const items: Record<string, string> = {}
    for (const [k, v] of Object.entries(disk.items)) {
      if (k === planId) continue
      if (disk.enc === enc) items[k] = v
    }
    if (password) items[planId] = enc ? safeStorage.encryptString(password).toString('base64') : Buffer.from(password, 'utf8').toString('base64')
    writeJson(credsPath, { enc, items })
  }

  /* ------------------------------ destination ----------------------------- */

  const reachFail = new Map<string, { at: number; msg: string }>()

  /** Connect (network share login if configured) and return the plan's root folder. */
  async function reach(p: BackupPlan, create: boolean): Promise<string> {
    const recent = reachFail.get(p.id)
    if (!create && recent && Date.now() - recent.at < 20_000) throw new Error(recent.msg)
    try {
      const dest = p.destination.path
      await ensureShare(dest, p.destination.username, p.destination.hasPassword ? getPassword(p.id) : null)
      const root = planRoot(dest, p.folder)
      if (create) {
        try {
          await mkdir(root, { recursive: true })
        } catch (err) {
          throw new Error(`The backup destination ${dest} is not available (${errText(err).toLowerCase()}). Is the drive connected?`)
        }
      } else {
        try {
          await access(dest)
        } catch {
          throw new Error(`The backup destination ${dest} is not available right now.`)
        }
      }
      reachFail.delete(p.id)
      return root
    } catch (err) {
      reachFail.set(p.id, { at: Date.now(), msg: errMsg(err) })
      throw err
    }
  }

  /* --------------------------------- drive -------------------------------- */

  function driveStatus(): DriveStatus {
    const prov = getDriveProvider()
    return prov ? prov.status() : { connected: false, email: '' }
  }

  function driveClient(): DriveClient | null {
    const prov = getDriveProvider()
    if (!prov || !prov.status().connected) return null
    return realDriveClient(prov.getToken)
  }

  const folderIds = new Map<string, string>()
  async function planFolderId(d: DriveClient, p: BackupPlan): Promise<string> {
    const hit = folderIds.get(p.id)
    if (hit) return hit
    const id = await ensurePlanFolder(d, p.folder)
    folderIds.set(p.id, id)
    return id
  }

  const listingCache = new Map<string, { at: number; listing: CloudListing }>()
  async function listingFor(d: DriveClient, p: BackupPlan, fresh = false): Promise<{ folderId: string; listing: CloudListing }> {
    const folderId = await planFolderId(d, p)
    const hit = listingCache.get(p.id)
    if (!fresh && hit && Date.now() - hit.at < 60_000) return { folderId, listing: hit.listing }
    try {
      const listing = await cloudListing(d, folderId)
      listingCache.set(p.id, { at: Date.now(), listing })
      return { folderId, listing }
    } catch (err) {
      folderIds.delete(p.id) // folder may have been deleted in Drive — re-resolve next time
      throw err
    }
  }

  const pendingTrash = (): Record<string, string[]> => ctx.storeGet<Record<string, string[]>>(`${ID}.pendingCloudTrash`, {})
  function queueCloudTrash(p: BackupPlan, vids: string[]): void {
    if (!vids.length || !p.cloud.enabled) return
    const all = pendingTrash()
    all[p.id] = [...new Set([...(all[p.id] ?? []), ...vids])]
    ctx.storeSet(`${ID}.pendingCloudTrash`, all)
  }
  async function flushCloudTrash(d: DriveClient, p: BackupPlan): Promise<void> {
    const all = pendingTrash()
    const vids = all[p.id]
    if (!vids?.length) return
    await trashCloudVersions(d, await planFolderId(d, p), vids)
    delete all[p.id]
    ctx.storeSet(`${ID}.pendingCloudTrash`, all)
    listingCache.delete(p.id)
  }

  /* ------------------------------- manifests ------------------------------ */

  const manifestCache = new Map<string, Manifest>()
  function cacheManifest(key: string, m: Manifest): void {
    manifestCache.delete(key)
    manifestCache.set(key, m)
    while (manifestCache.size > 4) manifestCache.delete(manifestCache.keys().next().value as string)
  }

  async function getManifest(p: BackupPlan, vid: string): Promise<Manifest> {
    const key = `${p.id}|${vid}`
    const hit = manifestCache.get(key)
    if (hit) return hit
    let localErr: unknown = null
    try {
      const m = await readManifest(await reach(p, false), vid)
      cacheManifest(key, m)
      return m
    } catch (err) {
      localErr = err
    }
    const d = p.cloud.enabled ? driveClient() : null
    if (d) {
      const { listing } = await listingFor(d, p)
      if (listing.complete.has(vid)) {
        const m = await cloudManifest(d, listing, vid)
        cacheManifest(key, m)
        return m
      }
    }
    throw localErr instanceof Error ? localErr : new Error('This version could not be read.')
  }

  async function versionsOf(p: BackupPlan): Promise<{ versions: VersionInfo[]; localError: string; cloudError: string }> {
    let local: VersionInfo[] = []
    let localError = ''
    let cloudError = ''
    try {
      local = await listVersions(await reach(p, false))
    } catch (err) {
      localError = errMsg(err)
    }
    let cloudOnly: VersionInfo[] = []
    if (p.cloud.enabled) {
      const d = driveClient()
      if (!d) cloudError = 'Google Drive is not connected — connect it in File Vault.'
      else {
        try {
          const { listing } = await listingFor(d, p)
          for (const v of local) v.cloud = listing.complete.has(v.id) ? 'complete' : listing.partial.has(v.id) ? 'partial' : 'none'
          cloudOnly = await cloudVersionInfos(d, listing, new Set(local.map((v) => v.id)))
        } catch (err) {
          cloudError = errMsg(err)
        }
      }
    }
    const versions = [...local, ...cloudOnly].sort((a, b) => b.createdAt - a.createdAt)
    return { versions, localError, cloudError }
  }

  /* ---------------------------------- jobs --------------------------------- */

  type Outcome = Partial<Omit<HistoryEntry, 'id' | 'kind' | 'planId' | 'planName' | 'trigger' | 'startedAt' | 'endedAt'>>

  interface Job {
    id: string
    kind: JobKind
    planId: string
    planName: string
    trigger: HistoryEntry['trigger']
    ac: AbortController
    exec: (job: Job, io: JobIO) => Promise<Outcome>
  }

  const queue: Job[] = []
  let running: Job | null = null
  let progress: JobProgress | null = null

  let qTimer: NodeJS.Timeout | null = null
  let lastQ = 0
  const queueState = (): QueueState => ({
    running: progress,
    queued: queue.map((j) => ({ jobId: j.id, kind: j.kind, planId: j.planId, planName: j.planName }))
  })
  function sendQueue(force = false): void {
    const emit = (): void => {
      lastQ = Date.now()
      send(`${ID}:queue`, queueState())
    }
    if (force || Date.now() - lastQ > 250) {
      if (qTimer) {
        clearTimeout(qTimer)
        qTimer = null
      }
      emit()
    } else if (!qTimer) {
      qTimer = setTimeout(() => {
        qTimer = null
        emit()
      }, 250)
    }
  }

  function enqueue(j: Omit<Job, 'id' | 'ac'>): string {
    const dup = [running, ...queue].find((x) => x && x.kind === j.kind && x.planId === j.planId && j.kind !== 'restore')
    if (dup) return dup.id
    const job: Job = { ...j, id: randomBytes(6).toString('hex'), ac: new AbortController() }
    queue.push(job)
    sendQueue(true)
    changed()
    void pump()
    return job.id
  }

  async function pump(): Promise<void> {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = job
    const startedAt = Date.now()
    progress = {
      jobId: job.id,
      kind: job.kind,
      planId: job.planId,
      planName: job.planName,
      phase: 'connecting',
      startedAt,
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      current: '',
      scanned: 0,
      message: 'Connecting to the backup location…',
      cloudBytesDone: 0,
      cloudBytesTotal: 0
    }
    sendQueue(true)
    const io: JobIO = {
      signal: job.ac.signal,
      onProgress: (patch) => {
        if (progress && running === job) {
          Object.assign(progress, patch)
          sendQueue(!!patch.phase)
        }
      }
    }
    const blocker = powerSaveBlocker.start('prevent-app-suspension')
    let entry: HistoryEntry
    const base = {
      id: job.id,
      kind: job.kind,
      planId: job.planId,
      planName: job.planName,
      trigger: job.trigger,
      startedAt,
      versionId: null,
      mode: null,
      files: 0,
      bytes: 0,
      filesDone: 0,
      bytesDone: 0,
      errors: [],
      errorCount: 0,
      cloud: null
    }
    try {
      const out = await job.exec(job, io)
      entry = { ...base, status: 'success', message: '', ...out, endedAt: Date.now() }
    } catch (err) {
      const cancelled = err instanceof CancelledError || job.ac.signal.aborted
      entry = {
        ...base,
        status: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Cancelled.' : errMsg(err),
        endedAt: Date.now()
      }
    } finally {
      powerSaveBlocker.stop(blocker)
    }
    history.unshift(entry)
    history = history.slice(0, HISTORY_MAX)
    saveHistory()
    running = null
    progress = null
    sendQueue(true)
    send(`${ID}:job-done`, entry)
    changed()
    notify(entry)
    void pump()
  }

  function notify(e: HistoryEntry): void {
    if (e.trigger === 'manual' || e.trigger === 'mcp') return
    if (e.status !== 'failed' && e.status !== 'warning') return
    try {
      if (!Notification.isSupported()) return
      new Notification({
        title: e.status === 'failed' ? `Backup failed — ${e.planName}` : `Backup finished with warnings — ${e.planName}`,
        body: e.message.slice(0, 200)
      }).show()
    } catch {
      /* notifications are best-effort */
    }
  }

  function cancelJob(jobId?: string): boolean {
    if (!jobId || running?.id === jobId) {
      if (running) {
        running.ac.abort()
        return true
      }
    }
    const i = queue.findIndex((j) => j.id === jobId)
    if (i >= 0) {
      queue.splice(i, 1)
      sendQueue(true)
      changed()
      return true
    }
    return false
  }

  /* ------------------------------ job bodies ------------------------------ */

  async function cloudStep(p: BackupPlan, root: string, io: JobIO): Promise<{ ok: boolean; message: string; uploaded: number }> {
    const d = driveClient()
    if (!d) return { ok: false, message: 'Google Drive copy skipped — Drive is not connected (open File Vault → Connect).', uploaded: 0 }
    try {
      await flushCloudTrash(d, p)
      const folderId = await planFolderId(d, p)
      const r = await syncToCloud({ drive: d, root, plan: p, folderId, versions: await listVersions(root), io })
      listingCache.delete(p.id)
      return { ok: true, message: '', uploaded: r.uploaded.length }
    } catch (err) {
      if (err instanceof CancelledError || io.signal.aborted) throw err
      folderIds.delete(p.id)
      return { ok: false, message: `Google Drive copy failed: ${errMsg(err)} (it will retry on the next run)`, uploaded: 0 }
    }
  }

  function backupJob(p: BackupPlan, forceFull: boolean) {
    return async (job: Job, io: JobIO): Promise<Outcome> => {
      const plan = findPlan(p.id)
      const root = await reach(plan, true)
      const release = await acquireLock(root, 'backup')
      let result
      const notes: string[] = []
      try {
        await writeFile(join(root, 'plan.json'), JSON.stringify({ ...plan, nextRun: null }, null, 2)).catch(() => undefined)
        result = await runBackup({ plan, root, forceFull, platform: PLATFORM, io })
        manifestCache.clear()
        // cleanup
        const victims = retentionVictims(plan, await listVersions(root))
        if (victims.length) {
          io.onProgress({ phase: 'cleanup', message: `Removing ${victims.length} old version${victims.length === 1 ? '' : 's'}…` })
          await deleteVersions(root, victims.map((v) => v.id))
          queueCloudTrash(plan, victims.map((v) => v.id))
          notes.push(`cleaned up ${victims.length} old version${victims.length === 1 ? '' : 's'}`)
        }
      } catch (err) {
        await cleanupLeftovers(root).catch(() => undefined)
        throw err
      } finally {
        await release().catch(() => undefined)
      }

      let cloud: HistoryEntry['cloud'] = null
      let cloudMsg = ''
      if (plan.cloud.enabled) {
        const c = await cloudStep(plan, root, io)
        cloud = c.ok ? 'success' : 'failed'
        cloudMsg = c.message
        if (c.ok) notes.push('copied to Google Drive')
      }

      const s = result.info.stats
      const warn: string[] = []
      if (result.errorCount) warn.push(`${result.errorCount} file${result.errorCount === 1 ? '' : 's'} could not be backed up`)
      if (result.verifyFailures) warn.push(`${result.verifyFailures} failed validation`)
      if (result.missingSources.length) warn.push(`not available: ${result.missingSources.join(', ')}`)
      if (cloudMsg) warn.push(cloudMsg)
      const kindLabel = result.info.kind === 'full' ? 'Full backup' : 'Incremental backup'
      const status: RunStatus = warn.length ? 'warning' : 'success'
      return {
        status,
        versionId: result.info.id,
        mode: result.info.kind,
        files: s.files,
        bytes: s.bytes,
        filesDone: s.newFiles,
        bytesDone: s.newBytes,
        errors: result.errors,
        errorCount: result.errorCount,
        cloud,
        message: [`${kindLabel} complete${notes.length ? ` · ${notes.join(' · ')}` : ''}`, ...warn].join('. ')
      }
    }
  }

  function cloudJob(p: BackupPlan) {
    return async (_job: Job, io: JobIO): Promise<Outcome> => {
      const plan = findPlan(p.id)
      const root = await reach(plan, false)
      const c = await cloudStep(plan, root, io)
      if (!c.ok) throw new Error(c.message)
      return { cloud: 'success', message: c.uploaded ? `Copied ${c.uploaded} version${c.uploaded === 1 ? '' : 's'} to Google Drive` : 'Google Drive copy is up to date' }
    }
  }

  function restoreJob(req: RestoreRequest) {
    return async (_job: Job, io: JobIO): Promise<Outcome> => {
      const plan = findPlan(req.planId)
      const m = await getManifest(plan, req.versionId)
      const rp = planRestore(m, req, PLATFORM)
      let source = null
      const from = req.from ?? 'auto'
      if (from !== 'cloud') {
        try {
          const root = await reach(plan, false)
          await access(join(root, 'versions', req.versionId))
          source = localSource(root)
        } catch (err) {
          if (from === 'local') throw err
        }
      }
      if (!source) {
        const d = plan.cloud.enabled ? driveClient() : null
        if (!d) throw new Error('The backup location is not available and there is no Google Drive copy to restore from.')
        const { listing } = await listingFor(d, plan, true)
        source = cloudSource(d, listing, (vid) => getManifest(plan, vid))
        io.onProgress({ message: 'Restoring from Google Drive…' })
      }
      const r = await runRestore(rp, req.overwrite, source, io)
      const parts = [`Restored ${r.restored} file${r.restored === 1 ? '' : 's'}`]
      if (r.unchanged) parts.push(`${r.unchanged} already up to date`)
      if (r.skipped) parts.push(`${r.skipped} skipped (existing)`)
      if (r.errorCount) parts.push(`${r.errorCount} failed`)
      return {
        status: r.errorCount ? 'warning' : 'success',
        versionId: req.versionId,
        files: rp.items.length,
        bytes: rp.bytes,
        filesDone: r.restored,
        bytesDone: r.bytes,
        errors: r.errors,
        errorCount: r.errorCount,
        message: `${parts.join(' · ')}${req.target === 'folder' ? ` → ${req.folder}` : ' to their original locations'}`
      }
    }
  }

  function validateJob(p: BackupPlan, vid: string) {
    return async (_job: Job, io: JobIO): Promise<Outcome> => {
      const plan = findPlan(p.id)
      const root = await reach(plan, false)
      const m = await readManifest(root, vid)
      const r = await validateVersion(root, m, io)
      try {
        const info = (await listVersions(root)).find((v) => v.id === vid)
        if (info) await writeVersionInfo(root, { ...info, verified: r.badCount === 0 })
      } catch {
        /* read-only destination — result still in history */
      }
      return {
        status: r.badCount ? 'failed' : 'success',
        versionId: vid,
        files: r.checked,
        filesDone: r.checked - r.badCount,
        errors: r.bad,
        errorCount: r.badCount,
        message: r.badCount
          ? `Validation found ${r.badCount} damaged or missing file${r.badCount === 1 ? '' : 's'} — run a new full backup.`
          : `Validated ${r.checked} files — all intact`
      }
    }
  }

  /* -------------------------------- scheduler ------------------------------- */

  // Plans whose scheduled time passed while WICKED was closed.
  const missed: BackupPlan[] = []
  for (const p of plans) {
    if (schedulable(p) && p.nextRun && p.nextRun < Date.now() && p.schedule.runMissed) missed.push(p)
    if (!p.nextRun || p.nextRun < Date.now() || !schedulable(p)) refreshNextRun(p)
  }
  savePlans()

  setTimeout(() => {
    for (const p of missed) {
      if (plans.some((x) => x.id === p.id))
        enqueue({ kind: 'backup', planId: p.id, planName: p.name, trigger: 'missed', exec: backupJob(p, false) })
    }
  }, 60_000)

  setInterval(() => {
    const now = Date.now()
    let dirty = false
    for (const p of plans) {
      if (!schedulable(p) || !p.nextRun || now < p.nextRun) continue
      enqueue({ kind: 'backup', planId: p.id, planName: p.name, trigger: 'schedule', exec: backupJob(p, false) })
      refreshNextRun(p, now)
      dirty = true
    }
    if (dirty) {
      savePlans()
      changed()
    }
  }, 30_000)

  /* ----------------------------- plan validation ---------------------------- */

  type PlanDraft = Partial<BackupPlan> & { password?: string | null }

  function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
  }

  /** "Documents +2 · 2026-09-25 14:05" — default name for a one-time backup */
  function oneTimeName(sources: string[]): string {
    const leaf = (sources[0] ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/:$/, ' drive') || 'Backup'
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
    return `${leaf}${sources.length > 1 ? ` +${sources.length - 1}` : ''} · ${stamp}`
  }

  function normalizePlan(d: PlanDraft, existing: BackupPlan | null): BackupPlan {
    const oneTime = d.oneTime ?? existing?.oneTime ?? false
    const sources = [...new Set((d.sources ?? []).map((s) => String(s).trim()).filter(Boolean))]
    if (!sources.length) throw new Error('Choose at least one file or folder to back up.')
    const name = (String(d.name ?? '').trim() || (oneTime ? oneTimeName(sources) : '')).slice(0, 80)
    if (!name) throw new Error('Give the backup a name.')
    for (const s of sources) if (!isAbsolute(s)) throw new Error(`"${s}" is not a full path.`)
    const destPath = String(d.destination?.path ?? '').trim()
    if (!destPath) throw new Error('Choose where to store the backups.')
    if (!isAbsolute(destPath) && !/^\\\\/.test(destPath)) throw new Error('The destination must be a full path, e.g. D:\\Backups or \\\\nas\\backups.')
    const norm = (x: string): string => x.replace(/[\\/]+$/, '').toLowerCase()
    if (sources.some((s) => norm(s) === norm(destPath))) throw new Error('The destination cannot be the same folder you are backing up.')

    const id = existing?.id ?? randomBytes(6).toString('hex')
    const sched = { ...DEFAULT_SCHEDULE, ...(d.schedule ?? {}) }
    const plan: BackupPlan = {
      id,
      name,
      sources,
      exclusions: (d.exclusions ?? DEFAULT_EXCLUSIONS).map((x) => String(x).trim()).filter(Boolean),
      destination: {
        path: destPath,
        username: String(d.destination?.username ?? '').trim(),
        hasPassword: existing?.destination.hasPassword ?? false
      },
      mode: d.mode === 'full' ? 'full' : 'incremental',
      fullEvery: clampInt(d.fullEvery, 0, 365, 6),
      schedule: {
        kind: (['manual', 'hourly', 'daily', 'weekly', 'monthly'] as const).includes(sched.kind) ? sched.kind : 'daily',
        everyHours: clampInt(sched.everyHours, 1, 24, 4),
        time: /^\d{1,2}:\d{2}$/.test(sched.time) ? sched.time : '21:00',
        weekdays: [...new Set((sched.weekdays ?? []).map((x) => clampInt(x, 0, 6, 1)))],
        monthDay: clampInt(sched.monthDay, 1, 31, 1),
        runMissed: sched.runMissed !== false
      },
      retention: {
        kind: d.retention?.kind === 'all' || d.retention?.kind === 'days' ? d.retention.kind : 'count',
        count: clampInt(d.retention?.count, 1, 999, 3),
        days: clampInt(d.retention?.days, 1, 3650, 30)
      },
      cloud: { enabled: !!d.cloud?.enabled },
      verifyAfter: d.verifyAfter !== false,
      enabled: d.enabled !== false,
      machine: existing?.machine ?? MACHINE,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      nextRun: null,
      folder: existing?.folder ?? `${sanitizeFolder(name)} [${id.slice(0, 6)}]`
    }
    if (oneTime) {
      // a single full snapshot: no schedule, no chain, nothing ever cleaned up
      Object.assign(plan, { oneTime: true, mode: 'full', fullEvery: 0, enabled: false })
      plan.schedule = { ...plan.schedule, kind: 'manual' }
      plan.retention = { ...plan.retention, kind: 'all' }
    }
    if (plan.schedule.kind === 'weekly' && !plan.schedule.weekdays.length) throw new Error('Pick at least one day of the week.')
    if (!plan.destination.username) plan.destination.hasPassword = false
    refreshNextRun(plan)
    return plan
  }

  /* ---------------------------------- IPC ---------------------------------- */

  const h = ctx.ipcMain

  h.handle(`${ID}:list-plans`, (): PlanView[] => plans.map(viewOf))

  /** Validate + store a plan (and its share password, if one was supplied). */
  function upsertPlan(draft: PlanDraft): BackupPlan {
    const existing = draft.id ? plans.find((p) => p.id === draft.id) ?? null : null
    if (draft.id && !existing) throw new Error('That backup plan no longer exists.')
    const plan = normalizePlan(draft, existing)
    if (draft.password !== undefined) {
      setPassword(plan.id, plan.destination.username ? draft.password : null)
      plan.destination.hasPassword = !!draft.password && !!plan.destination.username
    }
    if (!plan.destination.username) setPassword(plan.id, null)
    if (existing && (existing.destination.path !== plan.destination.path || existing.destination.username !== plan.destination.username)) {
      reachFail.delete(plan.id)
      manifestCache.clear()
    }
    plans = existing ? plans.map((p) => (p.id === plan.id ? plan : p)) : [...plans, plan]
    savePlans()
    changed()
    return plan
  }

  h.handle(`${ID}:save-plan`, (_e, draft: PlanDraft) => {
    try {
      return { ok: true, plan: viewOf(upsertPlan(draft)) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /** One-time backup: pick folders + a destination and back them up once (kept browsable/restorable). */
  h.handle(`${ID}:one-time`, (_e, draft: PlanDraft & { trigger?: HistoryEntry['trigger'] }) => {
    try {
      const plan = upsertPlan({ ...draft, id: undefined, oneTime: true })
      ctx.storeSet(`${ID}.lastOneTimeDest`, { path: plan.destination.path, username: plan.destination.username })
      const jobId = enqueue({
        kind: 'backup',
        planId: plan.id,
        planName: plan.name,
        trigger: draft.trigger === 'mcp' ? 'mcp' : 'manual',
        exec: backupJob(plan, true)
      })
      return { ok: true, plan: viewOf(plan), jobId }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:last-one-time-dest`, () => ctx.storeGet<{ path: string; username: string } | null>(`${ID}.lastOneTimeDest`, null))

  h.handle(`${ID}:set-enabled`, (_e, a: { planId: string; enabled: boolean }) => {
    const p = findPlan(a.planId)
    p.enabled = !!a.enabled
    refreshNextRun(p)
    savePlans()
    changed()
    return viewOf(p)
  })

  h.handle(`${ID}:adopt`, (_e, a: { planId: string }) => {
    const p = findPlan(a.planId)
    p.machine = MACHINE
    refreshNextRun(p)
    savePlans()
    changed()
    return viewOf(p)
  })

  h.handle(`${ID}:delete-plan`, async (_e, a: { planId: string; deleteBackups?: boolean }) => {
    try {
      const p = findPlan(a.planId)
      if (running?.planId === p.id) throw new Error('This plan is busy — cancel its job first.')
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].planId === p.id) queue.splice(i, 1)
      let note = ''
      if (a.deleteBackups) {
        const root = await reach(p, false)
        await rm(root, { recursive: true, force: true, maxRetries: 3 })
        if (p.cloud.enabled) {
          const d = driveClient()
          if (d) {
            try {
              await d.trash(await planFolderId(d, p))
            } catch (err) {
              note = ` (the Google Drive copy could not be removed: ${errMsg(err)})`
            }
          }
        }
      }
      plans = plans.filter((x) => x.id !== p.id)
      savePlans()
      setPassword(p.id, null)
      const trash = pendingTrash()
      delete trash[p.id]
      ctx.storeSet(`${ID}.pendingCloudTrash`, trash)
      sendQueue(true)
      changed()
      return { ok: true, note }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:run`, (_e, a: { planId: string; full?: boolean; trigger?: HistoryEntry['trigger'] }) => {
    try {
      const p = findPlan(a.planId)
      const jobId = enqueue({
        kind: 'backup',
        planId: p.id,
        planName: p.name,
        trigger: a.trigger === 'mcp' ? 'mcp' : 'manual',
        exec: backupJob(p, !!a.full)
      })
      return { ok: true, jobId }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:cloud-sync`, (_e, a: { planId: string }) => {
    try {
      const p = findPlan(a.planId)
      if (!p.cloud.enabled) throw new Error('The Google Drive copy is off for this plan.')
      return { ok: true, jobId: enqueue({ kind: 'cloud', planId: p.id, planName: p.name, trigger: 'manual', exec: cloudJob(p) }) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:cancel`, (_e, a?: { jobId?: string }) => ({ ok: cancelJob(a?.jobId) }))

  h.handle(`${ID}:queue`, (): QueueState => queueState())

  h.handle(`${ID}:history`, (_e, a?: { planId?: string; limit?: number }) => {
    const list = a?.planId ? history.filter((x) => x.planId === a.planId) : history
    return list.slice(0, a?.limit ?? HISTORY_MAX)
  })

  h.handle(`${ID}:clear-history`, (_e, a?: { planId?: string }) => {
    history = a?.planId ? history.filter((x) => x.planId !== a.planId) : []
    saveHistory()
    changed()
    return { ok: true }
  })

  h.handle(`${ID}:versions`, async (_e, a: { planId: string }) => {
    try {
      return { ok: true, ...(await versionsOf(findPlan(a.planId))) }
    } catch (err) {
      return { ok: false, error: errMsg(err), versions: [], localError: '', cloudError: '' }
    }
  })

  h.handle(`${ID}:browse`, async (_e, a: { planId: string; versionId: string; dir?: string | null }) => {
    try {
      const m = await getManifest(findPlan(a.planId), a.versionId)
      return { ok: true, result: browse(m, a.dir ?? null), platform: m.platform, sources: m.sources }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:search`, async (_e, a: { planId: string; versionId: string; query: string }) => {
    try {
      const m = await getManifest(findPlan(a.planId), a.versionId)
      return { ok: true, entries: search(m, a.query) }
    } catch (err) {
      return { ok: false, error: errMsg(err), entries: [] }
    }
  })

  h.handle(`${ID}:file-history`, async (_e, a: { planId: string; storePath: string }) => {
    try {
      const p = findPlan(a.planId)
      const { versions } = await versionsOf(p)
      const ms: Manifest[] = []
      for (const v of versions.slice(0, 60)) {
        try {
          ms.push(await getManifest(p, v.id))
        } catch {
          /* unreadable version — skip */
        }
      }
      return { ok: true, entries: fileHistory(ms, a.storePath) }
    } catch (err) {
      return { ok: false, error: errMsg(err), entries: [] }
    }
  })

  h.handle(`${ID}:restore`, async (_e, req: RestoreRequest & { trigger?: HistoryEntry['trigger'] }) => {
    try {
      const p = findPlan(req.planId)
      if (!Array.isArray(req.paths)) throw new Error('Nothing selected to restore.')
      if (req.target === 'folder' && !req.folder) throw new Error('Choose a folder to restore to.')
      if (!['overwrite', 'older', 'skip'].includes(req.overwrite)) req.overwrite = 'older'
      // resolve now so an obviously bad request fails immediately
      const m = await getManifest(p, req.versionId)
      const rp = planRestore(m, req, PLATFORM)
      const jobId = enqueue({
        kind: 'restore',
        planId: p.id,
        planName: p.name,
        trigger: req.trigger === 'mcp' ? 'mcp' : 'manual',
        exec: restoreJob(req)
      })
      return { ok: true, jobId, files: rp.items.length, bytes: rp.bytes }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:validate`, (_e, a: { planId: string; versionId: string }) => {
    try {
      const p = findPlan(a.planId)
      return { ok: true, jobId: enqueue({ kind: 'validate', planId: p.id, planName: p.name, trigger: 'manual', exec: validateJob(p, a.versionId) }) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:delete-version`, async (_e, a: { planId: string; versionId: string }) => {
    try {
      const p = findPlan(a.planId)
      if (running?.planId === p.id) throw new Error('This plan is busy — wait for its job to finish.')
      const { versions } = await versionsOf(p)
      const ids = deletionSet(versions, a.versionId).map((v) => v.id)
      if (!ids.length) throw new Error('That version was not found.')
      const localIds = versions.filter((v) => v.local && ids.includes(v.id)).map((v) => v.id)
      if (localIds.length) {
        const root = await reach(p, false)
        const release = await acquireLock(root, 'cleanup')
        try {
          await deleteVersions(root, localIds)
        } finally {
          await release()
        }
      }
      queueCloudTrash(p, ids)
      const d = p.cloud.enabled ? driveClient() : null
      if (d) await flushCloudTrash(d, p).catch(() => undefined)
      manifestCache.clear()
      changed()
      return { ok: true, deleted: ids }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:test-destination`, async (_e, a: { path: string; username?: string; password?: string | null; planId?: string }) => {
    try {
      const path = String(a.path ?? '').trim()
      if (!path) throw new Error('Enter a folder or network path first.')
      const user = String(a.username ?? '').trim()
      const pw = a.password !== undefined && a.password !== null ? a.password : a.planId ? getPassword(a.planId) : null
      await ensureShare(path, user, pw, true)
      const dir = join(path, BACKUP_DIRNAME)
      await mkdir(dir, { recursive: true })
      const probe = join(dir, `.wicked-probe-${randomBytes(3).toString('hex')}`)
      await writeFile(probe, 'ok')
      await rm(probe, { force: true })
      let free: number | null = null
      try {
        const s = await statfs(path)
        free = Number(s.bavail) * Number(s.bsize)
      } catch {
        /* unknown */
      }
      return { ok: true, free }
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
  })

  h.handle(`${ID}:pick-sources`, async (_e, a: { kind: 'folders' | 'files' }) => {
    const win = ctx.getMainWindow()
    const opts = {
      title: a?.kind === 'files' ? 'Choose files to back up' : 'Choose folders to back up',
      properties: [a?.kind === 'files' ? 'openFile' : 'openDirectory', 'multiSelections'] as ('openFile' | 'openDirectory' | 'multiSelections')[]
    }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })

  h.handle(`${ID}:pick-folder`, async (_e, a?: { title?: string }) => {
    const win = ctx.getMainWindow()
    const opts = { title: a?.title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0] ?? null
  })

  /** "Open existing backup": adopt plans found at a destination (e.g. on a new PC). */
  h.handle(`${ID}:open-existing`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Choose the backup location (the folder that contains "WICKED Backup")',
      properties: ['openDirectory'] as 'openDirectory'[]
    }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    const picked = r.filePaths[0]
    const roots: string[] = []
    const scanDir = (dir: string): void => {
      try {
        for (const n of readdirSync(dir)) if (existsSync(join(dir, n, 'plan.json'))) roots.push(join(dir, n))
      } catch {
        /* unreadable */
      }
    }
    if (existsSync(join(picked, 'plan.json'))) roots.push(picked)
    else if (basename(picked).toLowerCase() === BACKUP_DIRNAME.toLowerCase()) scanDir(picked)
    else if (existsSync(join(picked, BACKUP_DIRNAME))) scanDir(join(picked, BACKUP_DIRNAME))
    if (!roots.length) return { ok: false, error: 'No WICKED backups were found in that folder.' }
    let added = 0
    for (const root of roots) {
      try {
        const disk = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8')) as BackupPlan
        const dest = dirname(dirname(root))
        const cur = plans.find((p) => p.id === disk.id)
        if (cur) {
          cur.destination.path = dest
          reachFail.delete(cur.id)
          continue
        }
        const p: BackupPlan = {
          ...disk,
          destination: { path: dest, username: '', hasPassword: false },
          folder: basename(root),
          nextRun: null,
          updatedAt: Date.now()
        }
        refreshNextRun(p)
        plans.push(p)
        added++
      } catch {
        /* damaged plan.json */
      }
    }
    savePlans()
    changed()
    return { ok: true, added, found: roots.length }
  })

  h.handle(`${ID}:drive-status`, (): DriveStatus => driveStatus())

  h.handle(`${ID}:settings`, (): GlobalSettings => ({
    openAtLogin: ctx.app.getLoginItemSettings().openAtLogin,
    machine: MACHINE
  }))

  h.handle(`${ID}:set-open-at-login`, (_e, a: { enabled: boolean }) => {
    ctx.app.setLoginItemSettings({ openAtLogin: !!a.enabled })
    return { openAtLogin: ctx.app.getLoginItemSettings().openAtLogin, machine: MACHINE }
  })

  h.handle(`${ID}:reveal`, async (_e, a: { planId?: string; path?: string }) => {
    try {
      const target = a.planId ? await reach(findPlan(a.planId), false) : String(a.path ?? '')
      if (!target) return { ok: false }
      const err = await ctx.shell.openPath(target)
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    { label: 'Backup plans & history', path: dataDir, note: 'plans.json, history.json (share passwords are encrypted)' },
    ...plans.map((p) => ({
      label: `"${p.name}" backups`,
      path: p.destination.path ? planRoot(p.destination.path, p.folder) : null,
      note: p.cloud.enabled ? 'Also copied to Google Drive › WICKED Backups' : undefined
    }))
  ])
}

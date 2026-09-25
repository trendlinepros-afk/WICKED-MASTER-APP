/**
 * Backup engine — file & folder backups, restores, validation and cleanup.
 *
 * Deliberately free of Electron imports so it can be exercised headless.
 * Everything here works on a plan's ROOT folder at the destination:
 *
 *   <root> = <destination>/WICKED Backup/<plan.folder>
 *     plan.json
 *     .lock                                 — present while a job writes here
 *     versions/<id>/info.json               — VersionInfo
 *     versions/<id>/manifest.json.gz        — Manifest
 *     versions/<id>/data/<storePath>        — plain file copies
 *     versions/.<id>.partial/               — a version being written (renamed when done)
 *
 * Files are stored as plain copies (not an archive) so a backup stays readable
 * even without WICKED, and a single file restores without unpacking anything.
 */
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, type Stats } from 'fs'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, utimes, writeFile } from 'fs/promises'
import { hostname } from 'os'
import { dirname, join } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { gunzipSync, gzipSync } from 'zlib'
import type {
  BackupMode,
  BackupPlan,
  BrowseEntry,
  BrowseResult,
  FileHistoryEntry,
  JobProgress,
  Manifest,
  ManifestFile,
  OverwritePolicy,
  RestoreRequest,
  VersionInfo,
  VersionStats
} from '../types'
import {
  baseName,
  displayStorePath,
  fromStorePath,
  makeExcluder,
  parentOf,
  pathKey,
  toStorePath
} from '../lib/paths'

export const BACKUP_DIRNAME = 'WICKED Backup'
export const MANIFEST_NAME = 'manifest.json.gz'
const COPY_CONCURRENCY = 4
const HWM = 1024 * 1024
/** a .lock older than this is considered abandoned (crash / power loss) */
const LOCK_STALE_MS = 12 * 3600_000
const MAX_LOGGED_ERRORS = 500

export type ProgressFn = (p: Partial<JobProgress>) => void

export interface JobIO {
  signal: AbortSignal
  onProgress: ProgressFn
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
  }
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError()
}

export function errText(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  switch (e?.code) {
    case 'EBUSY':
    case 'EPERM':
      return 'In use by another program or access denied'
    case 'EACCES':
      return 'Access denied'
    case 'ENOENT':
      return 'Not found (moved or deleted during the backup)'
    case 'ENOSPC':
      return 'The backup destination is out of space'
    case 'ENAMETOOLONG':
      return 'Path is too long'
  }
  return e instanceof Error ? e.message : String(err)
}

/** Everything under `root` for a plan. */
export function planRoot(destination: string, folder: string): string {
  return join(destination, BACKUP_DIRNAME, folder)
}

const versionsDir = (root: string): string => join(root, 'versions')
const versionDir = (root: string, vid: string): string => join(versionsDir(root), vid)
export const dataPath = (root: string, vid: string, sp: string): string =>
  join(versionDir(root, vid), 'data', ...sp.split('/'))

/* ------------------------------- manifests ------------------------------- */

export function encodeManifest(m: Manifest): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(m), 'utf8'))
}

export function decodeManifest(buf: Buffer): Manifest {
  const m = JSON.parse(gunzipSync(buf).toString('utf8')) as Manifest
  if (m.format !== 'wicked-backup/1') throw new Error('Unrecognised backup manifest format')
  return m
}

export async function readManifest(root: string, vid: string): Promise<Manifest> {
  return decodeManifest(await readFile(join(versionDir(root, vid), MANIFEST_NAME)))
}

export async function readVersionInfo(root: string, vid: string): Promise<VersionInfo> {
  return JSON.parse(await readFile(join(versionDir(root, vid), 'info.json'), 'utf8')) as VersionInfo
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rename(tmp, path)
}

export async function writeVersionInfo(root: string, info: VersionInfo): Promise<void> {
  await writeJsonAtomic(join(versionDir(root, info.id), 'info.json'), info)
}

/** Completed versions at the destination, oldest first. */
export async function listVersions(root: string): Promise<VersionInfo[]> {
  let names: string[]
  try {
    names = await readdir(versionsDir(root))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: VersionInfo[] = []
  for (const n of names) {
    if (n.startsWith('.')) continue
    try {
      const info = await readVersionInfo(root, n)
      out.push({ ...info, id: n, local: true })
    } catch {
      /* not a version folder (or damaged info.json) — ignored */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

/** Group versions into chains (a full + the incrementals built on it), oldest first. */
export function chainsOf(versions: VersionInfo[]): VersionInfo[][] {
  const byBase = new Map<string, VersionInfo[]>()
  for (const v of [...versions].sort((a, b) => a.createdAt - b.createdAt)) {
    const list = byBase.get(v.base) ?? []
    list.push(v)
    byBase.set(v.base, list)
  }
  return [...byBase.values()].sort((a, b) => a[0].createdAt - b[0].createdAt)
}

/* ---------------------------------- lock --------------------------------- */

export async function acquireLock(root: string, what: string): Promise<() => Promise<void>> {
  const path = join(root, '.lock')
  try {
    const cur = JSON.parse(await readFile(path, 'utf8')) as { machine: string; pid: number; at: number; what: string }
    // a lock from THIS computer is ours from an earlier crash (jobs run one at a time)
    if (Date.now() - cur.at < LOCK_STALE_MS && cur.machine !== hostname())
      throw new Error(
        `This backup location is busy — ${cur.machine} started a ${cur.what} here ${Math.round((Date.now() - cur.at) / 60000)} min ago. Try again when it finishes.`
      )
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err
  }
  await mkdir(root, { recursive: true })
  await writeFile(path, JSON.stringify({ machine: hostname(), pid: process.pid, at: Date.now(), what }))
  return async () => {
    await rm(path, { force: true })
  }
}

/* --------------------------------- walking -------------------------------- */

interface Scanned {
  abs: string
  sp: string
  size: number
  mtime: number
}

interface ScanResult {
  files: Scanned[]
  dirs: string[]
  errors: { path: string; error: string }[]
  /** sources that don't exist right now */
  missingSources: string[]
}

async function scanSources(
  sources: string[],
  exclusions: string[],
  skipRootKeys: string[],
  platform: string,
  io: JobIO
): Promise<ScanResult> {
  const ex = makeExcluder(exclusions, platform)
  const seen = new Set<string>()
  const seenDirs = new Set<string>()
  const res: ScanResult = { files: [], dirs: [], errors: [], missingSources: [] }
  let lastTick = 0

  const addDir = (sp: string): void => {
    const k = pathKey(sp, platform)
    if (seenDirs.has(k)) return
    seenDirs.add(k)
    res.dirs.push(sp)
  }

  const tick = (current: string): void => {
    if (Date.now() - lastTick < 200) return
    lastTick = Date.now()
    io.onProgress({ scanned: res.files.length, current })
  }

  const walk = async (dirAbs: string, dirSp: string): Promise<void> => {
    checkAbort(io.signal)
    addDir(dirSp)
    let names: string[]
    try {
      names = await readdir(dirAbs)
    } catch (err) {
      res.errors.push({ path: dirAbs, error: errText(err) })
      return
    }
    tick(dirAbs)
    const subdirs: [string, string][] = []
    // lstat in small batches: fast on local disks, still polite on a NAS source
    for (let i = 0; i < names.length; i += 16) {
      const batch = names.slice(i, i + 16)
      await Promise.all(
        batch.map(async (name) => {
          const abs = join(dirAbs, name)
          const sp = `${dirSp}/${name}`
          if (ex.test(sp, name)) return
          try {
            // lstat: never follow junctions/symlinks (AppData has self-referencing
            // junctions). Cloud placeholders (OneDrive) are NOT links and are kept.
            const st = await lstat(abs)
            if (st.isSymbolicLink()) return
            if (st.isDirectory()) {
              if (skipRootKeys.includes(pathKey(sp, platform))) return
              subdirs.push([abs, sp])
            } else if (st.isFile()) {
              const k = pathKey(sp, platform)
              if (seen.has(k)) return
              seen.add(k)
              res.files.push({ abs, sp, size: st.size, mtime: Math.round(st.mtimeMs) })
            }
          } catch (err) {
            res.errors.push({ path: abs, error: errText(err) })
          }
        })
      )
    }
    for (const [abs, sp] of subdirs.sort((a, b) => a[1].localeCompare(b[1]))) await walk(abs, sp)
  }

  for (const src of sources) {
    const sp = toStorePath(src, platform)
    let st
    try {
      st = await stat(src) // follow: a source may itself be a junction (e.g. a redirected folder)
    } catch {
      res.missingSources.push(src)
      continue
    }
    // the parent folders of a source are part of the tree (for browsing)
    const parts = sp.split('/')
    for (let i = 1; i < parts.length; i++) addDir(parts.slice(0, i).join('/'))
    if (st.isDirectory()) await walk(src, sp)
    else if (st.isFile()) {
      const k = pathKey(sp, platform)
      if (!seen.has(k)) {
        seen.add(k)
        res.files.push({ abs: src, sp, size: st.size, mtime: Math.round(st.mtimeMs) })
      }
    }
  }
  return res
}

/* --------------------------------- copying -------------------------------- */

/** Stream `src` → `dst`, hashing on the way. Returns sha256 + bytes written. */
export async function copyHashed(
  src: string,
  dst: string,
  signal: AbortSignal,
  onBytes: (n: number) => void
): Promise<{ hash: string; bytes: number }> {
  const h = createHash('sha256')
  let bytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk)
      bytes += chunk.length
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
  await pipeline(createReadStream(src, { highWaterMark: HWM }), tap, createWriteStream(dst), { signal })
  return { hash: h.digest('hex'), bytes }
}

export async function hashFile(path: string, signal: AbortSignal, onBytes?: (n: number) => void): Promise<string> {
  const h = createHash('sha256')
  const rs = createReadStream(path, { highWaterMark: HWM, signal })
  for await (const chunk of rs) {
    h.update(chunk as Buffer)
    onBytes?.((chunk as Buffer).length)
  }
  return h.digest('hex')
}

/** Run `fn` over items with bounded concurrency; stops early on abort. */
async function pool<T>(items: T[], n: number, signal: AbortSignal, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed: { err: unknown } | null = null
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      if (signal.aborted) return
      const item = items[next++]
      try {
        await fn(item)
      } catch (err) {
        failed ??= { err } // stop every worker, surface the first fatal error
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  if (failed) throw (failed as { err: unknown }).err
  checkAbort(signal)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function newVersionId(at: Date, kind: BackupMode, existing: Set<string>): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const tag = kind === 'full' ? 'full' : 'inc'
  let id = `${stamp}_${tag}`
  for (let i = 2; existing.has(id); i++) id = `${stamp}-${i}_${tag}`
  return id
}

/* --------------------------------- backup --------------------------------- */

export interface BackupOptions {
  plan: BackupPlan
  root: string
  /** force a new full version even in incremental mode */
  forceFull: boolean
  platform: string
  io: JobIO
  now?: () => Date
}

export interface BackupResult {
  info: VersionInfo
  errors: { path: string; error: string }[]
  errorCount: number
  /** files whose changed content couldn't be read, so the previous copy was kept */
  carried: number
  missingSources: string[]
  verifyFailures: number
}

/** Decide full vs incremental for the next run. */
export function decideKind(
  plan: Pick<BackupPlan, 'mode' | 'fullEvery'>,
  versions: VersionInfo[],
  forceFull: boolean
): { kind: BackupMode; parent: VersionInfo | null } {
  const last = versions[versions.length - 1]
  if (forceFull || plan.mode === 'full' || !last) return { kind: 'full', parent: null }
  const chain = versions.filter((v) => v.base === last.base)
  const incs = chain.filter((v) => v.kind === 'incremental').length
  if (plan.fullEvery > 0 && incs >= plan.fullEvery) return { kind: 'full', parent: null }
  return { kind: 'incremental', parent: last }
}

/** Remove half-written / half-deleted version folders from an interrupted job. */
export async function cleanupLeftovers(root: string): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(versionsDir(root))
  } catch {
    return
  }
  for (const n of names) {
    if (n.startsWith('.') && (n.endsWith('.partial') || n.endsWith('.deleting')))
      await rm(join(versionsDir(root), n), { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const { plan, root, platform, io } = opts
  const started = Date.now()
  const now = opts.now ?? (() => new Date())

  await mkdir(versionsDir(root), { recursive: true })
  await cleanupLeftovers(root)

  const versions = await listVersions(root)
  let { kind, parent } = decideKind(plan, versions, opts.forceFull)
  let prev: Manifest | null = null
  if (parent) {
    try {
      prev = await readManifest(root, parent.id)
    } catch {
      // previous version unreadable — a fresh full is the safe answer
      kind = 'full'
      parent = null
    }
  }
  if (prev && prev.platform !== platform) {
    kind = 'full'
    parent = null
    prev = null
  }

  io.onProgress({ phase: 'scanning', message: 'Scanning source files…', scanned: 0 })
  const skip = [pathKey(toStorePath(join(plan.destination.path, BACKUP_DIRNAME), platform), platform)]
  const scan = await scanSources(plan.sources, plan.exclusions, skip, platform, io)
  if (scan.missingSources.length === plan.sources.length)
    throw new Error(
      plan.sources.length === 1
        ? `The source "${plan.sources[0]}" is not available.`
        : 'None of the source folders are available (drive disconnected?).'
    )

  // what needs copying
  const prevFiles = prev?.files ?? {}
  const prevByKey = new Map<string, [string, ManifestFile]>()
  if (platform === 'win32') for (const [sp, f] of Object.entries(prevFiles)) prevByKey.set(pathKey(sp, platform), [sp, f])
  const prevOf = (sp: string): ManifestFile | undefined =>
    prevFiles[sp] ?? (platform === 'win32' ? prevByKey.get(pathKey(sp, platform))?.[1] : undefined)

  const toCopy: Scanned[] = []
  const unchanged: [Scanned, ManifestFile][] = []
  for (const f of scan.files) {
    const p = kind === 'incremental' ? prevOf(f.sp) : undefined
    if (p && p.size === f.size && p.mtime === f.mtime) unchanged.push([f, p])
    else toCopy.push(f)
  }
  const bytesToCopy = toCopy.reduce((a, f) => a + f.size, 0)

  // room for it?
  try {
    const fs = await statfs(root)
    const free = Number(fs.bavail) * Number(fs.bsize)
    if (free > 0 && free < bytesToCopy + 64 * 1024 * 1024)
      throw new Error(
        `Not enough space at the destination: this backup needs ${fmtGB(bytesToCopy)} but only ${fmtGB(free)} is free.`
      )
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Not enough space')) throw err
    /* statfs unsupported on this share — carry on, ENOSPC is still caught per file */
  }

  const existing = new Set(versions.map((v) => v.id))
  const vid = newVersionId(now(), kind, existing)
  const partial = join(versionsDir(root), `.${vid}.partial`)
  const dataRoot = join(partial, 'data')
  await mkdir(dataRoot, { recursive: true })

  const files: Record<string, ManifestFile> = {}
  for (const [f, p] of unchanged) files[f.sp] = { ...p, size: f.size, mtime: f.mtime }

  const errors = [...scan.errors]
  let carried = 0
  let filesDone = 0
  let bytesDone = 0
  let newBytes = 0
  const made = new Set<string>()
  const ensureDir = async (d: string): Promise<void> => {
    if (made.has(d)) return
    await mkdir(d, { recursive: true })
    made.add(d)
  }

  io.onProgress({
    phase: 'copying',
    message: kind === 'full' ? 'Creating a full backup…' : 'Backing up changes…',
    filesTotal: toCopy.length,
    bytesTotal: bytesToCopy,
    filesDone: 0,
    bytesDone: 0
  })

  let lastTick = 0
  const tick = (current: string, force = false): void => {
    if (!force && Date.now() - lastTick < 200) return
    lastTick = Date.now()
    io.onProgress({ filesDone, bytesDone, current })
  }

  await pool(toCopy, COPY_CONCURRENCY, io.signal, async (f) => {
    const dst = join(dataRoot, ...f.sp.split('/'))
    tick(f.abs)
    let got = 0
    try {
      await ensureDir(dirname(dst))
      const r = await copyHashed(f.abs, dst, io.signal, (n) => {
        got += n
        bytesDone += n
        tick(f.abs)
      })
      await utimes(dst, new Date(f.mtime), new Date(f.mtime)).catch(() => undefined)
      files[f.sp] = { size: r.bytes, mtime: f.mtime, hash: r.hash, v: vid }
      newBytes += r.bytes
    } catch (err) {
      bytesDone -= got
      if (io.signal.aborted) return
      await rm(dst, { force: true }).catch(() => undefined)
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw new Error(errText(err))
      // a changed file we couldn't read: keep the last good copy in incremental chains
      const p = kind === 'incremental' ? prevOf(f.sp) : undefined
      if (p) {
        files[f.sp] = p
        carried++
        errors.push({ path: f.abs, error: `${errText(err)} — kept the copy from ${p.v}` })
      } else errors.push({ path: f.abs, error: errText(err) })
    }
    filesDone++
    tick(f.abs)
  })
  tick('', true)

  // verification: re-read what was written in THIS version
  let verifyFailures = 0
  let verified: boolean | null = null
  if (plan.verifyAfter) {
    const written = Object.entries(files).filter(([, f]) => f.v === vid)
    io.onProgress({
      phase: 'verifying',
      message: 'Validating the backup…',
      filesTotal: written.length,
      filesDone: 0,
      bytesTotal: written.reduce((a, [, f]) => a + f.size, 0),
      bytesDone: 0
    })
    let vf = 0
    let vb = 0
    await pool(written, COPY_CONCURRENCY, io.signal, async ([sp, f]) => {
      try {
        const h = await hashFile(join(dataRoot, ...sp.split('/')), io.signal, (n) => {
          vb += n
        })
        if (h !== f.hash) {
          verifyFailures++
          errors.push({ path: sp, error: 'Validation failed: the stored copy does not match what was read' })
        }
      } catch (err) {
        if (io.signal.aborted) return
        verifyFailures++
        errors.push({ path: sp, error: `Validation failed: ${errText(err)}` })
      }
      vf++
      if (vf % 20 === 0) io.onProgress({ filesDone: vf, bytesDone: vb, current: sp })
    })
    verified = verifyFailures === 0
  }

  const fileCount = Object.keys(files).length
  const stats: VersionStats = {
    files: fileCount,
    bytes: Object.values(files).reduce((a, f) => a + f.size, 0),
    newFiles: Object.values(files).filter((f) => f.v === vid).length,
    newBytes,
    errors: errors.length,
    dirs: scan.dirs.length,
    durationMs: Date.now() - started
  }
  const createdAt = now().getTime()
  const base = kind === 'full' || !parent ? vid : parent.base
  const manifest: Manifest = {
    format: 'wicked-backup/1',
    planId: plan.id,
    versionId: vid,
    kind,
    base,
    parent: parent?.id ?? null,
    createdAt,
    platform,
    machine: hostname(),
    sources: plan.sources,
    files: sortKeys(files),
    dirs: scan.dirs.sort(),
    errors: errors.slice(0, MAX_LOGGED_ERRORS),
    stats
  }
  const info: VersionInfo = {
    id: vid,
    planId: plan.id,
    kind,
    base,
    parent: parent?.id ?? null,
    createdAt,
    stats,
    verified,
    local: true,
    cloud: 'none'
  }
  await writeFile(join(partial, MANIFEST_NAME), encodeManifest(manifest))
  await writeFile(join(partial, 'info.json'), JSON.stringify(info, null, 2))
  await rename(partial, versionDir(root, vid))

  return {
    info,
    errors: errors.slice(0, MAX_LOGGED_ERRORS),
    errorCount: errors.length,
    carried,
    missingSources: scan.missingSources,
    verifyFailures
  }
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of Object.keys(o).sort()) out[k] = o[k]
  return out
}

function fmtGB(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`
}

/* -------------------------------- cleanup -------------------------------- */

/** Versions that the plan's cleanup rules say should go (whole chains only; the newest chain is always kept). */
export function retentionVictims(plan: Pick<BackupPlan, 'retention'>, versions: VersionInfo[], now = Date.now()): VersionInfo[] {
  const r = plan.retention
  if (r.kind === 'all') return []
  const chains = chainsOf(versions)
  if (chains.length <= 1) return []
  const older = chains.slice(0, -1) // never the newest chain
  let doomed: VersionInfo[][] = []
  if (r.kind === 'count') {
    const keep = Math.max(1, Math.round(r.count || 1))
    doomed = chains.length > keep ? chains.slice(0, chains.length - keep) : []
  } else if (r.kind === 'days') {
    const cutoff = now - Math.max(1, r.days || 1) * 86400_000
    doomed = older.filter((c) => c[c.length - 1].createdAt < cutoff)
  }
  return doomed.flat()
}

/**
 * Versions that can be deleted on their own without breaking another: a full
 * takes its whole chain with it; an incremental only if nothing is built on it.
 */
export function deletionSet(versions: VersionInfo[], vid: string): VersionInfo[] {
  const v = versions.find((x) => x.id === vid)
  if (!v) return []
  if (v.kind === 'full' || v.base === v.id) return versions.filter((x) => x.base === v.id)
  // everything that depends (transitively) on v
  const out = [v]
  let frontier = [v.id]
  while (frontier.length) {
    const kids = versions.filter((x) => x.parent && frontier.includes(x.parent))
    out.push(...kids)
    frontier = kids.map((k) => k.id)
  }
  return out
}

export async function deleteVersions(root: string, vids: string[]): Promise<void> {
  // newest first so a crash mid-way never leaves an incremental without its parent
  for (const vid of [...vids].sort().reverse()) {
    const dir = versionDir(root, vid)
    // rename first (instant) so a half-deleted folder is never mistaken for a version
    const trash = join(versionsDir(root), `.${vid}.deleting`)
    try {
      await rename(dir, trash)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    await rm(trash, { recursive: true, force: true, maxRetries: 3 })
  }
}

/* -------------------------------- browsing -------------------------------- */

interface DirIndex {
  /** dir storePath → child dir names */
  dirs: Map<string, Set<string>>
  /** dir storePath → [file count, bytes] of everything underneath */
  totals: Map<string, [number, number]>
  home: string
}

const dirIndexCache = new WeakMap<Manifest, DirIndex>()

function dirIndex(m: Manifest): DirIndex {
  const hit = dirIndexCache.get(m)
  if (hit) return hit
  const dirs = new Map<string, Set<string>>()
  const totals = new Map<string, [number, number]>()
  const addDir = (sp: string): void => {
    let cur = sp
    while (cur) {
      const par = parentOf(cur)
      const set = dirs.get(par) ?? new Set<string>()
      if (set.has(baseName(cur)) && dirs.has(cur)) break
      set.add(baseName(cur))
      dirs.set(par, set)
      if (!dirs.has(cur)) dirs.set(cur, new Set())
      cur = par
    }
  }
  for (const d of m.dirs) addDir(d)
  for (const [sp, f] of Object.entries(m.files)) {
    const par = parentOf(sp)
    addDir(par)
    let cur: string | null = par
    for (;;) {
      const t = totals.get(cur) ?? [0, 0]
      t[0]++
      t[1] += f.size
      totals.set(cur, t)
      if (cur === '') break
      cur = parentOf(cur)
    }
  }
  // open where the data actually starts: walk down while there's a single folder and no files
  let home = ''
  const sourceRoots = new Set(m.sources.map((s) => toStorePath(s, m.platform)))
  const filesIn = (d: string): number =>
    (totals.get(d)?.[0] ?? 0) - [...(dirs.get(d) ?? [])].reduce((a, c) => a + (totals.get(join2(d, c))?.[0] ?? 0), 0)
  for (;;) {
    const kids = dirs.get(home)
    if (!kids || kids.size !== 1 || filesIn(home) > 0 || sourceRoots.has(home)) break
    home = join2(home, [...kids][0])
  }
  const idx = { dirs, totals, home }
  dirIndexCache.set(m, idx)
  return idx
}

const join2 = (a: string, b: string): string => (a ? `${a}/${b}` : b)

export function browse(m: Manifest, dir: string | null): BrowseResult {
  const idx = dirIndex(m)
  const d = dir ?? idx.home
  const entries: BrowseEntry[] = []
  for (const name of idx.dirs.get(d) ?? []) {
    const sp = join2(d, name)
    const t = idx.totals.get(sp) ?? [0, 0]
    entries.push({ name, path: sp, isDir: true, size: t[1], mtime: 0, files: t[0] })
  }
  const prefix = d ? `${d}/` : ''
  for (const [sp, f] of Object.entries(m.files)) {
    if (!sp.startsWith(prefix)) continue
    const rest = sp.slice(prefix.length)
    if (rest.includes('/')) continue
    entries.push({ name: rest, path: sp, isDir: false, size: f.size, mtime: f.mtime, changed: f.v === m.versionId, v: f.v })
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const all = idx.totals.get('') ?? [0, 0]
  return {
    versionId: m.versionId,
    dir: d,
    display: displayStorePath(d, m.platform),
    entries,
    home: idx.home,
    totalFiles: all[0],
    totalBytes: all[1]
  }
}

export function search(m: Manifest, query: string, limit = 500): BrowseEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const re = /[*?]/.test(q)
    ? new RegExp(
        '^' +
          q
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$'
      )
    : null
  const out: BrowseEntry[] = []
  for (const [sp, f] of Object.entries(m.files)) {
    const name = baseName(sp).toLowerCase()
    if (re ? !re.test(name) : !name.includes(q)) continue
    out.push({ name: baseName(sp), path: sp, isDir: false, size: f.size, mtime: f.mtime, changed: f.v === m.versionId, v: f.v })
    if (out.length >= limit) break
  }
  return out
}

export function fileHistory(manifests: Manifest[], sp: string): FileHistoryEntry[] {
  const out: FileHistoryEntry[] = []
  for (const m of manifests) {
    const f = m.files[sp]
    if (!f) continue
    out.push({ versionId: m.versionId, createdAt: m.createdAt, kind: m.kind, size: f.size, mtime: f.mtime, hash: f.hash, changed: f.v === m.versionId })
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

/* --------------------------------- restore -------------------------------- */

export interface RestoreItem {
  sp: string
  file: ManifestFile
  dest: string
}

export interface RestorePlan {
  items: RestoreItem[]
  /** destination folders to create (empty folders included) */
  dirs: string[]
  bytes: number
}

/** Resolve a selection of files/folders to concrete destination paths. */
export function planRestore(m: Manifest, req: RestoreRequest, platform: string): RestorePlan {
  if (req.target === 'original' && m.platform !== platform)
    throw new Error('This backup was made on a different kind of computer — restore it to a folder instead.')
  if (req.target === 'folder' && !req.folder) throw new Error('Choose a folder to restore to.')

  const items = new Map<string, RestoreItem>()
  const dirs = new Set<string>()
  const allFiles = Object.entries(m.files)
  const roots = m.sources.map((s) => toStorePath(s, m.platform))
  const underSource = (d: string): boolean => roots.some((r) => d === r || d.startsWith(`${r}/`))

  const destFor = (sp: string, selParent: string): string => {
    if (req.target === 'original') return fromStorePath(sp, m.platform)
    const rel = req.keepStructure ? sp : selParent ? sp.slice(selParent.length + 1) : sp
    return join(req.folder!, ...rel.split('/'))
  }

  for (const sel of req.paths.length ? req.paths : ['']) {
    const f = m.files[sel]
    if (f) {
      items.set(sel, { sp: sel, file: f, dest: destFor(sel, parentOf(sel)) })
      continue
    }
    const par = sel ? parentOf(sel) : ''
    const prefix = sel ? `${sel}/` : ''
    let hit = false
    for (const [sp, file] of allFiles) {
      if (!sp.startsWith(prefix)) continue
      hit = true
      if (!items.has(sp)) items.set(sp, { sp, file, dest: destFor(sp, par) })
    }
    for (const d of m.dirs) {
      if (!underSource(d)) continue // never try to create C:\ or \\server itself
      if (d === sel || d.startsWith(prefix)) {
        hit = true
        dirs.add(destFor(d, par))
      }
    }
    if (!hit) throw new Error(`"${displayStorePath(sel, m.platform)}" is not in this backup.`)
  }
  const list = [...items.values()]
  return { items: list, dirs: [...dirs], bytes: list.reduce((a, i) => a + i.file.size, 0) }
}

/** Where restored bytes come from (the destination folder, or Google Drive). */
export interface RestoreSource {
  /**
   * Write each item's bytes to its `tmp` path. Call onDone(item, sha256) or
   * onDone(item, null, error) once per item. onBytes reports throughput.
   */
  fetch(
    items: (RestoreItem & { tmp: string })[],
    cb: {
      onBytes: (n: number) => void
      onDone: (item: RestoreItem & { tmp: string }, hash: string | null, err?: unknown) => Promise<void>
    },
    signal: AbortSignal
  ): Promise<void>
}

export function localSource(root: string): RestoreSource {
  return {
    async fetch(items, cb, signal) {
      await pool(items, COPY_CONCURRENCY, signal, async (it) => {
        try {
          await mkdir(dirname(it.tmp), { recursive: true })
          const r = await copyHashed(dataPath(root, it.file.v, it.sp), it.tmp, signal, cb.onBytes)
          await cb.onDone(it, r.hash)
        } catch (err) {
          if (signal.aborted) return
          await cb.onDone(it, null, err)
        }
      })
    }
  }
}

export interface RestoreResult {
  restored: number
  skipped: number
  unchanged: number
  bytes: number
  errors: { path: string; error: string }[]
  errorCount: number
}

export async function runRestore(plan: RestorePlan, policy: OverwritePolicy, source: RestoreSource, io: JobIO): Promise<RestoreResult> {
  const res: RestoreResult = { restored: 0, skipped: 0, unchanged: 0, bytes: 0, errors: [], errorCount: 0 }
  const fail = (path: string, err: unknown): void => {
    res.errorCount++
    if (res.errors.length < MAX_LOGGED_ERRORS) res.errors.push({ path, error: errText(err) })
  }

  for (const d of plan.dirs) await mkdir(d, { recursive: true }).catch((err) => fail(d, err))

  // apply the overwrite policy up front
  const todo: (RestoreItem & { tmp: string })[] = []
  for (const it of plan.items) {
    checkAbort(io.signal)
    let cur: Stats | null = null
    try {
      cur = await stat(it.dest)
    } catch {
      /* not there — restore */
    }
    if (cur) {
      if (!cur.isFile()) {
        fail(it.dest, new Error('A folder with this name is in the way'))
        continue
      }
      const curMtime = Math.round(cur.mtimeMs)
      if (cur.size === it.file.size && Math.abs(curMtime - it.file.mtime) <= 1) {
        res.unchanged++
        continue
      }
      if (policy === 'skip' || (policy === 'older' && curMtime >= it.file.mtime)) {
        res.skipped++
        continue
      }
    }
    todo.push({ ...it, tmp: `${it.dest}.wkrestore` })
  }

  const total = todo.reduce((a, i) => a + i.file.size, 0)
  io.onProgress({ phase: 'copying', message: 'Restoring files…', filesTotal: todo.length, bytesTotal: total, filesDone: 0, bytesDone: 0 })
  let filesDone = 0
  let bytesDone = 0
  let lastTick = 0
  const tick = (current: string, force = false): void => {
    if (!force && Date.now() - lastTick < 200) return
    lastTick = Date.now()
    io.onProgress({ filesDone, bytesDone, current })
  }

  await source.fetch(
    todo,
    {
      onBytes: (n) => {
        bytesDone += n
        tick('')
      },
      onDone: async (it, hash, err) => {
        filesDone++
        tick(it.dest)
        if (err || !hash) {
          await rm(it.tmp, { force: true }).catch(() => undefined)
          fail(it.dest, err ?? new Error('Read failed'))
          return
        }
        if (hash !== it.file.hash) {
          await rm(it.tmp, { force: true }).catch(() => undefined)
          fail(it.dest, new Error('The backup copy of this file is damaged (checksum mismatch)'))
          return
        }
        try {
          await utimes(it.tmp, new Date(it.file.mtime), new Date(it.file.mtime)).catch(() => undefined)
          try {
            await rename(it.tmp, it.dest)
          } catch (e) {
            // a read-only file in the way: clear the flag and retry once
            if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e
            await chmod(it.dest, 0o666)
            await rename(it.tmp, it.dest)
          }
          res.restored++
          res.bytes += it.file.size
        } catch (e) {
          await rm(it.tmp, { force: true }).catch(() => undefined)
          fail(it.dest, e)
        }
      }
    },
    io.signal
  )
  checkAbort(io.signal)
  tick('', true)
  return res
}

/* -------------------------------- validate -------------------------------- */

export interface ValidateResult {
  checked: number
  bad: { path: string; error: string }[]
  badCount: number
}

/** Re-read every file a version needs (including bytes held by older versions in its chain). */
export async function validateVersion(root: string, m: Manifest, io: JobIO): Promise<ValidateResult> {
  const files = Object.entries(m.files)
  const res: ValidateResult = { checked: 0, bad: [], badCount: 0 }
  io.onProgress({
    phase: 'verifying',
    message: 'Validating…',
    filesTotal: files.length,
    bytesTotal: files.reduce((a, [, f]) => a + f.size, 0),
    filesDone: 0,
    bytesDone: 0
  })
  let bytes = 0
  await pool(files, COPY_CONCURRENCY, io.signal, async ([sp, f]) => {
    try {
      const h = await hashFile(dataPath(root, f.v, sp), io.signal, (n) => {
        bytes += n
      })
      if (h !== f.hash) throw new Error('Checksum mismatch — the stored copy is damaged')
    } catch (err) {
      if (io.signal.aborted) return
      res.badCount++
      if (res.bad.length < MAX_LOGGED_ERRORS) res.bad.push({ path: displayStorePath(sp, m.platform), error: errText(err) })
    }
    res.checked++
    if (res.checked % 20 === 0) io.onProgress({ filesDone: res.checked, bytesDone: bytes, current: sp })
  })
  return res
}

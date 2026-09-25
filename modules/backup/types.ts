/**
 * Backup — shared types (main + renderer). Type-only; no runtime imports.
 *
 * Storage model (see README.md for the full picture):
 *   <destination>/WICKED Backup/<plan folder>/
 *       plan.json                       — plan snapshot (lets another PC "open existing backup")
 *       versions/<versionId>/
 *           info.json                   — small summary (VersionInfo)
 *           manifest.json.gz            — every file in the snapshot → where its bytes live
 *           data/<storePath>            — plain copies of the files NEW in this version
 *
 * A full version stores every file; an incremental version stores only files
 * that changed since the previous version and points at older versions for the
 * rest. A "chain" is one full version plus the incrementals that depend on it.
 */

export type BackupMode = 'full' | 'incremental'

export type ScheduleKind = 'manual' | 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface Schedule {
  kind: ScheduleKind
  /** hourly: run every N hours (1–12), anchored on `time` */
  everyHours: number
  /** 'HH:MM' 24h local time */
  time: string
  /** weekly: 0 = Sunday … 6 = Saturday */
  weekdays: number[]
  /** monthly: 1–31 (clamped to the month's last day) */
  monthDay: number
  /** run a backup ~1 minute after WICKED starts if a scheduled run was missed while it was closed */
  runMissed: boolean
}

export type RetentionKind = 'all' | 'count' | 'days'

export interface Retention {
  kind: RetentionKind
  /** keep the N most recent chains (full mode: a chain is one version) */
  count: number
  /** delete chains whose newest version is older than N days */
  days: number
}

export interface Destination {
  /** local folder (D:\Backups), mapped drive (Z:\) or UNC path (\\nas\share\folder) */
  path: string
  /** network share user (DOMAIN\user or user) — optional; empty = use Windows' current credentials */
  username: string
  /** a password is stored (DPAPI-encrypted, main process only — never sent to the renderer) */
  hasPassword: boolean
}

export interface CloudCopy {
  /** also keep an offsite copy of every version in Google Drive (via File Vault's connection) */
  enabled: boolean
}

export interface BackupPlan {
  id: string
  name: string
  /** absolute file or folder paths */
  sources: string[]
  /** wildcard patterns: `*.tmp`, `node_modules`, `C:\Users\me\Downloads\*` */
  exclusions: string[]
  destination: Destination
  mode: BackupMode
  /** incremental mode: start a new chain (full version) after this many incrementals; 0 = never */
  fullEvery: number
  schedule: Schedule
  retention: Retention
  cloud: CloudCopy
  /** re-read and hash every file written, right after the backup */
  verifyAfter: boolean
  /** schedule enabled (manual runs always work) */
  enabled: boolean
  /** computer this plan runs on — schedules on other PCs stay paused (plans travel via Cloud Sync) */
  machine: string
  createdAt: number
  updatedAt: number
  /** epoch ms of the next scheduled run (null = manual / disabled / other PC) */
  nextRun: number | null
  /** folder name under "<destination>/WICKED Backup" (fixed at creation, survives renames) */
  folder: string
  /** a one-time backup: always full, never scheduled, nothing cleaned up (can be run again by hand) */
  oneTime?: boolean
}

export type RunStatus = 'success' | 'warning' | 'failed' | 'cancelled'

export interface PlanRunSummary {
  at: number
  status: RunStatus
  versionId: string | null
  message: string
}

/** A plan as shown in the UI (plan + live-ish status) */
export interface PlanView extends BackupPlan {
  lastRun: PlanRunSummary | null
  /** this PC is the plan's machine */
  isLocalMachine: boolean
  /** a job for this plan is running or queued */
  busy: boolean
}

export interface VersionStats {
  /** files in the snapshot */
  files: number
  /** bytes represented by the snapshot */
  bytes: number
  /** files copied into this version */
  newFiles: number
  /** bytes copied into this version */
  newBytes: number
  /** files that could not be read */
  errors: number
  dirs: number
  durationMs: number
}

export interface VersionInfo {
  id: string
  planId: string
  kind: BackupMode
  /** first version of this chain (== id for a full) */
  base: string
  /** previous version this incremental was compared against */
  parent: string | null
  createdAt: number
  stats: VersionStats
  verified: boolean | null
  /** data is present at the destination */
  local: boolean
  /** Google Drive copy state */
  cloud: 'none' | 'partial' | 'complete'
}

export interface ManifestFile {
  size: number
  /** mtime, epoch ms */
  mtime: number
  /** sha256 hex of the content */
  hash: string
  /** version folder that holds this file's bytes */
  v: string
}

export interface Manifest {
  format: 'wicked-backup/1'
  planId: string
  versionId: string
  kind: BackupMode
  base: string
  parent: string | null
  createdAt: number
  /** process.platform of the backed-up machine (drives storePath ↔ original path) */
  platform: string
  machine: string
  sources: string[]
  /** storePath → file */
  files: Record<string, ManifestFile>
  /** storePaths of every folder (so empty folders restore too) */
  dirs: string[]
  errors: { path: string; error: string }[]
  stats: VersionStats
}

/* ------------------------------ browsing ------------------------------ */

export interface BrowseEntry {
  name: string
  /** storePath */
  path: string
  isDir: boolean
  size: number
  mtime: number
  /** dirs: number of files underneath */
  files?: number
  /** files: stored in this version (true) or carried over from an older one */
  changed?: boolean
  /** files: version folder holding the bytes */
  v?: string
}

export interface BrowseResult {
  versionId: string
  dir: string
  /** display form of `dir`, e.g. C:\Users\me */
  display: string
  entries: BrowseEntry[]
  /** where the tree starts when first opened */
  home: string
  totalFiles: number
  totalBytes: number
}

export interface FileHistoryEntry {
  versionId: string
  createdAt: number
  kind: BackupMode
  size: number
  mtime: number
  hash: string
  changed: boolean
}

/* ------------------------------ restore ------------------------------ */

export type OverwritePolicy = 'overwrite' | 'older' | 'skip'

export interface RestoreRequest {
  planId: string
  versionId: string
  /** storePaths of files and/or folders */
  paths: string[]
  /** 'original' = back where they came from; otherwise a folder */
  target: 'original' | 'folder'
  folder?: string
  /** folder target: recreate the full original path (C\Users\…) under the folder */
  keepStructure?: boolean
  overwrite: OverwritePolicy
  /** where to read from: auto = destination, falling back to Google Drive */
  from?: 'auto' | 'local' | 'cloud'
}

/* ------------------------------ jobs / progress ------------------------------ */

export type JobKind = 'backup' | 'restore' | 'validate' | 'cloud'

export type JobPhase = 'queued' | 'connecting' | 'scanning' | 'copying' | 'verifying' | 'cleanup' | 'cloud' | 'done'

export interface JobProgress {
  jobId: string
  kind: JobKind
  planId: string
  planName: string
  phase: JobPhase
  startedAt: number
  filesTotal: number
  filesDone: number
  bytesTotal: number
  bytesDone: number
  current: string
  /** scanning: files seen so far */
  scanned: number
  message: string
  cloudBytesDone: number
  cloudBytesTotal: number
}

export interface QueueState {
  running: JobProgress | null
  queued: { jobId: string; kind: JobKind; planId: string; planName: string }[]
}

export interface HistoryEntry {
  id: string
  kind: JobKind
  planId: string
  planName: string
  versionId: string | null
  mode: BackupMode | null
  trigger: 'manual' | 'schedule' | 'missed' | 'mcp'
  status: RunStatus
  startedAt: number
  endedAt: number
  files: number
  bytes: number
  /** files copied/restored */
  filesDone: number
  bytesDone: number
  message: string
  errors: { path: string; error: string }[]
  errorCount: number
  cloud: 'skipped' | 'success' | 'failed' | null
}

export interface DriveStatus {
  /** File Vault has been set up and is connected */
  connected: boolean
  email: string
}

export interface GlobalSettings {
  /** launch WICKED when the user signs in to Windows (so schedules fire) */
  openAtLogin: boolean
  machine: string
}

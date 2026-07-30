/**
 * A nav "folder" that related modules are filed under. Declared inline by each
 * member module (so adding a module to a group still needs zero shell changes);
 * the shell de-duplicates by `id`. Members are reachable at /g/<group id> and
 * still keep their own /m/<module id> route.
 */
export interface ModuleGroup {
  /** kebab-case unique id; doubles as the folder route (/g/<id>) */
  id: string
  /** folder name shown in the nav and on the home card */
  name: string
  /** lucide-react icon name (PascalCase, e.g. "TrendingUp") */
  icon: string
  /** one-line description for the folder's home card */
  description?: string
  /**
   * Parent folder id for nesting (user-created folders only). Empty / undefined
   * means the folder sits at the top level. Shipped (manifest) folders never
   * nest, so they always omit this.
   */
  parent?: string
}

/** How big the home / folder app tiles render (Settings → Appearance). */
export type CardSize = 'sm' | 'md' | 'lg' | 'xl'

/** Manifest shape for /modules/<id>/module.json */
export interface ModuleManifest {
  /** kebab-case unique id; doubles as the route path and IPC namespace */
  id: string
  /** display name shown in nav tooltip + module header */
  name: string
  /** lucide-react icon name (PascalCase, e.g. "KeyRound") */
  icon: string
  version: string
  description: string
  status: 'stable' | 'beta' | 'external'
  /** optional nav folder this module is filed under */
  group?: ModuleGroup
  /** modules that shell out to an external exe rather than render a full UI */
  external?: {
    /** human-readable name of the wrapped program */
    program: string
    /** true if the wrapped program elevates (UAC) when launched */
    elevated?: boolean
  }
}

/** Whole-app Backup & Restore preferences (Settings → Backup & Restore). */
export interface BackupSettings {
  /** folder backups are written to; '' = the app default (Documents/WICKED-Backups) */
  destination: string
  schedule: {
    enabled: boolean
    /** hours between automatic backups (24 = daily, 168 = weekly) */
    intervalHours: number
  }
  /** how many backups to keep in the destination (older ones are pruned) */
  keep: number
  /** ISO time of the last successful backup (for the scheduler) */
  lastBackupUtc: string
}

export interface ShellSettings {
  theme: 'light' | 'dark' | 'system'
  /** module ids the user has hidden from the nav */
  disabledModules: string[]
  /** module ids hidden from the SIDEBAR only (still shown on the home screen) */
  navHiddenModules: string[]
  update: {
    autoCheck: boolean
    /** hours between background checks */
    intervalHours: number
  }
  /** local MCP server exposing every module's tools to AI agents (localhost only) */
  mcpEnabled: boolean
  /** activity bar shows text labels next to icons when expanded */
  navExpanded: boolean
  /** width (px) of the expanded sidebar; user-draggable */
  navWidth: number
  /** user's custom module order (module ids); ids not listed sort after, by name */
  moduleOrder: string[]
  /**
   * Per-module display overrides set by the user (pencil-edit on home cards).
   * `color` is a stark hex accent for the tile (see CARD_COLORS); unset = default.
   */
  moduleOverrides: Record<string, { name?: string; description?: string; color?: string }>
  /** size of the app tiles on the home + folder screens ('md' = default) */
  cardSize: CardSize
  /** folders the user created on the home screen */
  customGroups: ModuleGroup[]
  /**
   * User's folder assignment per module, overriding the manifest's `group`.
   * '' means "explicitly no folder" (pulled out of its shipped folder).
   */
  moduleGroupOverrides: Record<string, string>
  /** user renames / re-icons for any folder (shipped or custom), by group id */
  groupOverrides: Record<string, { name?: string; icon?: string; description?: string }>
  /** whole-app backup preferences */
  backup: BackupSettings
  /** user-created color themes (Settings → Appearance → Theme studio) */
  customThemes: import('./themes').CustomTheme[]
  /** id of the custom theme in use; '' = built-in light/dark/system */
  activeThemeId: string
}

export const DEFAULT_SETTINGS: ShellSettings = {
  theme: 'system',
  disabledModules: [],
  navHiddenModules: [],
  update: { autoCheck: true, intervalHours: 4 },
  mcpEnabled: false,
  navExpanded: true,
  navWidth: 224,
  moduleOrder: [],
  moduleOverrides: {},
  cardSize: 'md',
  customGroups: [],
  moduleGroupOverrides: {},
  groupOverrides: {},
  backup: {
    destination: '',
    schedule: { enabled: false, intervalHours: 24 },
    keep: 10,
    lastBackupUtc: ''
  },
  customThemes: [],
  activeThemeId: ''
}

/** One backup file in the destination folder. */
export interface BackupInfo {
  file: string
  name: string
  size: number
  modifiedUtc: string
}

export interface BackupResult {
  ok: boolean
  canceled?: boolean
  error?: string
  file?: string
  size?: number
  fileCount?: number
  /** true when a restore was staged and the app is about to relaunch */
  staged?: boolean
  /** restore: the backup carries password-protected API keys and needs the password */
  needPassword?: boolean
  /** backup: whether encrypted API keys were included in the zip */
  keysIncluded?: boolean
}

/**
 * Central API key registry. Keys are entered once in Settings → API Keys,
 * encrypted with Electron safeStorage, and read by module main-process code
 * via ctx.getApiKey(id). Renderers only ever see set/not-set booleans.
 */
export const API_PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', placeholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI (GPT, Whisper)', placeholder: 'sk-…' },
  { id: 'gemini', name: 'Google Gemini', placeholder: 'AIza…' },
  { id: 'deepseek', name: 'DeepSeek', placeholder: 'sk-…' },
  { id: 'massive', name: 'Massive / Polygon (market data)', placeholder: '' },
  { id: 'finnhub', name: 'Finnhub (news + earnings dates)', placeholder: '' },
  { id: 'x', name: 'X / Twitter (Bearer Token — social ticker trends)', placeholder: 'AAAAAAAA… (OAuth 2.0 App-Only Bearer Token)' },
  { id: 'opusclip', name: 'OpusClip — shorts (Automatic Editing)', placeholder: '' },
  { id: 's3-access', name: 'S3 access key (Automatic Editing uploads)', placeholder: '' },
  { id: 's3-secret', name: 'S3 secret key (Automatic Editing uploads)', placeholder: '' }
] as const

export type ApiProviderId = (typeof API_PROVIDERS)[number]['id']

/** Shell-owned IPC channels (modules must namespace their own as `<module-id>:<action>`) */
export const SHELL_IPC = {
  settingsGet: 'shell:settings-get',
  settingsSet: 'shell:settings-set',
  updateCheck: 'shell:update-check',
  updateInstall: 'shell:update-install',
  updatePostpone: 'shell:update-postpone',
  updateEvent: 'shell:update-event',
  openExternal: 'shell:open-external',
  appVersion: 'shell:app-version',
  /** () => Record<ApiProviderId, boolean> — presence only, never values */
  apiKeysStatus: 'shell:apikeys-status',
  /** (id, value) => { ok, error? } */
  apiKeySet: 'shell:apikeys-set',
  /** (id) => void */
  apiKeyClear: 'shell:apikeys-clear',
  /** main → renderer broadcast after any change; payload = status record */
  apiKeysChanged: 'shell:apikeys-changed',
  /** () => McpStatus */
  mcpStatus: 'shell:mcp-status',
  /** (enabled: boolean) => McpStatus */
  mcpSetEnabled: 'shell:mcp-set-enabled',
  /** (moduleId: string) => void — open a module in its own BrowserWindow */
  openModuleWindow: 'shell:open-module-window',
  /** (moduleId: string) => ModuleDataPath[] — a module's file/data locations */
  moduleDataPaths: 'shell:module-data-paths',
  /** () => RecoveryScan — look for user data left by a previous app version */
  recoveryScan: 'shell:recovery-scan',
  /** (sourcePath?: string) => RecoveryScan — scan a user-picked folder */
  recoveryPick: 'shell:recovery-pick',
  /** (sourcePath: string) => RecoveryResult — restore old data, then relaunch */
  recoveryRestore: 'shell:recovery-restore',
  /** () => { destination, isDefaultDestination, backups } — backup config + list */
  backupConfig: 'shell:backup-config',
  /** () => BackupResult — create a backup now in the configured destination */
  backupNow: 'shell:backup-now',
  /** () => { ok, destination?, backups? } — pick the backup destination folder */
  backupPickDestination: 'shell:backup-pick-destination',
  /** (file?: string, password?: string) => BackupResult — restore, then relaunch */
  backupRestore: 'shell:backup-restore',
  /** () => { hasPassword } — is a backup password set (for portable API keys)? */
  backupPasswordStatus: 'shell:backup-password-status',
  /** (password: string) => { ok, error? } — set the backup password */
  backupPasswordSet: 'shell:backup-password-set',
  /** () => void — clear the backup password (keys stop being included) */
  backupPasswordClear: 'shell:backup-password-clear',

  /* ---- Cloud Sync (private GitHub repo) — all device-local, never synced ---- */
  /** () => SyncStatus — current sync config + state (never returns secrets) */
  syncStatus: 'shell:sync-status',
  /** (patch: Partial<SyncConfig>) => SyncStatus — update non-secret sync config */
  syncSetConfig: 'shell:sync-set-config',
  /** ({ token?, passphrase? }) => { ok, error? } — store secrets in the vault (safeStorage) */
  syncSetSecrets: 'shell:sync-set-secrets',
  /** () => void — forget this device's token + passphrase */
  syncClearSecrets: 'shell:sync-clear-secrets',
  /** () => { ok, defaultBranch?, private?, error? } — verify repo access */
  syncTestRepo: 'shell:sync-test-repo',
  /** () => SyncResult — snapshot + encrypt + push to the repo now */
  syncPushNow: 'shell:sync-push-now',
  /** () => SyncResult — download remote manifest to preview a pull (no changes) */
  syncCheckRemote: 'shell:sync-check-remote',
  /** () => SyncResult — pull, stage, and relaunch to apply (destructive: replaces local) */
  syncPullNow: 'shell:sync-pull-now',
  /** () => SyncSnapshotList — list restorable snapshots from the repo history */
  syncListSnapshots: 'shell:sync-list-snapshots',
  /** (commitSha: string) => SyncResult — restore a chosen snapshot (stage + relaunch, destructive) */
  syncRestoreSnapshot: 'shell:sync-restore-snapshot',
  /** main → renderer broadcast of sync activity (SyncStatus payload) */
  syncEvent: 'shell:sync-event',

  /* ------------------------- App lock (device-local) ------------------------ */
  /** () => { enabled: boolean } */
  appLockStatus: 'shell:applock-status',
  /** (pin: string) => { ok, error? } — set/replace the launch PIN */
  appLockSet: 'shell:applock-set',
  /** (pin: string) => { ok } — verify the PIN at the lock screen */
  appLockVerify: 'shell:applock-verify',
  /** (pin: string) => { ok, error? } — turn the lock off (requires the current PIN) */
  appLockClear: 'shell:applock-clear'
} as const

/** Non-secret cloud-sync configuration (device-local; secrets live in the vault). */
export interface SyncConfig {
  /** "owner/name" of the PRIVATE repo used as the sync store */
  repo: string
  /** branch to read/write (default "main") */
  branch: string
  /** push a snapshot automatically on a timer */
  autoPush: boolean
  /** minutes between automatic pushes */
  intervalMinutes: number
  /** push one last snapshot when the app closes */
  pushOnClose: boolean
  /** friendly name for THIS device (shown in conflict warnings) */
  deviceName: string
}

/** The small PLAINTEXT metadata stored next to the encrypted blob in the repo. */
export interface SyncRemoteInfo {
  version: number
  updatedUtc: string
  device: string
  appVersion: string
  sizeBytes: number
  /** whether the push was automatic (schedule/close) or manual; absent on legacy snapshots */
  trigger?: 'auto' | 'manual'
}

export interface SyncStatus extends SyncConfig {
  /** repo + token + passphrase all present → ready to sync */
  configured: boolean
  hasToken: boolean
  hasPassphrase: boolean
  deviceId: string
  lastPushUtc: string
  lastPullUtc: string
  /** version this device last pushed or pulled (for conflict detection) */
  lastSyncedVersion: number
  /** last-known remote metadata (from the newest status/check), or null */
  remote: SyncRemoteInfo | null
  busy: boolean
  error: string
}

export interface SyncResult {
  ok: boolean
  error?: string
  /** true when a pull was staged and the app is about to relaunch */
  staged?: boolean
  /** remote metadata fetched during the operation */
  remote?: SyncRemoteInfo | null
  /** pull preview: remote is newer / same / this device is ahead */
  compare?: 'remote-newer' | 'up-to-date' | 'local-ahead' | 'no-remote'
  version?: number
}

/** One restorable snapshot from the repo's history (a past sync commit). */
export interface SyncSnapshot {
  /** git commit that holds this snapshot's blob + manifest */
  commitSha: string
  /** commit timestamp (ISO); used as the capture time when the manifest lacks one */
  commitDate: string
  version: number
  updatedUtc: string
  device: string
  appVersion: string
  sizeBytes: number
  /** how the snapshot was pushed; "unknown" for legacy snapshots without the stamp */
  trigger: 'auto' | 'manual' | 'unknown'
  /** true if this is the version THIS device last pushed or pulled */
  isCurrent: boolean
}

export interface SyncSnapshotList {
  ok: boolean
  snapshots?: SyncSnapshot[]
  error?: string
}

/** A folder that may hold user data from a previous WICKED version. */
export interface RecoveryCandidate {
  /** absolute path of the previous-version data folder */
  path: string
  /** it carries the WICKED shell's settings file (safe to restore from) */
  hasSettings: boolean
  /** number of per-module data folders found inside `modules/` */
  moduleCount: number
  /** module ids found (for display) */
  moduleIds: string[]
}

export interface RecoveryScan {
  /** the current (pinned) userData folder we would restore INTO */
  currentPath: string
  /** whether the current folder already has settings (restore overwrites it) */
  currentHasSettings: boolean
  /** previous-version data folders found (best first); empty if none */
  candidates: RecoveryCandidate[]
}

export interface RecoveryResult {
  ok: boolean
  canceled?: boolean
  error?: string
  /** where the current data was backed up before overwriting */
  backupPath?: string
  /** the artifacts that were restored */
  restored?: string[]
}

/**
 * One file/data location a module exposes for the Settings → Modules dropdown.
 * A module opts in by registering an IPC handler `<module-id>:data-paths` that
 * returns ModuleDataPath[]. `path: null` renders as "Not Configured Yet".
 */
export interface ModuleDataPath {
  /** what this path is, e.g. "Brain vault", "Projects folder", "Database" */
  label: string
  /** absolute path, or null if the user hasn't configured/created it yet */
  path: string | null
  /** optional one-line hint shown under the path */
  note?: string
}

/** Mirror of the main-process McpStatus (see src/main/mcp/server.ts). */
export interface McpToolInfo {
  module: string
  name: string
  description: string
  destructive: boolean
}

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  toolCount: number
  tools: McpToolInfo[]
}

export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'none' }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

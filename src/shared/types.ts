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
  update: {
    autoCheck: boolean
    /** hours between background checks */
    intervalHours: number
  }
  /** local MCP server exposing every module's tools to AI agents (localhost only) */
  mcpEnabled: boolean
  /** activity bar shows text labels next to icons when expanded */
  navExpanded: boolean
  /** user's custom module order (module ids); ids not listed sort after, by name */
  moduleOrder: string[]
  /** per-module display overrides set by the user (pencil-edit on home cards) */
  moduleOverrides: Record<string, { name?: string; description?: string }>
  /** whole-app backup preferences */
  backup: BackupSettings
}

export const DEFAULT_SETTINGS: ShellSettings = {
  theme: 'system',
  disabledModules: [],
  update: { autoCheck: true, intervalHours: 4 },
  mcpEnabled: false,
  navExpanded: true,
  moduleOrder: [],
  moduleOverrides: {},
  backup: {
    destination: '',
    schedule: { enabled: false, intervalHours: 24 },
    keep: 10,
    lastBackupUtc: ''
  }
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
  /** (file?: string) => BackupResult — restore from a backup, then relaunch */
  backupRestore: 'shell:backup-restore'
} as const

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

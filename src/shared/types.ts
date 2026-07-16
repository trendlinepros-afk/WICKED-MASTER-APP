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
}

export const DEFAULT_SETTINGS: ShellSettings = {
  theme: 'system',
  disabledModules: [],
  update: { autoCheck: true, intervalHours: 4 },
  mcpEnabled: false,
  navExpanded: true,
  moduleOrder: [],
  moduleOverrides: {}
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
  moduleDataPaths: 'shell:module-data-paths'
} as const

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

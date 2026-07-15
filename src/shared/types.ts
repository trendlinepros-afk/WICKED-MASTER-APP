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
}

export const DEFAULT_SETTINGS: ShellSettings = {
  theme: 'system',
  disabledModules: [],
  update: { autoCheck: true, intervalHours: 4 }
}

/** Shell-owned IPC channels (modules must namespace their own as `<module-id>:<action>`) */
export const SHELL_IPC = {
  settingsGet: 'shell:settings-get',
  settingsSet: 'shell:settings-set',
  updateCheck: 'shell:update-check',
  updateInstall: 'shell:update-install',
  updatePostpone: 'shell:update-postpone',
  updateEvent: 'shell:update-event',
  openExternal: 'shell:open-external',
  appVersion: 'shell:app-version'
} as const

export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'none' }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

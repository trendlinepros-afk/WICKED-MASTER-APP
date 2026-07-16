import { create } from 'zustand'

export const ID = 'wicked-optomizzzer'

export type ViewId = 'dashboard' | 'cleaner' | 'services' | 'startup' | 'apps' | 'updates'

/* ---------------------------------- types --------------------------------- */

export interface Drive {
  name: string
  label: string
  total: number
  free: number
}

export interface Dashboard {
  osName: string
  cpuName: string
  cpuCores: number
  cpuLoad: number
  ramTotal: number
  ramUsed: number
  ramPct: number
  uptimeSec: number
  drives: Drive[]
}

export interface CleanCategory {
  key: string
  name: string
  description: string
  systemScope: boolean
  defaultSelected: boolean
  sizeBytes: number
  fileCount: number
}

export interface CleanResult {
  key: string
  name: string
  bytesFreed: number
  itemsRemoved: number
  itemsFailed: number
  outcome: string
}

export interface ServiceItem {
  name: string
  displayName: string
  state: string
  startMode: string
  account: string
  pathName: string
  isMicrosoft: boolean
  isProtected: boolean
}

export interface StartupItem {
  name: string
  command: string
  source: string
  scope: 'Machine' | 'User'
  location: string
  approvedSubkey: string
  approvedValueName: string
  enabled: boolean
}

export interface InstalledApp {
  name: string
  version: string
  publisher: string
  installLocation: string
  uninstallString: string
  quietUninstallString: string
  sizeBytes: number
  scope: 'Machine' | 'User'
  installDate: string
}

export interface AppUpdate {
  name: string
  id: string
  current: string
  available: string
}

type OkErr = { ok: boolean; error?: string; cancelled?: boolean; message?: string }

/* ------------------------------ small helpers ----------------------------- */

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d >= 1) return `${d}d ${h}h ${m}m`
  if (h >= 1) return `${h}h ${m}m`
  return `${m}m`
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>
}

/* ---------------------------------- store --------------------------------- */

interface State {
  view: ViewId

  // dashboard
  dashboard: Dashboard | null
  dashboardBusy: boolean

  // cleaner
  categories: CleanCategory[]
  selected: Record<string, boolean>
  cleanBusy: boolean
  cleanScanBusy: boolean
  cleanResults: CleanResult[] | null

  // services
  services: ServiceItem[]
  servicesBusy: boolean
  serviceActing: string | null

  // startup
  startup: StartupItem[]
  startupBusy: boolean
  startupActing: string | null

  // apps
  apps: InstalledApp[]
  appsBusy: boolean
  appActing: string | null

  // updates
  updates: AppUpdate[]
  updatesBusy: boolean
  updateActing: string | null

  // shared
  notice: { kind: 'ok' | 'err'; text: string } | null
  progress: string

  setView: (v: ViewId) => void
  setNotice: (n: State['notice']) => void

  loadDashboard: () => Promise<void>
  scanCleaner: () => Promise<void>
  toggleCategory: (key: string) => void
  runClean: () => Promise<void>

  loadServices: () => Promise<void>
  setService: (item: ServiceItem, startType: string, stop: boolean) => Promise<void>

  loadStartup: () => Promise<void>
  toggleStartup: (item: StartupItem) => Promise<void>

  loadApps: () => Promise<void>
  uninstallApp: (app: InstalledApp) => Promise<void>

  loadUpdates: () => Promise<void>
  applyUpdate: (id: string | null) => Promise<void>
}

export const useOptimizer = create<State>((set, get) => ({
  view: 'dashboard',

  dashboard: null,
  dashboardBusy: false,

  categories: [],
  selected: {},
  cleanBusy: false,
  cleanScanBusy: false,
  cleanResults: null,

  services: [],
  servicesBusy: false,
  serviceActing: null,

  startup: [],
  startupBusy: false,
  startupActing: null,

  apps: [],
  appsBusy: false,
  appActing: null,

  updates: [],
  updatesBusy: false,
  updateActing: null,

  notice: null,
  progress: '',

  setView: (view) => set({ view, notice: null }),
  setNotice: (notice) => set({ notice }),

  /* ---- dashboard ---- */
  loadDashboard: async () => {
    set({ dashboardBusy: true })
    const res = await invoke<{ ok: boolean; error?: string } & Dashboard>('dashboard')
    if (res.ok) set({ dashboard: res, dashboardBusy: false })
    else set({ dashboardBusy: false, notice: { kind: 'err', text: res.error ?? 'Failed to read system status.' } })
  },

  /* ---- cleaner ---- */
  scanCleaner: async () => {
    set({ cleanScanBusy: true, cleanResults: null })
    const res = await invoke<{ ok: boolean; error?: string; categories?: CleanCategory[] }>('clean-scan')
    if (res.ok && res.categories) {
      const selected = { ...get().selected }
      for (const c of res.categories) if (!(c.key in selected)) selected[c.key] = c.defaultSelected
      set({ categories: res.categories, selected, cleanScanBusy: false })
    } else {
      set({ cleanScanBusy: false, notice: { kind: 'err', text: res.error ?? 'Scan failed.' } })
    }
  },

  toggleCategory: (key) => set((s) => ({ selected: { ...s.selected, [key]: !s.selected[key] } })),

  runClean: async () => {
    const { categories, selected } = get()
    const keys = categories.filter((c) => selected[c.key]).map((c) => c.key)
    if (keys.length === 0) {
      set({ notice: { kind: 'err', text: 'Select at least one category to clean.' } })
      return
    }
    set({ cleanBusy: true, notice: null, cleanResults: null })
    const res = await invoke<OkErr & { results?: CleanResult[] }>('clean', keys)
    set({ cleanBusy: false, progress: '' })
    if (res.ok && res.results) {
      const freed = res.results.reduce((n, r) => n + r.bytesFreed, 0)
      set({
        cleanResults: res.results,
        notice: { kind: 'ok', text: `Cleaned — freed ${fmtBytes(freed)}.` }
      })
      await get().scanCleaner()
    } else {
      set({ notice: { kind: 'err', text: res.error ?? 'Cleaning failed.' } })
    }
  },

  /* ---- services ---- */
  loadServices: async () => {
    set({ servicesBusy: true })
    const res = await invoke<{ ok: boolean; error?: string; services?: ServiceItem[] }>('list-services')
    if (res.ok && res.services) set({ services: res.services, servicesBusy: false })
    else set({ servicesBusy: false, notice: { kind: 'err', text: res.error ?? 'Failed to list services.' } })
  },

  setService: async (item, startType, stop) => {
    set({ serviceActing: item.name, notice: null })
    const res = await invoke<OkErr>('set-service', { name: item.name, startType, stop })
    set({ serviceActing: null, progress: '' })
    if (res.ok) {
      set({ notice: { kind: 'ok', text: `${item.displayName}: ${res.message ?? 'updated'}.` } })
      await get().loadServices()
    } else if (!res.cancelled) {
      set({ notice: { kind: 'err', text: res.error ?? 'Change failed.' } })
    } else {
      set({ notice: { kind: 'err', text: res.error ?? 'Cancelled.' } })
    }
  },

  /* ---- startup ---- */
  loadStartup: async () => {
    set({ startupBusy: true })
    const res = await invoke<{ ok: boolean; error?: string; items?: StartupItem[] }>('list-startup')
    if (res.ok && res.items) set({ startup: res.items, startupBusy: false })
    else set({ startupBusy: false, notice: { kind: 'err', text: res.error ?? 'Failed to list startup items.' } })
  },

  toggleStartup: async (item) => {
    set({ startupActing: item.approvedValueName, notice: null })
    const res = await invoke<OkErr>('set-startup', {
      scope: item.scope,
      approvedSubkey: item.approvedSubkey,
      approvedValueName: item.approvedValueName,
      enabled: !item.enabled
    })
    set({ startupActing: null, progress: '' })
    if (res.ok) {
      set({ notice: { kind: 'ok', text: `${item.name}: ${res.message ?? 'updated'}.` } })
      await get().loadStartup()
    } else if (!res.cancelled) {
      set({ notice: { kind: 'err', text: res.error ?? 'Change failed.' } })
    }
  },

  /* ---- apps ---- */
  loadApps: async () => {
    set({ appsBusy: true })
    const res = await invoke<{ ok: boolean; error?: string; apps?: InstalledApp[] }>('list-apps')
    if (res.ok && res.apps) set({ apps: res.apps, appsBusy: false })
    else set({ appsBusy: false, notice: { kind: 'err', text: res.error ?? 'Failed to list apps.' } })
  },

  uninstallApp: async (app) => {
    set({ appActing: app.name, notice: null })
    const res = await invoke<OkErr>('uninstall-app', {
      name: app.name,
      uninstallString: app.uninstallString,
      quietUninstallString: app.quietUninstallString
    })
    set({ appActing: null, progress: '' })
    if (res.ok) {
      set({ notice: { kind: 'ok', text: `${app.name}: ${res.message ?? 'removed'}.` } })
      await get().loadApps()
    } else if (!res.cancelled) {
      set({ notice: { kind: 'err', text: res.error ?? 'Uninstall failed.' } })
    }
  },

  /* ---- updates ---- */
  loadUpdates: async () => {
    set({ updatesBusy: true })
    const res = await invoke<{ ok: boolean; error?: string; updates?: AppUpdate[] }>('list-updates')
    if (res.ok && res.updates) set({ updates: res.updates, updatesBusy: false })
    else set({ updatesBusy: false, notice: { kind: 'err', text: res.error ?? 'Failed to check for updates.' } })
  },

  applyUpdate: async (id) => {
    set({ updateActing: id ?? '*all*', notice: null })
    const res = await invoke<OkErr>('apply-updates', id ? { id } : { all: true })
    set({ updateActing: null, progress: '' })
    if (res.ok) {
      set({ notice: { kind: 'ok', text: res.message ?? 'Update completed.' } })
      await get().loadUpdates()
    } else if (!res.cancelled) {
      set({ notice: { kind: 'err', text: res.error ?? 'Update failed.' } })
    }
  }
}))

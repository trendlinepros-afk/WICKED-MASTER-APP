import { create } from 'zustand'
import type { HistoryItem, HotkeyStatus, MachineSettings, Paths, RecState, RenderJob, ScreenInfo, SessionView, Settings, AreaMode, Frac } from './types'
import { DEFAULT_MACHINE, DEFAULT_SETTINGS } from './lib/defaults'

export const ID = 'screen-rec'
export const inv = (action: string, ...args: unknown[]): Promise<unknown> => window.wicked.invoke(`${ID}:${action}`, ...args)

export type Tab = 'session' | 'render' | 'videos' | 'settings'

export interface ScreensView {
  screens: ScreenInfo[]
  defaultScreenId: string
  areas: Record<string, { mode: AreaMode; frac: Frac; text: string }>
}

export type HistoryRow = HistoryItem & { exists: boolean }

interface SettingsView {
  settings: Settings
  machine: MachineSettings
  hotkey: HotkeyStatus
  paths: Paths
}

interface State {
  ready: boolean
  tab: Tab
  rec: RecState | null
  session: SessionView | null
  job: RenderJob | null
  settings: Settings
  machine: MachineSettings
  hotkey: HotkeyStatus
  paths: Paths
  screens: ScreensView | null
  history: HistoryRow[]
  toast: { kind: 'ok' | 'err' | 'warn'; text: string } | null

  init: () => Promise<() => void>
  setTab: (t: Tab) => void
  loadScreens: () => Promise<void>
  loadHistory: () => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<{ ok: boolean; error?: string }>
  saveMachine: (patch: Partial<MachineSettings>) => Promise<void>
  showToast: (kind: 'ok' | 'err' | 'warn', text: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useRec = create<State>((set, get) => ({
  ready: false,
  tab: 'session',
  rec: null,
  session: null,
  job: null,
  settings: DEFAULT_SETTINGS,
  machine: DEFAULT_MACHINE,
  hotkey: { accelerator: DEFAULT_SETTINGS.hotkey, enabled: true, registered: false, error: '' },
  paths: { rawDir: '', outputDir: '', dataDir: '' },
  screens: null,
  history: [],
  toast: null,

  init: async () => {
    const st = (await inv('status')) as { state: RecState; session: SessionView | null; job: RenderJob | null } & SettingsView
    set({ ready: true, rec: st.state, session: st.session, job: st.job, settings: st.settings, machine: st.machine, hotkey: st.hotkey, paths: st.paths })
    void get().loadScreens()
    const offs = [
      window.wicked.on(`${ID}:state`, (v) => {
        const rec = v as RecState
        set({ rec, hotkey: rec.hotkey })
      }),
      window.wicked.on(`${ID}:session`, (v) => set({ session: v as SessionView | null })),
      window.wicked.on(`${ID}:render`, (v) => {
        const job = v as RenderJob | null
        const prev = get().job
        set({ job })
        if (job?.phase === 'done' && prev?.phase !== 'done') void get().loadHistory()
      }),
      window.wicked.on(`${ID}:settings`, (v) => {
        const sv = v as SettingsView
        set({ settings: sv.settings, machine: sv.machine, hotkey: sv.hotkey, paths: sv.paths })
        void get().loadScreens()
      }),
      window.wicked.on(`${ID}:screens`, () => void get().loadScreens())
    ]
    return () => offs.forEach((f) => f())
  },

  setTab: (tab) => {
    set({ tab })
    if (tab === 'videos') void get().loadHistory()
    if (tab === 'settings') void get().loadScreens()
  },

  loadScreens: async () => set({ screens: (await inv('screens')) as ScreensView }),
  loadHistory: async () => set({ history: (await inv('history')) as HistoryRow[] }),

  saveSettings: async (patch) => {
    const r = (await inv('settings-set', patch)) as { ok: boolean; error?: string } & SettingsView
    set({ settings: r.settings, machine: r.machine, hotkey: r.hotkey, paths: r.paths })
    return { ok: r.ok, error: r.error }
  },
  saveMachine: async (patch) => {
    const r = (await inv('machine-set', patch)) as SettingsView
    set({ settings: r.settings, machine: r.machine, hotkey: r.hotkey, paths: r.paths })
    void get().loadScreens()
  },

  showToast: (kind, text) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { kind, text } })
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'ok' ? 3500 : 7000)
  }
}))

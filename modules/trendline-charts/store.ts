import { create } from 'zustand'

/** Trendline Charts UI state. All network/secret work happens in main (ipc.ts);
 *  the renderer only ever holds finished PNGs (data URLs) and booleans. */

export const ID = 'trendline-charts'

export const HORIZONS = [
  { id: '30d', label: '30d', hint: 'gold' },
  { id: '90d', label: '90d', hint: 'blue' },
  { id: '6mo', label: '6mo', hint: 'green' },
  { id: '1y', label: '1y', hint: 'red' }
] as const

export const INTERVALS = ['15m', '30m', '1h', '4h', '1d'] as const

type Res = { ok: boolean; error?: string }

function invoke<T = Res>(channel: string, ...args: unknown[]): Promise<T> {
  return window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>
}

export interface ChartImage {
  dataUrl: string
  spanDays: string
  horizons: string
  ticker: string
}

export interface Recent {
  ticker: string
  horizons: string[]
  interval: string
  at: number
}

interface State {
  hasKey: boolean | null
  healthBusy: boolean
  healthMsg: string
  healthOk: boolean | null

  ticker: string
  horizons: string[]
  interval: string
  width: number
  height: number
  branding: boolean

  busy: boolean
  error: string
  image: ChartImage | null

  saving: boolean
  savedMsg: string

  recents: Recent[]

  loadStatus: () => Promise<void>
  checkHealth: () => Promise<void>
  setTicker: (v: string) => void
  toggleHorizon: (id: string) => void
  setInterval: (v: string) => void
  setWidth: (v: number) => void
  setHeight: (v: number) => void
  setBranding: (v: boolean) => void
  fetchChart: () => Promise<void>
  saveChart: () => Promise<void>
  loadRecents: () => Promise<void>
  clearRecents: () => Promise<void>
  applyRecent: (r: Recent) => Promise<void>
  dismissError: () => void
}

export const useTrendlineCharts = create<State>((set, get) => ({
  hasKey: null,
  healthBusy: false,
  healthMsg: '',
  healthOk: null,

  ticker: '',
  horizons: ['30d', '90d', '6mo', '1y'],
  interval: '4h',
  width: 1200,
  height: 640,
  branding: true,

  busy: false,
  error: '',
  image: null,

  saving: false,
  savedMsg: '',

  recents: [],

  loadStatus: async () => {
    const res = await invoke<Res & { hasKey?: boolean }>('status')
    if (res.ok) set({ hasKey: !!res.hasKey })
  },

  checkHealth: async () => {
    if (get().healthBusy) return
    set({ healthBusy: true, healthMsg: '', healthOk: null })
    try {
      const res = await invoke<Res & { keyName?: string }>('health')
      if (res.ok) set({ healthOk: true, healthMsg: res.keyName ? `Connected — key "${res.keyName}".` : 'Connected.' })
      else set({ healthOk: false, healthMsg: res.error ?? 'Health check failed.' })
    } finally {
      set({ healthBusy: false })
    }
  },

  setTicker: (v) => set({ ticker: v }),
  toggleHorizon: (id) =>
    set((s) => {
      const on = s.horizons.includes(id)
      // Keep canonical order and never let the user clear every horizon.
      const next = on ? s.horizons.filter((h) => h !== id) : [...s.horizons, id]
      const ordered = HORIZONS.map((h) => h.id).filter((h) => next.includes(h))
      return { horizons: ordered.length ? ordered : s.horizons }
    }),
  setInterval: (v) => set({ interval: v }),
  setWidth: (v) => set({ width: v }),
  setHeight: (v) => set({ height: v }),
  setBranding: (v) => set({ branding: v }),

  fetchChart: async () => {
    const { ticker, horizons, interval, width, height, branding, busy } = get()
    const t = ticker.trim().toUpperCase()
    if (!t || busy) return
    set({ busy: true, error: '', savedMsg: '' })
    try {
      const res = await invoke<Res & ChartImage>('chart', { ticker: t, horizons, interval, width, height, branding })
      if (res.ok) {
        set({ image: { dataUrl: res.dataUrl, spanDays: res.spanDays, horizons: res.horizons, ticker: res.ticker } })
        void get().loadRecents()
      } else {
        set({ error: res.error ?? 'Could not load the chart.' })
      }
    } finally {
      set({ busy: false })
    }
  },

  saveChart: async () => {
    const { image, saving } = get()
    if (!image || saving) return
    set({ saving: true, error: '', savedMsg: '' })
    try {
      const res = await invoke<Res & { file?: string }>('save', { ticker: image.ticker, data: image.dataUrl })
      if (res.ok) set({ savedMsg: `Saved to ${res.file}` })
      else set({ error: res.error ?? 'Could not save the chart.' })
    } finally {
      set({ saving: false })
    }
  },

  loadRecents: async () => {
    const res = await invoke<Res & { rows?: Recent[] }>('recents')
    if (res.ok) set({ recents: res.rows ?? [] })
  },

  clearRecents: async () => {
    await invoke('recents-clear')
    set({ recents: [] })
  },

  applyRecent: async (r) => {
    set({ ticker: r.ticker, horizons: r.horizons.length ? r.horizons : get().horizons, interval: r.interval })
    await get().fetchChart()
  },

  dismissError: () => set({ error: '' })
}))

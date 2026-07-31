import { create } from 'zustand'
import type { ReportSpec } from './ipc/report'

export const ID = 'stock-planner'

export type Step = 'find' | 'analysis' | 'trendlines' | 'summary'

export interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  at: number
  images?: number
}

export interface StockDoc {
  ticker: string
  company: string
  report: ReportSpec | null
  chat: ChatMsg[]
  images: string[]
  updatedAt: number
}

export interface TickerData {
  symbol: string
  details: {
    name: string
    description: string
    homepage: string
    sector: string
    listDate: string
    marketCap: number | null
    employees: number | null
  } | null
  quote: { price: number | null; volume: number | null; change: number | null; changePct: number | null }
  pe: number | null
  revenue: number | null
  netIncome: number | null
  /** Sector: Polygon SIC first, Yahoo assetProfile fallback (covers foreign ADRs). */
  sector: string | null
  earnings: { date: string; isEstimate: boolean; source: string } | null
  news: { title: string; url: string; source: string; publishedAt: string }[]
}

export interface ScreenerRow {
  symbol: string
  price: number
  changePct: number
  volume: number
}

export interface IpoRow {
  ticker: string
  name: string
  listingDate: string
  status: string
}

interface Status {
  hasMassive: boolean
  hasFinnhub: boolean
  hasAi: boolean
  session: string
}

interface Ok {
  ok: true
  [k: string]: unknown
}
interface Err {
  ok: false
  error?: string
}
type Res = Ok | Err

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

export type ScreenerKind = 'premarket' | 'afterhours' | 'daily' | 'p7' | 'p30' | 'p182' | 'p365' | 'ipos'

interface State {
  status: Status | null
  step: Step
  chatOpen: boolean

  // find
  query: string
  searching: boolean
  hits: { ticker: string; name: string }[]
  screenerKind: ScreenerKind
  screenerRows: ScreenerRow[]
  screenerNote: string
  screenerBusy: boolean
  ipoRows: IpoRow[]
  compareInput: string
  compareRows: TickerData[]
  compareBusy: boolean

  // analysis
  ticker: string
  doc: StockDoc | null
  data: TickerData | null
  dataBusy: boolean
  reportBusy: boolean

  // chat
  chatInput: string
  chatImages: string[]
  chatBusy: boolean

  exporting: boolean
  error: string
  statusMsg: string

  setStep: (s: Step) => void
  setChatOpen: (v: boolean) => void
  setQuery: (v: string) => void
  setCompareInput: (v: string) => void
  setChatInput: (v: string) => void
  addChatImage: (dataUrl: string) => void
  clearChatImages: () => void
  dismissError: () => void

  loadStatus: () => Promise<void>
  search: () => Promise<void>
  runScreener: (kind: ScreenerKind) => Promise<void>
  runCompare: () => Promise<void>
  startAnalysis: (ticker: string) => Promise<void>
  refreshData: () => Promise<void>
  generateReport: () => Promise<void>
  analyzeTrendlines: () => Promise<void>
  addImages: (dataUrls: string[]) => Promise<void>
  removeImage: (index: number) => Promise<void>
  sendChat: () => Promise<void>
  setExporting: (v: boolean) => void
  setError: (v: string) => void
}

export const useStockPlanner = create<State>((set, get) => ({
  status: null,
  step: 'find',
  chatOpen: true,

  query: '',
  searching: false,
  hits: [],
  screenerKind: 'daily',
  screenerRows: [],
  screenerNote: '',
  screenerBusy: false,
  ipoRows: [],
  compareInput: '',
  compareRows: [],
  compareBusy: false,

  ticker: '',
  doc: null,
  data: null,
  dataBusy: false,
  reportBusy: false,

  chatInput: '',
  chatImages: [],
  chatBusy: false,

  exporting: false,
  error: '',
  statusMsg: 'Find a stock to analyze.',

  setStep: (s) => set({ step: s }),
  setChatOpen: (v) => set({ chatOpen: v }),
  setQuery: (v) => set({ query: v }),
  setCompareInput: (v) => set({ compareInput: v }),
  setChatInput: (v) => set({ chatInput: v }),
  addChatImage: (dataUrl) =>
    set((s) => (s.chatImages.length >= 4 ? s : { chatImages: [...s.chatImages, dataUrl] })),
  clearChatImages: () => set({ chatImages: [] }),
  dismissError: () => set({ error: '' }),
  setExporting: (v) => set({ exporting: v }),
  setError: (v) => set({ error: v }),

  loadStatus: async () => {
    const res = await invoke<Res & Status>('status')
    if (res.ok) set({ status: res as unknown as Status })
  },

  search: async () => {
    const q = get().query.trim()
    if (!q || get().searching) return
    set({ searching: true, error: '' })
    try {
      const res = await invoke<Res & { hits?: { ticker: string; name: string }[] }>('search', q)
      if (res.ok) set({ hits: res.hits ?? [] })
      else set({ error: (res as Err).error ?? 'Search failed.' })
    } finally {
      set({ searching: false })
    }
  },

  runScreener: async (kind) => {
    if (get().screenerBusy) return
    set({ screenerBusy: true, screenerKind: kind, screenerRows: [], ipoRows: [], screenerNote: '', error: '' })
    try {
      if (kind === 'ipos') {
        const res = await invoke<Res & { rows?: IpoRow[] }>('ipos')
        if (res.ok) set({ ipoRows: res.rows ?? [] })
        else set({ error: (res as Err).error ?? 'IPO lookup failed.' })
        return
      }
      const days = kind === 'p7' ? 7 : kind === 'p30' ? 30 : kind === 'p182' ? 182 : kind === 'p365' ? 365 : undefined
      const req = days ? { kind: 'period', days } : { kind }
      const res = await invoke<Res & { rows?: ScreenerRow[]; reason?: string }>('screener', req)
      if (!res.ok) {
        // session-gated screeners come back ok:false with a friendly reason
        const reason = (res as { reason?: string }).reason
        if (reason) set({ screenerNote: reason })
        else set({ error: (res as Err).error ?? 'Screener failed.' })
      } else set({ screenerRows: res.rows ?? [], screenerNote: res.reason ?? '' })
    } finally {
      set({ screenerBusy: false })
    }
  },

  runCompare: async () => {
    const syms = get()
      .compareInput.split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (syms.length === 0 || get().compareBusy) return
    set({ compareBusy: true, error: '' })
    try {
      const res = await invoke<Res & { rows?: TickerData[] }>('compare', syms)
      if (res.ok) set({ compareRows: res.rows ?? [] })
      else set({ error: (res as Err).error ?? 'Compare failed.' })
    } finally {
      set({ compareBusy: false })
    }
  },

  startAnalysis: async (tickerRaw) => {
    const ticker = tickerRaw.trim().toUpperCase()
    if (!ticker) return
    set({ ticker, step: 'analysis', doc: null, data: null, statusMsg: `Loading ${ticker}…` })
    const res = await invoke<Res & { doc?: StockDoc }>('doc-get', ticker)
    if (res.ok && res.doc) set({ doc: res.doc })
    await get().refreshData()
    // auto-generate the report card the first time you land (ported behavior)
    if (!(get().doc?.report) && get().status?.hasAi) void get().generateReport()
  },

  refreshData: async () => {
    const { ticker } = get()
    if (!ticker) return
    set({ dataBusy: true })
    try {
      const res = await invoke<Res & { data?: TickerData }>('ticker-data', ticker)
      if (res.ok && res.data) set({ data: res.data, statusMsg: `${ticker} loaded.` })
      else set({ error: (res as Err).error ?? 'Could not load ticker data.' })
    } finally {
      set({ dataBusy: false })
    }
  },

  generateReport: async () => {
    const { ticker, reportBusy } = get()
    if (!ticker || reportBusy) return
    set({ reportBusy: true, error: '', statusMsg: 'Generating AI report card…' })
    try {
      const res = await invoke<Res & { doc?: StockDoc }>('report', ticker)
      if (res.ok && res.doc) set({ doc: res.doc, statusMsg: 'Report ready.' })
      else set({ error: (res as Err).error ?? 'Report failed.', statusMsg: 'Report failed.' })
    } finally {
      set({ reportBusy: false })
    }
  },

  analyzeTrendlines: async () => {
    const { ticker, reportBusy } = get()
    if (!ticker || reportBusy) return
    set({ reportBusy: true, error: '', statusMsg: 'Analyzing trendlines…' })
    try {
      const res = await invoke<Res & { doc?: StockDoc }>('trendlines', ticker)
      if (res.ok && res.doc) set({ doc: res.doc, statusMsg: 'Trendline read added to the report.' })
      else set({ error: (res as Err).error ?? 'Trendline analysis failed.', statusMsg: 'Trendline analysis failed.' })
    } finally {
      set({ reportBusy: false })
    }
  },

  addImages: async (dataUrls) => {
    const { ticker } = get()
    if (!ticker || dataUrls.length === 0) return
    const res = await invoke<Res & { doc?: StockDoc }>('add-images', ticker, dataUrls)
    if (res.ok && res.doc) set({ doc: res.doc })
  },

  removeImage: async (index) => {
    const { ticker } = get()
    if (!ticker) return
    const res = await invoke<Res & { doc?: StockDoc }>('remove-image', ticker, index)
    if (res.ok && res.doc) set({ doc: res.doc })
  },

  sendChat: async () => {
    const { ticker, chatInput, chatImages, chatBusy } = get()
    const message = chatInput.trim()
    if (!ticker || !message || chatBusy) return
    set({ chatBusy: true, error: '', chatInput: '' })
    try {
      const res = await invoke<Res & { doc?: StockDoc }>('chat', { ticker, message, images: chatImages })
      if (res.ok && res.doc) set({ doc: res.doc, chatImages: [] })
      else set({ error: (res as Err).error ?? 'Chat failed.', chatInput: message })
    } finally {
      set({ chatBusy: false })
    }
  }
}))

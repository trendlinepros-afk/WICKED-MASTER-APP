import { create } from 'zustand'
import type { Pick, ScanRecord, TrendRow } from './ipc'
import type { ScreenPlan } from './lib/plan'

export const ID = 'find-trades'

export interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  at: number
  picks?: Pick[]
  plan?: ScreenPlan
  provider?: string
}

interface Status {
  hasMassive: boolean
  hasFinnhub: boolean
  hasAi: boolean
  hasX: boolean
  scanSize?: number
  aiTone?: boolean
  session: string
}

interface Res {
  ok: boolean
  error?: string
  summary?: string
  picks?: Pick[]
  plan?: ScreenPlan
  provider?: string
}

interface TrendingRes {
  ok: boolean
  error?: string
  archiveNeeded?: boolean
  id?: string
  window?: string
  scanSize?: number
  rows?: TrendRow[]
  sampled?: number
  endpoint?: string
  marketValidated?: boolean
  generatedAt?: number
  note?: string
  toneBy?: string
  history?: ScanRecord[]
}

export interface MentionBucket {
  start: string
  count: number
}

export interface MentionCounts {
  ticker: string
  window: string
  buckets: MentionBucket[]
  total: number
  granularity: string
  endpoint: string
  generatedAt: number | null
  note: string
}

interface CountsRes {
  ok: boolean
  error?: string
  archiveNeeded?: boolean
  ticker?: string
  window?: string
  buckets?: MentionBucket[]
  total?: number
  granularity?: string
  endpoint?: string
  generatedAt?: number
  note?: string
}

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

/** Show a saved/fresh scan in the panel (no API call). */
function showRecord(set: (p: Partial<State>) => void, rec: ScanRecord): void {
  set({
    xShownId: rec.id,
    xRows: rec.rows,
    xShownWindow: rec.window,
    xSampled: rec.sampled,
    xEndpoint: rec.endpoint,
    xMarketValidated: rec.marketValidated,
    xGeneratedAt: rec.generatedAt,
    xNote: rec.note,
    xToneBy: rec.toneBy ?? '',
    xError: '',
    xArchiveNeeded: false
  })
}

export interface PresetInfo {
  id: string
  name: string
  desc: string
}

interface State {
  status: Status | null
  chat: ChatMsg[]
  input: string
  busy: boolean
  error: string
  presets: PresetInfo[]

  // "Trending on X" panel — scans are user-triggered, saved to history
  xWindow: string // the window the NEXT scan will use
  xScanSize: number // tweets per scan (100 | 200 | 300)
  xAiTone: boolean // AI tone read (default on) vs keyword lexicon
  xToneBy: string // how the displayed scan read tone
  xRows: TrendRow[] // currently displayed scan
  xShownId: string | null // id of the displayed scan (null = none yet)
  xShownWindow: string // window of the displayed scan
  xBusy: boolean
  xError: string
  xNote: string
  xEndpoint: string
  xSampled: number
  xGeneratedAt: number | null
  xArchiveNeeded: boolean
  xMarketValidated: boolean
  xHistory: ScanRecord[]
  xHistoryLoaded: boolean

  // per-ticker mention history (counts endpoint)
  xCountsTicker: string | null
  xCounts: MentionCounts | null
  xCountsBusy: boolean
  xCountsError: string
  xCountsArchiveNeeded: boolean
  xLookup: string

  setInput: (v: string) => void
  dismissError: () => void
  loadStatus: () => Promise<void>
  send: (text?: string) => Promise<void>
  clear: () => void
  loadPresets: () => Promise<void>
  runPreset: (id: string) => Promise<void>
  setXWindow: (id: string) => void
  setScanSize: (n: number) => Promise<void>
  setAiTone: (on: boolean) => Promise<void>
  loadHistory: () => Promise<void>
  scanTweets: () => Promise<void>
  selectScan: (id: string) => void
  setXLookup: (v: string) => void
  loadMentions: (ticker: string, force?: boolean) => Promise<void>
  closeMentions: () => void
}

export const useFindTrades = create<State>((set, get) => ({
  status: null,
  chat: [],
  input: '',
  busy: false,
  error: '',
  presets: [],

  xWindow: '24h',
  xScanSize: 100,
  xAiTone: true,
  xToneBy: '',
  xRows: [],
  xShownId: null,
  xShownWindow: '24h',
  xBusy: false,
  xError: '',
  xNote: '',
  xEndpoint: '',
  xSampled: 0,
  xGeneratedAt: null,
  xArchiveNeeded: false,
  xMarketValidated: false,
  xHistory: [],
  xHistoryLoaded: false,

  xCountsTicker: null,
  xCounts: null,
  xCountsBusy: false,
  xCountsError: '',
  xCountsArchiveNeeded: false,
  xLookup: '',

  setInput: (v) => set({ input: v }),
  dismissError: () => set({ error: '' }),

  loadStatus: async () => {
    const res = await invoke<Res & Status>('status')
    if (res.ok) {
      const st = res as unknown as Status
      set({ status: st })
      if (typeof st.scanSize === 'number') set({ xScanSize: st.scanSize })
      if (typeof st.aiTone === 'boolean') set({ xAiTone: st.aiTone })
      // Reading saved history is FREE (no API call) — populate the dropdown and
      // show the most recent past scan. Scanning itself is user-triggered.
      if (st.hasX) void get().loadHistory()
    }
    void get().loadPresets()
  },

  loadPresets: async () => {
    const res = await invoke<{ ok: boolean; presets?: PresetInfo[] }>('presets')
    if (res.ok) set({ presets: res.presets ?? [] })
  },

  // A one-click deterministic scan (no AI cost) rendered like a chat answer.
  runPreset: async (id) => {
    if (get().busy) return
    const preset = get().presets.find((p) => p.id === id)
    const label = preset?.name ?? 'Scan'
    const history = [...get().chat, { role: 'user' as const, text: `Scan: ${label}`, at: Date.now() }]
    set({ chat: history, busy: true, error: '' })
    try {
      const res = (await invoke('preset', id)) as Res & { name?: string; note?: string; picks?: Pick[] }
      if (!res.ok) {
        set({ error: res.error ?? 'Scan failed.' })
        return
      }
      const picks = res.picks ?? []
      set({
        chat: [
          ...history,
          {
            role: 'assistant',
            text: picks.length > 0 ? `${res.name ?? label} — ${res.note ?? ''} · ranked by Trade Score.` : `No matches for ${label} right now.`,
            at: Date.now(),
            picks,
            provider: 'Screener (no AI)'
          }
        ]
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ busy: false })
    }
  },

  setXWindow: (id) => {
    // Selecting a window only sets the target for the NEXT scan — no API call.
    if (id !== get().xWindow) set({ xWindow: id })
  },

  setScanSize: async (n) => {
    const size = n === 200 ? 200 : n === 300 ? 300 : 100
    set({ xScanSize: size })
    await invoke('x-set-scan-size', { size })
  },

  setAiTone: async (on) => {
    set({ xAiTone: on })
    await invoke('x-set-ai-tone', { on })
  },

  loadHistory: async () => {
    const res = await invoke<{ ok: boolean; history?: ScanRecord[] }>('x-history')
    if (!res.ok) return
    const history = res.history ?? []
    set({ xHistory: history, xHistoryLoaded: true })
    // show the newest saved scan by default (free) if nothing is displayed yet
    if (history.length > 0 && !get().xShownId) showRecord(set, history[0])
  },

  // The ONLY thing that spends X read credits for trends — user-triggered.
  scanTweets: async () => {
    if (get().xBusy) return
    set({ xBusy: true, xError: '', xArchiveNeeded: false })
    try {
      const res = await invoke<TrendingRes>('x-trending', { window: get().xWindow, force: false })
      if (!res.ok) {
        set({ xError: res.error ?? 'Could not scan X.', xArchiveNeeded: res.archiveNeeded === true })
        return
      }
      if (res.history) set({ xHistory: res.history })
      showRecord(set, {
        id: res.id ?? '',
        window: res.window ?? get().xWindow,
        scanSize: res.scanSize ?? get().xScanSize,
        generatedAt: res.generatedAt ?? Date.now(),
        sampled: res.sampled ?? 0,
        endpoint: res.endpoint ?? '',
        marketValidated: res.marketValidated === true,
        note: res.note ?? '',
        toneBy: res.toneBy,
        rows: res.rows ?? []
      })
    } catch (err) {
      set({ xError: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ xBusy: false })
    }
  },

  selectScan: (id) => {
    const rec = get().xHistory.find((h) => h.id === id)
    if (rec) showRecord(set, rec)
  },

  setXLookup: (v) => set({ xLookup: v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) }),

  loadMentions: async (ticker, force = false) => {
    const t = ticker.trim().toUpperCase().replace(/^\$/, '')
    if (!t) return
    set({ xCountsTicker: t, xCountsBusy: true, xCountsError: '', xCountsArchiveNeeded: false })
    try {
      const res = await invoke<CountsRes>('x-mentions', { ticker: t, window: get().xWindow, force })
      if (!res.ok) {
        set({ xCountsError: res.error ?? 'Could not load mention history.', xCountsArchiveNeeded: res.archiveNeeded === true, xCounts: null })
        return
      }
      set({
        xCounts: {
          ticker: res.ticker ?? t,
          window: res.window ?? get().xWindow,
          buckets: res.buckets ?? [],
          total: res.total ?? 0,
          granularity: res.granularity ?? 'day',
          endpoint: res.endpoint ?? '',
          generatedAt: res.generatedAt ?? null,
          note: res.note ?? ''
        }
      })
    } catch (err) {
      set({ xCountsError: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ xCountsBusy: false })
    }
  },

  closeMentions: () => set({ xCountsTicker: null, xCounts: null, xCountsError: '', xCountsArchiveNeeded: false }),

  send: async (textArg) => {
    const text = (textArg ?? get().input).trim()
    if (!text || get().busy) return
    const history = [...get().chat, { role: 'user' as const, text, at: Date.now() }]
    set({ chat: history, input: '', busy: true, error: '' })
    try {
      const res = await invoke('search', { history: history.map((m) => ({ role: m.role, text: m.text })) })
      if (!res.ok) {
        set({ error: res.error ?? 'Search failed.' })
        return
      }
      set({
        chat: [
          ...history,
          {
            role: 'assistant',
            text: res.summary ?? '',
            at: Date.now(),
            picks: res.picks ?? [],
            plan: res.plan,
            provider: res.provider
          }
        ]
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ busy: false })
    }
  },

  clear: () => set({ chat: [], error: '' })
}))

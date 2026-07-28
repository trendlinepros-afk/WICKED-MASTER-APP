import { create } from 'zustand'
import type { Pick, TrendRow } from './ipc'
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
  window?: string
  rows?: TrendRow[]
  sampled?: number
  endpoint?: string
  marketValidated?: boolean
  generatedAt?: number
  note?: string
}

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

interface State {
  status: Status | null
  chat: ChatMsg[]
  input: string
  busy: boolean
  error: string

  // "Trending on X" panel
  xWindow: string
  xRows: TrendRow[]
  xBusy: boolean
  xError: string
  xNote: string
  xEndpoint: string
  xSampled: number
  xGeneratedAt: number | null
  xArchiveNeeded: boolean
  xMarketValidated: boolean
  xLoaded: boolean

  setInput: (v: string) => void
  dismissError: () => void
  loadStatus: () => Promise<void>
  send: (text?: string) => Promise<void>
  clear: () => void
  setXWindow: (id: string) => void
  loadTrending: (force?: boolean) => Promise<void>
}

export const useFindTrades = create<State>((set, get) => ({
  status: null,
  chat: [],
  input: '',
  busy: false,
  error: '',

  xWindow: '24h',
  xRows: [],
  xBusy: false,
  xError: '',
  xNote: '',
  xEndpoint: '',
  xSampled: 0,
  xGeneratedAt: null,
  xArchiveNeeded: false,
  xMarketValidated: false,
  xLoaded: false,

  setInput: (v) => set({ input: v }),
  dismissError: () => set({ error: '' }),

  loadStatus: async () => {
    const res = await invoke<Res & Status>('status')
    if (res.ok) {
      set({ status: res as unknown as Status })
      if ((res as unknown as Status).hasX) void get().loadTrending(false)
    }
  },

  setXWindow: (id) => {
    if (id === get().xWindow) return
    set({ xWindow: id })
    void get().loadTrending(false)
  },

  loadTrending: async (force = false) => {
    if (get().xBusy) return
    set({ xBusy: true, xError: '' })
    try {
      const res = await invoke<TrendingRes>('x-trending', { window: get().xWindow, force })
      if (!res.ok) {
        set({ xError: res.error ?? 'Could not load trending tickers.', xArchiveNeeded: res.archiveNeeded === true, xRows: [], xLoaded: true })
        return
      }
      set({
        xRows: res.rows ?? [],
        xSampled: res.sampled ?? 0,
        xEndpoint: res.endpoint ?? '',
        xMarketValidated: res.marketValidated === true,
        xGeneratedAt: res.generatedAt ?? null,
        xNote: res.note ?? '',
        xArchiveNeeded: false,
        xLoaded: true
      })
    } catch (err) {
      set({ xError: err instanceof Error ? err.message : String(err), xLoaded: true })
    } finally {
      set({ xBusy: false })
    }
  },

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

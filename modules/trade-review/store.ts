import { create } from 'zustand'
// Shared engines from the Trade Journal — CSV parsing runs client-side
// (ported behavior) and FIFO matching is the same tested implementation.
import { parseBrokerCsv, type Execution } from '../trade-analytics/lib/parse'
import { buildTrades, computeStats, type Stats, type Trade } from '../trade-analytics/lib/analytics'
import type { ReportSpec } from '../stock-planner/ipc/report'

export const ID = 'trade-review'

export interface CoachMsg {
  role: 'user' | 'assistant'
  text: string
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

/** ET calendar date (YYYY-MM-DD) of a fill timestamp. */
export function etYmdOf(t: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(t))
}

/** Plain-text digest of the session for the AI review / coach context. */
export function buildDigest(executions: Execution[], trades: Trade[], stats: Stats): string {
  const fills = executions
    .filter((e) => e.filled)
    .sort((a, b) => (a.filledAt ?? 0) - (b.filledAt ?? 0))
    .map((e) => `${e.filledText || '?'}  ${e.symbol}  ${e.side.toUpperCase()}  ${e.qty} @ $${e.price.toFixed(4)}`)
  const trips = trades
    .filter((t) => !t.isOpen)
    .map(
      (t) =>
        `${t.symbol} ${t.direction} ${t.qty}sh  entry ${t.avgEntry.toFixed(4)} -> exit ${t.avgExit.toFixed(4)}  P&L ${t.realizedPnl >= 0 ? '+' : ''}$${t.realizedPnl.toFixed(2)}`
    )
  const open = trades
    .filter((t) => t.isOpen)
    .map((t) => `${t.symbol} ${t.direction} ${t.openQty}sh @ ${t.avgEntry.toFixed(4)} — STILL OPEN`)
  return [
    `FILLS (${fills.length}):`,
    ...fills,
    '',
    `ROUND TRIPS (${trips.length}):`,
    ...trips,
    '',
    open.length > 0 ? `OPEN POSITIONS:\n${open.join('\n')}` : 'OPEN POSITIONS: none',
    '',
    `SUMMARY: realized ${stats.totalRealized >= 0 ? '+' : ''}$${stats.totalRealized.toFixed(2)} · ${stats.wins}W/${stats.losses}L (${stats.winRate.toFixed(0)}% win) · avg hold ${(stats.avgHoldSeconds / 60).toFixed(0)}m`
  ].join('\n')
}

interface State {
  executions: Execution[]
  trades: Trade[]
  stats: Stats | null
  /** symbols ranked by fill count (drives the tabs) */
  symbols: string[]
  symbol: string
  bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]
  barsBusy: boolean
  report: ReportSpec | null
  reviewBusy: boolean
  coach: CoachMsg[]
  coachInput: string
  coachBusy: boolean
  extracting: boolean
  exporting: boolean
  error: string
  statusMsg: string

  setCoachInput: (v: string) => void
  setSymbol: (s: string) => void
  dismissError: () => void
  setError: (v: string) => void
  setExporting: (v: boolean) => void

  importCsvText: (text: string) => void
  extractScreenshots: (images: string[]) => Promise<void>
  clearAll: () => void
  loadBars: () => Promise<void>
  analyze: () => Promise<void>
  sendCoach: () => Promise<void>
}

export const useTradeReview = create<State>((set, get) => {
  const recompute = (executions: Execution[]): void => {
    const trades = buildTrades(executions)
    const stats = computeStats(trades)
    const counts = new Map<string, number>()
    for (const e of executions) if (e.filled) counts.set(e.symbol, (counts.get(e.symbol) ?? 0) + 1)
    const symbols = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
    const symbol = symbols.includes(get().symbol) ? get().symbol : (symbols[0] ?? '')
    set({ executions, trades, stats, symbols, symbol })
    if (symbol) void get().loadBars()
  }

  return {
    executions: [],
    trades: [],
    stats: null,
    symbols: [],
    symbol: '',
    bars: [],
    barsBusy: false,
    report: null,
    reviewBusy: false,
    coach: [],
    coachInput: '',
    coachBusy: false,
    extracting: false,
    exporting: false,
    error: '',
    statusMsg: 'Import a broker CSV or order screenshots to review a session.',

    setCoachInput: (v) => set({ coachInput: v }),
    dismissError: () => set({ error: '' }),
    setError: (v) => set({ error: v }),
    setExporting: (v) => set({ exporting: v }),

    setSymbol: (s) => {
      set({ symbol: s, bars: [] })
      void get().loadBars()
    },

    importCsvText: (text) => {
      const parsed = parseBrokerCsv(text)
      if (parsed.executions.length === 0) {
        set({ error: 'No order rows found in that CSV — export your order/trade history from your broker.' })
        return
      }
      const seen = new Set(get().executions.map((e) => e.hash))
      const merged = [...get().executions, ...parsed.executions.filter((e) => !seen.has(e.hash))]
      recompute(merged)
      set({ statusMsg: `Loaded ${merged.filter((e) => e.filled).length} filled execution(s).` })
    },

    extractScreenshots: async (images) => {
      if (get().extracting || images.length === 0) return
      set({ extracting: true, error: '', statusMsg: 'Extracting executions from screenshots…' })
      try {
        const res = await invoke<Res & { executions?: Execution[] }>('extract', images)
        if (!res.ok) {
          set({ error: (res as Err).error ?? 'Extraction failed.', statusMsg: 'Extraction failed.' })
          return
        }
        const seen = new Set(get().executions.map((e) => e.hash))
        const merged = [...get().executions, ...(res.executions ?? []).filter((e) => !seen.has(e.hash))]
        recompute(merged)
        set({ statusMsg: `Extracted ${(res.executions ?? []).length} execution(s).` })
      } finally {
        set({ extracting: false })
      }
    },

    clearAll: () =>
      set({
        executions: [],
        trades: [],
        stats: null,
        symbols: [],
        symbol: '',
        bars: [],
        report: null,
        coach: [],
        statusMsg: 'Session cleared.'
      }),

    loadBars: async () => {
      const { symbol, executions } = get()
      if (!symbol) return
      const first = executions
        .filter((e) => e.filled && e.symbol === symbol && e.filledAt != null)
        .sort((a, b) => (a.filledAt ?? 0) - (b.filledAt ?? 0))[0]
      if (!first?.filledAt) return
      set({ barsBusy: true })
      try {
        const res = await invoke<Res & { bars?: State['bars'] }>('candles', {
          symbol,
          ymd: etYmdOf(first.filledAt)
        })
        if (res.ok) set({ bars: res.bars ?? [] })
        else set({ bars: [], error: (res as Err).error ?? '' })
      } finally {
        set({ barsBusy: false })
      }
    },

    analyze: async () => {
      const { executions, trades, stats, symbol, reviewBusy } = get()
      if (reviewBusy || !stats || executions.length === 0) return
      set({ reviewBusy: true, error: '', statusMsg: 'Coach is reviewing the session…' })
      try {
        const res = await invoke<Res & { report?: ReportSpec }>('analyze', {
          digest: buildDigest(executions, trades, stats),
          symbol
        })
        if (res.ok && res.report) set({ report: res.report, statusMsg: 'Review ready.' })
        else set({ error: (res as Err).error ?? 'Review failed.', statusMsg: 'Review failed.' })
      } finally {
        set({ reviewBusy: false })
      }
    },

    sendCoach: async () => {
      const { coachInput, coach, coachBusy, executions, trades, stats } = get()
      const message = coachInput.trim()
      if (!message || coachBusy || !stats) return
      const turns = [...coach, { role: 'user' as const, text: message }]
      set({ coachBusy: true, coach: turns, coachInput: '', error: '' })
      try {
        const res = await invoke<Res & { text?: string }>('chat', {
          messages: turns.slice(-20),
          context: buildDigest(executions, trades, stats)
        })
        if (res.ok && res.text) set({ coach: [...turns, { role: 'assistant', text: res.text }] })
        else set({ error: (res as Err).error ?? 'Coach chat failed.' })
      } finally {
        set({ coachBusy: false })
      }
    }
  }
})

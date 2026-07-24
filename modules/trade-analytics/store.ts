import { create } from 'zustand'
import { buildTrades, computeStats, type Stats, type Trade } from './lib/analytics'
import type { Execution } from './lib/parse'
import { duration, money, pct } from './lib/format'

export const ID = 'trade-analytics'

export type Tab = 'overview' | 'trades' | 'open' | 'symbols' | 'timing' | 'ai'

interface ImportSummary {
  imported: number
  skipped: number
  files: number
}

interface Ok {
  ok: true
  [k: string]: unknown
}
interface Err {
  ok: false
  error?: string
  canceled?: boolean
  cancelled?: boolean
}
type Res = Ok | Err

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

/** Build the compact digest the AI coach analyzes. */
export function buildAiPrompt(stats: Stats, trades: Trade[]): string {
  const top = stats.bySymbol.slice(0, 8).map((s) => `${s.symbol}: ${money(s.realizedPnl)} (${s.trades} trades, ${s.wins}W/${s.losses}L)`)
  const worst = [...stats.bySymbol].reverse().slice(0, 6).map((s) => `${s.symbol}: ${money(s.realizedPnl)}`)
  const dow = stats.byDayOfWeek.map((b) => `${b.label} ${money(b.pnl)}`).join(', ')
  const hours = stats.byHour.map((b) => `${b.label} ${money(b.pnl)}`).join(', ')
  const open = trades
    .filter((t) => t.isOpen)
    .map((t) => `${t.symbol} ${t.direction} ${t.openQty}sh @ ${t.avgEntry.toFixed(2)}`)
    .join('; ')
  return [
    'You are a professional trading coach analyzing a retail trader\'s executed-trade statistics ',
    '(day/swing/trendline trading on Webull). Give sharp, specific, actionable feedback — strengths, ',
    'weaknesses, risk issues, and 3-5 concrete things to change. Be direct and concise. Use the numbers. ',
    'Do NOT give financial/investment advice or tell them what to buy; focus on their PROCESS and stats.\n\n',
    `Realized P&L: ${money(stats.totalRealized)} over ${stats.closedTrades} closed trades\n`,
    `Win rate: ${pct(stats.winRate)} (${stats.wins}W / ${stats.losses}L / ${stats.breakeven}BE)\n`,
    `Avg win ${money(stats.avgWin)}, avg loss ${money(stats.avgLoss)}, profit factor ${stats.profitFactor.toFixed(2)}, expectancy ${money(stats.expectancy)}/trade\n`,
    `Largest win ${money(stats.largestWin)}, largest loss ${money(stats.largestLoss)}\n`,
    `Long: ${money(stats.longPnl)} (${stats.longTrades} trades). Short: ${money(stats.shortPnl)} (${stats.shortTrades} trades)\n`,
    `Avg hold time: ${duration(stats.avgHoldSeconds)}. Max win streak ${stats.maxWinStreak}, max loss streak ${stats.maxLossStreak}\n`,
    `P&L by weekday: ${dow || 'n/a'}\n`,
    `P&L by hour (ET): ${hours || 'n/a'}\n`,
    `Best symbols: ${top.join('; ')}\n`,
    `Worst symbols: ${worst.join('; ')}\n`,
    `Open positions (still holding, no exit yet): ${open || 'none'} — total cost basis ${money(stats.openCostBasis)}\n`
  ].join('')
}

interface State {
  tab: Tab
  loaded: boolean
  executions: Execution[]
  trades: Trade[]
  stats: Stats | null
  importing: boolean
  status: string
  error: string
  lastImport: ImportSummary | null
  dragOver: boolean

  // AI coach
  hasAiKey: boolean
  aiBusy: boolean
  aiText: string
  aiProvider: string
  aiError: string

  setTab: (t: Tab) => void
  dismissError: () => void
  setHasAiKey: (v: boolean) => void
  setDragOver: (v: boolean) => void

  load: () => Promise<void>
  applyExecutions: (executions: Execution[]) => void
  importDialog: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  clearAll: () => Promise<void>
  analyze: () => Promise<void>
  cancelAi: () => Promise<void>
}

export const useTrades = create<State>((set, get) => {
  const recompute = (executions: Execution[]): void => {
    const trades = buildTrades(executions)
    const stats = computeStats(trades)
    set({ executions, trades, stats })
  }

  const handleImport = async (res: Res): Promise<void> => {
    if (res.ok !== true) {
      if (!(res as Err).canceled) set({ error: (res as Err).error ?? 'Import failed.', status: 'Import failed.' })
      return
    }
    const executions = Array.isArray((res as Ok).executions) ? ((res as Ok).executions as Execution[]) : get().executions
    const imported = Number((res as Ok).imported) || 0
    const skipped = Number((res as Ok).skipped) || 0
    const files = Array.isArray((res as Ok).files) ? ((res as Ok).files as unknown[]).length : 1
    recompute(executions)
    set({
      lastImport: { imported, skipped, files },
      status:
        imported > 0
          ? `Imported ${imported} new execution(s)${skipped > 0 ? `, skipped ${skipped} duplicate(s)` : ''}.`
          : `No new executions — all ${skipped} row(s) were already imported.`
    })
  }

  return {
    tab: 'overview',
    loaded: false,
    executions: [],
    trades: [],
    stats: null,
    importing: false,
    status: 'Import your Webull order records to begin.',
    error: '',
    lastImport: null,
    dragOver: false,

    hasAiKey: false,
    aiBusy: false,
    aiText: '',
    aiProvider: '',
    aiError: '',

    setTab: (t) => set({ tab: t }),
    dismissError: () => set({ error: '' }),
    setHasAiKey: (v) => set({ hasAiKey: v }),
    setDragOver: (v) => set({ dragOver: v }),

    load: async () => {
      const res = await invoke('executions')
      if (res.ok === true) recompute((res.executions as Execution[]) ?? [])
      set({ loaded: true })
    },

    applyExecutions: (executions) => recompute(executions),

    importDialog: async () => {
      if (get().importing) return
      set({ importing: true, error: '', status: 'Importing…' })
      try {
        await handleImport(await invoke('import-dialog'))
      } finally {
        set({ importing: false })
      }
    },

    importPaths: async (paths) => {
      if (get().importing || paths.length === 0) return
      set({ importing: true, error: '', status: 'Importing…', dragOver: false })
      try {
        await handleImport(await invoke('import-file', paths))
      } finally {
        set({ importing: false })
      }
    },

    clearAll: async () => {
      if (!window.confirm('Delete ALL imported trade data? This only clears the analytics database — your Webull account is untouched. You can re-import your CSVs anytime.')) return
      set({ importing: true, status: 'Clearing…', error: '' })
      try {
        const res = await invoke('clear')
        if (res.ok !== true) {
          set({ error: res.error ?? 'Could not clear data.' })
          return
        }
        recompute([])
        set({ status: 'All imported trade data cleared.', lastImport: null, aiText: '', aiProvider: '' })
      } finally {
        set({ importing: false })
      }
    },

    analyze: async () => {
      const { stats, trades, aiBusy, hasAiKey } = get()
      if (aiBusy) return
      if (!stats || stats.closedTrades === 0) {
        set({ aiError: 'Import some closed trades first.' })
        return
      }
      if (!hasAiKey) {
        set({ aiError: 'No AI key set. Add an Anthropic, OpenAI, Gemini or DeepSeek key in Settings → API Keys.' })
        return
      }
      set({ aiBusy: true, aiError: '', aiText: '', aiProvider: '' })
      try {
        const res = (await invoke('ai-analyze', { prompt: buildAiPrompt(stats, trades) })) as Res & {
          text?: string
          provider?: string
        }
        if (res.ok !== true) {
          set({ aiError: (res as Err).error ?? 'AI analysis failed.' })
          return
        }
        set({ aiText: String(res.text ?? ''), aiProvider: String(res.provider ?? '') })
      } finally {
        set({ aiBusy: false })
      }
    },

    cancelAi: async () => {
      await invoke('cancel')
    }
  }
})

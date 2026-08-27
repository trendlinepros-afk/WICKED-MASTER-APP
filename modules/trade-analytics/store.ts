import { create } from 'zustand'
import { buildTradesByAccount, computeStats, type Stats, type Trade } from './lib/analytics'
import { computeMetrics, type TradeMetrics } from './lib/metrics'
import type { Execution } from './lib/parse'
import { duration, money, pct } from './lib/format'

export const ID = 'trade-analytics'

export type Tab = 'overview' | 'calendar' | 'trades' | 'open' | 'symbols' | 'timing' | 'stats' | 'breakdown' | 'ai'

export interface Account {
  id: string
  name: string
  createdAt: number
  executions: number
  /** commission+fee applied per contract/share per fill ($); 0 = none */
  feePerContract: number
}

interface ImportSummary {
  imported: number
  updated: number
  skipped: number
  ignored: number
  files: number
}

/** A hand-entered or edited trade (times already resolved to epoch ms). */
export interface TradeDraft {
  /** destination account for the new executions */
  account: string
  /** original account of the fills being replaced (edit/move) */
  fromAccount?: string
  /** hashes of the fills to remove first (edit) */
  deleteHashes?: string[]
  symbol: string
  direction: 'long' | 'short'
  qty: number
  entryPrice: number
  entryAt: number
  /** null = still-open position (no exit) */
  exitPrice: number | null
  exitAt: number | null
  exitQty: number | null
  /** contract point value to keep when editing a futures trade (default 1) */
  multiplier?: number
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
  /** every execution across all accounts (unfiltered) */
  allExecutions: Execution[]
  /** trades/stats/metrics for the CURRENTLY SELECTED accounts */
  executions: Execution[]
  trades: Trade[]
  stats: Stats | null
  metrics: TradeMetrics | null
  importing: boolean
  status: string
  error: string
  lastImport: ImportSummary | null
  dragOver: boolean
  /** fills that (from older builds) live under more than one account — inflates numbers */
  dupExtraCopies: number

  // accounts
  accounts: Account[]
  /** account ids currently shown (multi-select; empty = all) */
  selectedAccounts: string[]
  /** account new imports land in */
  importAccount: string

  // sectors (symbol → broad sector)
  sectors: Record<string, string>
  /** manual per-symbol sector overrides (symbol → sector); these win over auto */
  sectorOverrides: Record<string, string>
  sectorsBusy: boolean
  sectorsHasKey: boolean
  /** when set, the body shows the drill-down page for this market sector */
  sectorFocus: string | null

  // AI coach
  hasAiKey: boolean
  aiBusy: boolean
  aiText: string
  aiProvider: string
  aiError: string

  setTab: (t: Tab) => void
  setSectorFocus: (sector: string | null) => void
  setSector: (symbol: string, sector: string) => Promise<void>
  dismissError: () => void
  setHasAiKey: (v: boolean) => void
  setDragOver: (v: boolean) => void
  setImportAccount: (id: string) => void
  toggleAccount: (id: string) => void
  selectAllAccounts: () => void

  load: () => Promise<void>
  refreshAccounts: () => Promise<void>
  createAccount: (name: string) => Promise<string | null>
  renameAccount: (id: string, name: string) => Promise<void>
  setAccountFee: (id: string, feePerContract: number) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  importDialog: (account?: string) => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  clearAll: (account?: string) => Promise<void>
  auditDuplicates: () => Promise<void>
  fixDuplicates: () => Promise<void>
  saveTrade: (draft: TradeDraft) => Promise<string | null>
  deleteTrade: (account: string, hashes: string[]) => Promise<void>
  loadSectors: () => Promise<void>
  analyze: () => Promise<void>
  cancelAi: () => Promise<void>
}

export const useTrades = create<State>((set, get) => {
  /** Recompute trades/stats/metrics for the current account selection. */
  const recompute = (
    all: Execution[],
    selected: string[] = get().selectedAccounts,
    sectors: Record<string, string> = get().sectors
  ): void => {
    const filtered = selected.length > 0 ? all.filter((e) => selected.includes(e.account || 'default')) : all
    const trades = buildTradesByAccount(filtered)
    const stats = computeStats(trades)
    const metrics = computeMetrics(trades, sectors)
    set({ allExecutions: all, executions: filtered, trades, stats, metrics })
  }

  const handleImport = async (res: Res): Promise<void> => {
    if (res.ok !== true) {
      if (!(res as Err).canceled) set({ error: (res as Err).error ?? 'Import failed.', status: 'Import failed.' })
      return
    }
    const executions = Array.isArray((res as Ok).executions) ? ((res as Ok).executions as Execution[]) : get().allExecutions
    const imported = Number((res as Ok).imported) || 0
    const updated = Number((res as Ok).updated) || 0
    const skipped = Number((res as Ok).skipped) || 0
    const crossSkipped = Number((res as Ok).crossSkipped) || 0
    const ignored = Number((res as Ok).ignored) || 0
    const rowErrors = Number((res as Ok).rowErrors) || 0
    const brokers = Array.isArray((res as Ok).brokers) ? ((res as Ok).brokers as string[]) : []
    const errorSample = Array.isArray((res as Ok).errorSample) ? ((res as Ok).errorSample as string[]) : []
    const files = Array.isArray((res as Ok).files) ? ((res as Ok).files as unknown[]).length : 1
    // Nothing landed AND the file had a problem → surface the reason prominently.
    if (imported === 0 && updated === 0 && skipped === 0 && errorSample.length > 0) {
      set({ error: errorSample[0].replace(/^line \d+:\s*/, '') })
    }
    recompute(executions)
    await get().refreshAccounts()
    void get().loadSectors()
    void get().auditDuplicates()
    const brokerNote = brokers.length === 1 && brokers[0] !== 'CSV' ? ` ${brokers[0]} format detected.` : ''
    const parts: string[] = []
    if (imported > 0) parts.push(`${imported} new execution(s)`)
    if (updated > 0) parts.push(`${updated} updated (order progressed since last export)`)
    if (skipped > 0) parts.push(`${skipped} duplicate(s) skipped`)
    if (ignored > 0) parts.push(`${ignored} non-trade row(s) ignored`)
    if (rowErrors > 0) parts.push(`${rowErrors} unreadable row(s)`)
    if (crossSkipped > 0) parts.push(`${crossSkipped} kept out (already in another account)`)
    set({
      lastImport: { imported, updated, skipped, ignored, files },
      status:
        imported > 0 || updated > 0
          ? `Imported: ${parts.join(' · ')}.${brokerNote}`
          : `No new executions — ${parts.length > 0 ? parts.join(' · ') : 'nothing usable in that file'}.${brokerNote}`
    })
  }

  return {
    tab: 'overview',
    loaded: false,
    allExecutions: [],
    executions: [],
    trades: [],
    stats: null,
    metrics: null,
    importing: false,
    status: 'Import your broker trade history (CSV) to begin.',
    error: '',
    lastImport: null,
    dragOver: false,
    dupExtraCopies: 0,

    accounts: [],
    selectedAccounts: [],
    importAccount: 'default',

    sectors: {},
    sectorOverrides: {},
    sectorsBusy: false,
    sectorsHasKey: false,
    sectorFocus: null,

    hasAiKey: false,
    aiBusy: false,
    aiText: '',
    aiProvider: '',
    aiError: '',

    setTab: (t) => set({ tab: t, sectorFocus: null }),
    setSectorFocus: (sector) => set({ sectorFocus: sector }),
    setSector: async (symbol, sector) => {
      const res = (await invoke('set-sector', { symbol: symbol.trim().toUpperCase(), sector })) as Res & {
        overrides?: Record<string, string>
      }
      if (res.ok === true) {
        set({ sectorOverrides: res.overrides ?? get().sectorOverrides })
        await get().loadSectors() // re-merge overrides + recompute sector metrics
      }
    },
    dismissError: () => set({ error: '' }),
    setHasAiKey: (v) => set({ hasAiKey: v }),
    setDragOver: (v) => set({ dragOver: v }),
    setImportAccount: (id) => set({ importAccount: id }),

    toggleAccount: (id) => {
      const cur = get().selectedAccounts
      const has = cur.includes(id)
      // never allow an empty selection → fall back to all accounts
      const next = has ? cur.filter((x) => x !== id) : [...cur, id]
      set({ selectedAccounts: next })
      recompute(get().allExecutions, next)
    },
    selectAllAccounts: () => {
      set({ selectedAccounts: [] })
      recompute(get().allExecutions, [])
    },

    load: async () => {
      const res = await invoke('executions')
      if (res.ok === true) recompute((res.executions as Execution[]) ?? [], [])
      await get().refreshAccounts()
      void get().loadSectors()
      void get().auditDuplicates()
      set({ loaded: true })
    },

    refreshAccounts: async () => {
      const res = (await invoke('accounts-list')) as Res & { accounts?: Account[] }
      if (res.ok === true) {
        const accounts = res.accounts ?? []
        // keep importAccount valid
        const importAccount = accounts.some((a) => a.id === get().importAccount)
          ? get().importAccount
          : accounts[0]?.id ?? 'default'
        // drop any selected ids that no longer exist
        const validSel = get().selectedAccounts.filter((id) => accounts.some((a) => a.id === id))
        set({ accounts, importAccount, selectedAccounts: validSel })
        if (validSel.length !== get().selectedAccounts.length) recompute(get().allExecutions, validSel)
      }
    },

    createAccount: async (name) => {
      const res = (await invoke('accounts-create', name)) as Res & { id?: string; accounts?: Account[] }
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not create account.' })
        return null
      }
      set({ accounts: res.accounts ?? get().accounts })
      return res.id ?? null
    },

    renameAccount: async (id, name) => {
      const res = (await invoke('accounts-rename', { id, name })) as Res & { accounts?: Account[] }
      if (res.ok === true) set({ accounts: res.accounts ?? get().accounts })
      else set({ error: (res as Err).error ?? 'Could not rename account.' })
    },

    setAccountFee: async (id, feePerContract) => {
      const res = (await invoke('accounts-set-fee', { id, feePerContract })) as Res & {
        accounts?: Account[]
        executions?: Execution[]
      }
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not set the commission.' })
        return
      }
      set({ accounts: res.accounts ?? get().accounts })
      // reprice P&L immediately with the new fee applied
      recompute((res.executions as Execution[]) ?? get().allExecutions)
    },

    deleteAccount: async (id) => {
      const res = (await invoke('accounts-delete', id)) as Res & { accounts?: Account[]; executions?: Execution[] }
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not delete account.' })
        return
      }
      const sel = get().selectedAccounts.filter((x) => x !== id)
      set({ accounts: res.accounts ?? get().accounts, selectedAccounts: sel })
      recompute((res.executions as Execution[]) ?? get().allExecutions, sel)
      await get().refreshAccounts()
    },

    importDialog: async (account) => {
      if (get().importing) return
      const acct = account ?? get().importAccount
      // remember the choice so drag-drop imports follow the same account
      set({ importing: true, error: '', status: 'Importing…', importAccount: acct })
      try {
        await handleImport(await invoke('import-dialog', acct))
      } finally {
        set({ importing: false })
      }
    },

    importPaths: async (paths) => {
      if (get().importing || paths.length === 0) return
      set({ importing: true, error: '', status: 'Importing…', dragOver: false })
      try {
        await handleImport(await invoke('import-file', paths, get().importAccount))
      } finally {
        set({ importing: false })
      }
    },

    clearAll: async (account) => {
      const label = account
        ? `Delete all trade data for this account? Your brokerage account is untouched — you can re-import anytime.`
        : 'Delete ALL imported trade data across every account? This only clears the analytics database — your brokerage account is untouched. You can re-import your CSVs anytime.'
      if (!window.confirm(label)) return
      set({ importing: true, status: 'Clearing…', error: '' })
      try {
        const res = (await invoke('clear', account)) as Res & { executions?: Execution[] }
        if (res.ok !== true) {
          set({ error: (res as Err).error ?? 'Could not clear data.' })
          return
        }
        recompute((res.executions as Execution[]) ?? [])
        await get().refreshAccounts()
        set({ status: account ? 'Account data cleared.' : 'All imported trade data cleared.', lastImport: null, aiText: '', aiProvider: '' })
      } finally {
        set({ importing: false })
      }
    },

    auditDuplicates: async () => {
      const res = (await invoke('dedupe-audit')) as Res & { extraCopies?: number }
      if (res.ok === true) set({ dupExtraCopies: Number(res.extraCopies) || 0 })
    },

    fixDuplicates: async () => {
      set({ importing: true, status: 'Cleaning up cross-account duplicates…', error: '' })
      try {
        const res = (await invoke('dedupe-fix')) as Res & { removed?: number; executions?: Execution[] }
        if (res.ok !== true) {
          set({ error: (res as Err).error ?? 'Cleanup failed.' })
          return
        }
        recompute((res.executions as Execution[]) ?? get().allExecutions)
        await get().refreshAccounts()
        await get().auditDuplicates()
        set({ status: `Removed ${Number(res.removed) || 0} duplicate fill(s) — each trade now lives in a single account.` })
      } finally {
        set({ importing: false })
      }
    },

    saveTrade: async (draft) => {
      const res = (await invoke('trade-save', draft)) as Res & { executions?: Execution[] }
      if (res.ok !== true) {
        const msg = (res as Err).error ?? 'Could not save the trade.'
        set({ error: msg })
        return msg
      }
      recompute((res.executions as Execution[]) ?? get().allExecutions)
      await get().refreshAccounts()
      void get().loadSectors()
      set({ status: draft.deleteHashes && draft.deleteHashes.length > 0 ? 'Trade updated.' : 'Trade added.' })
      return null
    },

    deleteTrade: async (account, hashes) => {
      const res = (await invoke('trade-delete', { account, hashes })) as Res & { executions?: Execution[] }
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not delete the trade.' })
        return
      }
      recompute((res.executions as Execution[]) ?? get().allExecutions)
      await get().refreshAccounts()
      set({ status: 'Trade deleted.' })
    },

    loadSectors: async () => {
      const symbols = [...new Set(get().allExecutions.map((e) => e.symbol))]
      if (symbols.length === 0) return
      set({ sectorsBusy: true })
      try {
        const res = (await invoke('sectors', symbols)) as Res & {
          sectors?: Record<string, string>
          overrides?: Record<string, string>
          hasKey?: boolean
        }
        if (res.ok === true) {
          const sectors = res.sectors ?? {}
          set({ sectors, sectorOverrides: res.overrides ?? {}, sectorsHasKey: !!res.hasKey })
          recompute(get().allExecutions, get().selectedAccounts, sectors)
        }
      } finally {
        set({ sectorsBusy: false })
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

import { create } from 'zustand'
import { buildTradesByAccount, computeStats, type Stats, type Trade } from './lib/analytics'
import { computeMetrics, type TradeMetrics } from './lib/metrics'
import { filterTradesToRange, resolveRange, type RangePreset } from './lib/range'
import type { Execution } from './lib/parse'
import { buildChatContext } from './lib/chat-context'
import { chatToHtml, chatToMarkdown, reportToHtml, tradingReportMarkdown } from './lib/chat-export'
import { freezeCharts, stripChartData, type ChartInputs } from './lib/chat-charts'
import { pdfDirective } from './lib/rich-text'

export const ID = 'trade-analytics'

export type Tab = 'overview' | 'calendar' | 'trades' | 'open' | 'symbols' | 'timing' | 'stats' | 'breakdown' | 'ai'

export interface Account {
  id: string
  name: string
  createdAt: number
  executions: number
  /** commission+fee applied per contract/share per fill ($); 0 = none */
  feePerContract: number
  /** the trader's own strategy description — grounds the AI coach's analysis */
  strategy: string
  /** archived: kept, but left out of "All accounts" until checked explicitly */
  archived?: boolean
  archivedAt?: number
}

/** Accounts that "All accounts" covers (everything that isn't archived). */
export function activeAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.archived)
}

/** The accounts in view: the explicit selection, or every active account when nothing is picked. */
export function viewedAccounts(accounts: Account[], selected: string[]): Account[] {
  return selected.length > 0 ? accounts.filter((a) => selected.includes(a.id)) : activeAccounts(accounts)
}

/** "All accounts", one name, or the names in view — for chat / report scope lines. */
export function scopeLabel(accounts: Account[], selected: string[], rangeLabel: string): string {
  const viewed = viewedAccounts(accounts, selected)
  const who = selected.length === 0 && activeAccounts(accounts).length > 1 ? 'All accounts' : viewed.map((a) => a.name).join(', ')
  return `${who} · ${rangeLabel || 'Lifetime'}`
}

/** "Export Account Summary" request (PDF; built in main via printHtmlToPdf). */
export interface SummaryExportReq {
  /** account ids to combine into one report ([] = all accounts) */
  accounts: string[]
  preset: RangePreset
  startYmd?: string
  endYmd?: string
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

/** One message in an AI Coach chat. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** set when the reply failed or was stopped (content = whatever arrived) */
  error?: string
  provider?: string
  /** the reply hit the model's length limit — offer "Continue" */
  truncated?: boolean
  /** still streaming */
  pending?: boolean
  /** what the chat shows instead of the raw prompt (e.g. "Analyze my trading") */
  display?: string
  /** this turn is (or answers) an "Analyze my trading" request */
  kind?: 'analysis'
  /** the PDF this reply was turned into (an "@pdf" reply, or saved from the bubble) */
  pdf?: { file: string; name: string }
  pdfError?: string
}

/** Options for one chat turn. */
export interface SendOpts {
  /** show this in the bubble instead of the prompt text */
  display?: string
  kind?: 'analysis'
  /** title for a conversation this turn starts */
  title?: string
}

/** The request "Analyze my trading" sends into the chat. */
export const ANALYZE_PROMPT = [
  'Analyze my trading in full, like a coach reviewing my journal. Use this structure:',
  '## Overview — 2–3 sentences with the headline numbers, then the summary stat tiles chart.',
  '## What’s working — strengths, with evidence (trades, $, win rates).',
  '## Leaks — the biggest problems costing me money, each with its $ impact and specific trades.',
  '## Risk & discipline — sizing, tilt after losses, stops, streaks, fees.',
  '## Process fixes — 3–5 concrete, measurable rules for next week.',
  '## The guide — one line each: **Do:**, **Don’t:**, **Watch for:**.',
  'Back the points with charts from the journal where they help (for example the equity curve, P&L by hour or 15-minute slot, by weekday, by hold time, by symbol, wins vs losses, fees). Be direct and specific.'
].join('\n')

/** A saved coach conversation, as listed in the chat history rail. */
export interface ChatSummary {
  id: string
  title: string
  /** accounts · date range when the chat started */
  scope: string
  createdAt: number
  updatedAt: number
  count: number
}

export const CONTINUE_PROMPT = 'Continue exactly where you stopped — don’t repeat what you already wrote.'

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

  // global date-range filter (applies to every tab; closed trades only —
  // open positions always show). Same presets as the summary export.
  rangePreset: RangePreset
  rangeStartYmd: string
  rangeEndYmd: string
  /** resolved display label, e.g. "1 month · Aug 3 – Sep 1, 2026" */
  rangeLabel: string

  // per-day journal notes (Calendar view), scoped PER ACCOUNT.
  // allDayNotes: account → date → text (everything). dayNotes: the derived view
  // for the accounts currently selected. notesAccount: the single account new
  // notes write to (null when All/multiple are in view → notes are read-only).
  allDayNotes: Record<string, Record<string, string>>
  dayNotes: Record<string, string>
  notesAccount: string | null

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
  /** the latest "Analyze my trading" reply this session (for the report PDF) */
  aiText: string
  aiError: string
  /** id of the reply whose PDF is being made */
  pdfBusyId: string | null

  // AI coach chat — saved per conversation in trades.db (history rail)
  chat: ChatMessage[]
  chatBusy: boolean
  /** id of the conversation on screen (null = a new, not-yet-saved chat) */
  activeChatId: string | null
  activeChatTitle: string
  activeChatScope: string
  activeChatCreatedAt: number
  chats: ChatSummary[]

  // account-summary PDF export
  exportingSummary: boolean

  setTab: (t: Tab) => void
  setSectorFocus: (sector: string | null) => void
  setSector: (symbol: string, sector: string) => Promise<void>
  dismissError: () => void
  setHasAiKey: (v: boolean) => void
  setDragOver: (v: boolean) => void
  setImportAccount: (id: string) => void
  toggleAccount: (id: string) => void
  selectAllAccounts: () => void
  setAccountArchived: (id: string, archived: boolean) => Promise<void>
  setRange: (preset: RangePreset, startYmd?: string, endYmd?: string) => void
  loadNotes: () => Promise<void>
  setDayNote: (date: string, text: string) => Promise<void>

  load: () => Promise<void>
  refreshAccounts: () => Promise<void>
  createAccount: (name: string) => Promise<string | null>
  renameAccount: (id: string, name: string) => Promise<void>
  setAccountFee: (id: string, feePerContract: number) => Promise<void>
  setAccountStrategy: (id: string, strategy: string) => Promise<void>
  exportSummary: (req: SummaryExportReq) => Promise<boolean>
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
  sendChat: (text: string, opts?: SendOpts) => Promise<void>
  stopChat: () => Promise<void>
  /** start a fresh conversation (the current one stays in history) */
  clearChat: () => void
  loadChats: () => Promise<void>
  openChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  exportChat: (format: 'pdf' | 'md') => Promise<string | null>
  /** save one coach reply (and its continuations) as a colour PDF */
  replyPdf: (id: string) => Promise<string | null>
  openPdf: (file: string, reveal?: boolean) => Promise<void>
  /** the AI Coach tab's "Export PDF": stats + charts + the latest analysis */
  exportReport: () => Promise<string | null>
  /** what source charts are drawn from (the journal in view) */
  chartInputs: () => ChartInputs | null
}

/** A reply plus any "Continue" replies that followed it, as one text. */
export function replyChainOf(chat: ChatMessage[], id: string): { content: string; ids: string[] } {
  let i = chat.findIndex((m) => m.id === id)
  if (i < 0) return { content: '', ids: [] }
  // walk back to the first part (a continuation's prompt is CONTINUE_PROMPT)
  while (i >= 2 && chat[i - 1]?.role === 'user' && chat[i - 1].content === CONTINUE_PROMPT && chat[i - 2]?.role === 'assistant') i -= 2
  const ids: string[] = []
  const parts: string[] = []
  for (let k = i; k < chat.length; k += 2) {
    const m = chat[k]
    if (!m || m.role !== 'assistant') break
    ids.push(m.id)
    parts.push(m.content)
    const next = chat[k + 1]
    if (!next || next.role !== 'user' || next.content !== CONTINUE_PROMPT) break
  }
  return { content: parts.join(''), ids }
}

export const useTrades = create<State>((set, get) => {
  /** Turn a reply (with its continuations) into a colour PDF — saved straight to
   *  Documents/Stock Trading/Coach reports ('auto') or where the trader picks ('dialog'). */
  async function makePdf(id: string, mode: 'auto' | 'dialog'): Promise<string | null> {
    const st = get()
    const chain = replyChainOf(st.chat, id)
    if (!chain.content.trim()) return 'Nothing to put in a PDF yet.'
    const directive = pdfDirective(chain.content)
    const title = directive?.title || st.activeChatTitle || 'Coach report'
    const html = reportToHtml(title, st.activeChatScope, chain.content, st.chartInputs())
    const target = chain.ids[chain.ids.length - 1] ?? id
    set({ pdfBusyId: target })
    try {
      const res = (await invoke('chat-pdf', { html, title, mode })) as Res & { file?: string; name?: string }
      if (res.ok === true && res.file) {
        const pdf = { file: String(res.file), name: String(res.name ?? res.file) }
        set({ chat: get().chat.map((m) => (m.id === target ? { ...m, pdf, pdfError: undefined } : m)) })
        return null
      }
      if ((res as Err).cancelled) return null
      const error = (res as Err).error ?? 'The PDF could not be made.'
      set({ chat: get().chat.map((m) => (m.id === target ? { ...m, pdfError: error } : m)) })
      return error
    } finally {
      set({ pdfBusyId: null })
    }
  }

  /** Recompute trades/stats/metrics for the current account selection AND the
   *  global date-range filter. Closed trades outside the range are dropped;
   *  open positions always stay (they're current state, not period activity). */
  const recompute = (
    all: Execution[],
    selected: string[] = get().selectedAccounts,
    sectors: Record<string, string> = get().sectors
  ): void => {
    // nothing picked = "All accounts" = every account except the archived ones
    const archived = new Set(get().accounts.filter((a) => a.archived).map((a) => a.id))
    const filtered =
      selected.length > 0
        ? all.filter((e) => selected.includes(e.account || 'default'))
        : archived.size
          ? all.filter((e) => !archived.has(e.account || 'default'))
          : all
    const allTrades = buildTradesByAccount(filtered)
    const { rangePreset, rangeStartYmd, rangeEndYmd } = get()
    const closed = allTrades.filter((t) => !t.isOpen && t.closedAt != null)
    const latest = closed.length ? closed.reduce((mx, t) => Math.max(mx, t.closedAt as number), 0) : null
    const first = closed.length ? closed.reduce((mn, t) => Math.min(mn, t.closedAt as number), Infinity) : null
    const range = resolveRange(rangePreset, latest, first, rangeStartYmd, rangeEndYmd)
    const trades = range.error ? allTrades : filterTradesToRange(allTrades, range)
    const stats = computeStats(trades)
    const metrics = computeMetrics(trades, sectors)
    set({ allExecutions: all, executions: filtered, trades, stats, metrics, rangeLabel: range.label })
  }

  /** Derive the calendar's note view + editable target from the current account
   *  selection. A single account in view → its notes, editable. All/multiple →
   *  the union of their notes, read-only (ambiguous which account to write to). */
  const recomputeNotesView = (): void => {
    const { allDayNotes, selectedAccounts, accounts } = get()
    const active = activeAccounts(accounts)
    const ids = selectedAccounts.length > 0 ? selectedAccounts : active.map((a) => a.id)
    const single =
      selectedAccounts.length === 1
        ? selectedAccounts[0]
        : selectedAccounts.length === 0 && active.length === 1
          ? active[0].id
          : null
    const merged: Record<string, string> = {}
    for (const id of ids) {
      const m = allDayNotes[id]
      if (m) for (const [d, t] of Object.entries(m)) if (!merged[d]) merged[d] = t
    }
    set({ dayNotes: merged, notesAccount: single })
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
    // Heads-up when the import leaves an open position: realized P&L excludes it,
    // and a "phantom" open when you're actually flat means a closing fill is
    // missing from the export (the #1 cause of a mismatch with a broker's total).
    const openNow = get().stats?.openTrades ?? 0
    const openNote =
      (imported > 0 || updated > 0) && openNow > 0
        ? ` ⚠ ${openNow} position${openNow === 1 ? '' : 's'} still open — excluded from Realized P&L. If you're flat at your broker, a closing fill is missing (see Open Positions).`
        : ''
    set({
      lastImport: { imported, updated, skipped, ignored, files },
      status:
        imported > 0 || updated > 0
          ? `Imported: ${parts.join(' · ')}.${brokerNote}${openNote}`
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

    rangePreset: 'lifetime',
    rangeStartYmd: '',
    rangeEndYmd: '',
    rangeLabel: 'Lifetime',

    allDayNotes: {},
    dayNotes: {},
    notesAccount: null,

    sectors: {},
    sectorOverrides: {},
    sectorsBusy: false,
    sectorsHasKey: false,
    sectorFocus: null,

    hasAiKey: false,
    aiText: '',
    pdfBusyId: null,
    exportingSummary: false,
    aiError: '',
    chat: [],
    chatBusy: false,
    activeChatId: null,
    activeChatTitle: '',
    activeChatScope: '',
    activeChatCreatedAt: 0,
    chats: [],

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
      const { selectedAccounts: cur, accounts } = get()
      const has = cur.includes(id)
      const isArchived = accounts.find((a) => a.id === id)?.archived === true
      // checking an archived account while "All accounts" is on ADDS it to all
      // the active ones (that's how its metrics get included); an empty
      // selection falls back to "All accounts"
      let next = has ? cur.filter((x) => x !== id) : cur.length === 0 && isArchived ? [...activeAccounts(accounts).map((a) => a.id), id] : [...cur, id]
      // exactly every active account checked (and nothing archived) is just "All accounts"
      const active = activeAccounts(accounts).map((a) => a.id)
      if (next.length === active.length && active.length > 1 && active.every((x) => next.includes(x))) next = []
      set({ selectedAccounts: next })
      recompute(get().allExecutions, next)
      recomputeNotesView()
    },
    selectAllAccounts: () => {
      set({ selectedAccounts: [] })
      recompute(get().allExecutions, [])
      recomputeNotesView()
    },

    setAccountArchived: async (id, archived) => {
      const res = (await invoke('accounts-archive', { id, archived })) as Res & { accounts?: Account[] }
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? (archived ? 'Could not archive the account.' : 'Could not un-archive the account.') })
        return
      }
      // archiving takes the account out of view; un-archiving puts it back in "All accounts"
      let sel = get().selectedAccounts
      if (archived) {
        sel = sel.filter((x) => x !== id)
        const active = activeAccounts(res.accounts ?? []).map((a) => a.id)
        // "every active account" explicitly checked is the same as All accounts
        if (sel.length && sel.length === active.length && active.every((x) => sel.includes(x))) sel = []
      }
      set({ accounts: res.accounts ?? get().accounts, selectedAccounts: sel })
      await get().refreshAccounts()
    },

    setRange: (preset, startYmd, endYmd) => {
      set({ rangePreset: preset, rangeStartYmd: startYmd ?? get().rangeStartYmd, rangeEndYmd: endYmd ?? get().rangeEndYmd })
      recompute(get().allExecutions)
    },

    loadNotes: async () => {
      const res = (await invoke('notes-list')) as Res & { notes?: Record<string, Record<string, string>> }
      if (res.ok === true) {
        set({ allDayNotes: res.notes ?? {} })
        recomputeNotesView()
      }
    },

    setDayNote: async (date, text) => {
      const account = get().notesAccount
      if (!account) {
        set({ error: 'Select a single account (in the Viewing filter) to add or edit a note.' })
        return
      }
      // optimistic: reflect immediately, then persist
      const all = { ...get().allDayNotes, [account]: { ...(get().allDayNotes[account] ?? {}) } }
      if (text.trim()) all[account][date] = text
      else delete all[account][date]
      set({ allDayNotes: all })
      recomputeNotesView()
      const res = (await invoke('notes-set', { account, date, text })) as Res
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not save the note.' })
        void get().loadNotes() // resync from disk on failure
      }
    },

    load: async () => {
      const res = await invoke('executions')
      if (res.ok === true) recompute((res.executions as Execution[]) ?? [], [])
      await get().refreshAccounts()
      void get().loadNotes()
      void get().loadSectors()
      void get().auditDuplicates()
      void get().loadChats()
      set({ loaded: true })
    },

    refreshAccounts: async () => {
      const res = (await invoke('accounts-list')) as Res & { accounts?: Account[] }
      if (res.ok === true) {
        const accounts = res.accounts ?? []
        // keep importAccount valid — new imports never land in an archived account
        const importAccount = accounts.some((a) => a.id === get().importAccount && !a.archived)
          ? get().importAccount
          : (activeAccounts(accounts)[0]?.id ?? accounts[0]?.id ?? 'default')
        // drop any selected ids that no longer exist
        const validSel = get().selectedAccounts.filter((id) => accounts.some((a) => a.id === id))
        set({ accounts, importAccount, selectedAccounts: validSel })
        // the archived set decides what "All accounts" covers, so always rebuild
        recompute(get().allExecutions, validSel)
        recomputeNotesView() // account set/selection may have changed
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

    setAccountStrategy: async (id, strategy) => {
      const res = (await invoke('accounts-set-strategy', { id, strategy })) as Res & { accounts?: Account[] }
      if (res.ok === true) set({ accounts: res.accounts ?? get().accounts })
      else set({ error: (res as Err).error ?? 'Could not save the strategy.' })
    },

    exportSummary: async (req) => {
      if (get().exportingSummary) return false
      set({ exportingSummary: true, error: '' })
      try {
        const res = (await invoke('export-summary', req)) as Res & { file?: string; aiIncluded?: boolean; aiNote?: string }
        if (res.ok === true) {
          const ai = res.aiIncluded ? ' (with AI summary)' : res.aiNote ? ' — AI summary skipped: ' + res.aiNote : ''
          set({ status: `Account summary exported${ai}.` })
          return true
        }
        if (!(res as Err).cancelled && !(res as Err).canceled)
          set({ error: (res as Err).error ?? 'Could not export the summary.' })
        return false
      } finally {
        set({ exportingSummary: false })
      }
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
        set({ status: account ? 'Account data cleared.' : 'All imported trade data cleared.', lastImport: null, aiText: '' })
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
      const { stats, hasAiKey, chatBusy } = get()
      if (chatBusy) return
      if (!stats || stats.closedTrades === 0) {
        set({ aiError: 'Import some closed trades first.' })
        return
      }
      if (!hasAiKey) {
        set({ aiError: 'No AI key set. Add an Anthropic, OpenAI, Gemini or DeepSeek key in Settings → API Keys.' })
        return
      }
      set({ aiError: '' })
      // every analysis gets its own conversation (earlier chats stay in the history rail)
      get().clearChat()
      const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      await get().sendChat(ANALYZE_PROMPT, { display: 'Analyze my trading', kind: 'analysis', title: `Trading analysis · ${day}` })
    },

    chartInputs: () => {
      const { stats, trades, metrics } = get()
      return stats ? { stats, trades, metrics } : null
    },

    sendChat: async (raw, opts = {}) => {
      const text = raw.trim()
      const { chatBusy, stats, metrics, trades, accounts, selectedAccounts, rangeLabel, dayNotes } = get()
      if (!text || chatBusy || !stats) return
      const viewed = viewedAccounts(accounts, selectedAccounts)
      // rebuilt every message, so a different account/date range mid-chat is picked up
      const system = buildChatContext({
        stats,
        metrics,
        trades,
        accounts: viewed.map((a) => ({ id: a.id, name: a.name, strategy: a.strategy || '', feePerContract: a.feePerContract || 0 })),
        rangeLabel,
        dayNotes,
        analysis: ''
      })
      const history = get()
        .chat.filter((m) => !m.pending && m.content.trim()) // partial (stopped/cut-off) replies stay, so "Continue" works
        // frozen chart data is for display — the model only needs its own chart specs back
        .map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripChartData(m.content) : m.content }))
      const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

      // first message of a new conversation → it gets an id, title and scope
      if (!get().activeChatId) {
        const scope = scopeLabel(accounts, selectedAccounts, rangeLabel)
        set({
          activeChatId: `c${newId()}`,
          activeChatTitle: (opts.title ?? opts.display ?? text).replace(/\s+/g, ' ').slice(0, 80),
          activeChatScope: scope,
          activeChatCreatedAt: Date.now()
        })
      }
      const convId = get().activeChatId!
      const persist = async (): Promise<void> => {
        const st = get()
        if (st.activeChatId !== convId) return
        await invoke('chat-save', {
          id: convId,
          title: st.activeChatTitle,
          scope: st.activeChatScope,
          messages: st.chat.filter((m) => !m.pending)
        })
        await get().loadChats()
      }

      const replyId = newId()
      set({
        chat: [
          ...get().chat,
          { id: newId(), role: 'user', content: text, ...(opts.display ? { display: opts.display } : {}), ...(opts.kind ? { kind: opts.kind } : {}) },
          { id: replyId, role: 'assistant', content: '', pending: true, ...(opts.kind ? { kind: opts.kind } : {}) }
        ],
        chatBusy: true
      })
      void persist()
      const patch = (fn: (m: ChatMessage) => ChatMessage): void =>
        set({ chat: get().chat.map((m) => (m.id === replyId ? fn(m) : m)) })
      const off = window.wicked.on(`${ID}:ai-chat-delta`, (payload) => {
        const d = payload as { chatId?: string; text?: string }
        if (d.chatId === replyId && d.text) patch((m) => ({ ...m, content: m.content + d.text }))
      })
      // source charts keep the numbers they were drawn with, even after the view changes
      const freeze = (md: string): string => {
        const inputs = get().chartInputs()
        try {
          return inputs ? freezeCharts(md, inputs) : md
        } catch {
          return md
        }
      }
      let finished = false
      try {
        const res = (await invoke('ai-chat', { chatId: replyId, system, messages: [...history, { role: 'user', content: text }] })) as Res & {
          text?: string
          provider?: string
          partial?: string
          truncated?: boolean
        }
        if (res.ok === true) {
          const content = freeze(String(res.text ?? ''))
          patch((m) => ({ ...m, content: content || m.content, provider: String(res.provider ?? ''), truncated: res.truncated === true, pending: false }))
          finished = res.truncated !== true
          if (opts.kind === 'analysis') set({ aiText: content })
        } else {
          const e = res as Err & { partial?: string }
          patch((m) => ({ ...m, content: freeze(e.partial || m.content), error: e.error ?? 'The coach could not answer.', pending: false }))
        }
      } catch (err) {
        patch((m) => ({ ...m, error: err instanceof Error ? err.message : String(err), pending: false }))
      } finally {
        off()
        set({ chatBusy: false })
        await persist()
      }
      // "@pdf" replies become a PDF on their own (once the whole report has arrived)
      if (finished && get().activeChatId === convId) {
        const chain = replyChainOf(get().chat, replyId)
        const directive = pdfDirective(chain.content)
        if (directive) {
          await makePdf(replyId, 'auto')
          await persist()
        }
      }
    },

        stopChat: async () => {
      await invoke('ai-chat-cancel')
    },

    clearChat: () => {
      if (get().chatBusy) return
      set({ chat: [], activeChatId: null, activeChatTitle: '', activeChatScope: '', activeChatCreatedAt: 0 })
    },

    loadChats: async () => {
      const res = (await invoke('chats-list')) as Res & { chats?: ChatSummary[] }
      if (res.ok === true) set({ chats: res.chats ?? [] })
    },

    openChat: async (id) => {
      if (get().chatBusy || get().activeChatId === id) return
      const res = (await invoke('chat-get', id)) as Res & {
        chat?: { id: string; title: string; scope: string; createdAt: number; messages: ChatMessage[] }
      }
      if (res.ok !== true || !res.chat) {
        await get().loadChats()
        return
      }
      const c = res.chat
      set({
        chat: c.messages.map((m, i) => ({ ...m, id: m.id || `m${i}`, pending: false })),
        activeChatId: c.id,
        activeChatTitle: c.title,
        activeChatScope: c.scope,
        activeChatCreatedAt: c.createdAt
      })
    },

    deleteChat: async (id) => {
      if (get().chatBusy && get().activeChatId === id) return
      await invoke('chat-delete', id)
      if (get().activeChatId === id) get().clearChat()
      await get().loadChats()
    },

    exportChat: async (format) => {
      const { chat, activeChatTitle, activeChatScope, activeChatCreatedAt } = get()
      const messages = chat.filter((m) => !m.pending)
      if (!messages.length) return 'Nothing to export yet.'
      const meta = { title: activeChatTitle || 'Coach chat', scope: activeChatScope, createdAt: activeChatCreatedAt || Date.now() }
      const inputs = get().chartInputs()
      const res = (await invoke('chat-export', {
        format,
        title: meta.title,
        ...(format === 'md' ? { markdown: chatToMarkdown(meta, messages, inputs) } : { html: chatToHtml(meta, messages, inputs) })
      })) as Res
      if (res.ok === true || (res as Err).cancelled) return null
      return (res as Err).error ?? 'Export failed.'
    },

    replyPdf: async (id) => {
      const r = await makePdf(id, 'dialog')
      const st = get()
      if (st.activeChatId)
        await invoke('chat-save', { id: st.activeChatId, title: st.activeChatTitle, scope: st.activeChatScope, messages: st.chat.filter((m) => !m.pending) })
      return r
    },

    openPdf: async (file, reveal = false) => {
      await invoke('open-file', { file, reveal })
    },

    exportReport: async () => {
      const { stats, chat, aiText, accounts, selectedAccounts, rangeLabel } = get()
      if (!stats || stats.closedTrades === 0) return 'Import some closed trades first.'
      // the analysis on screen wins; otherwise the latest one this session
      const lastAnalysis = [...chat].reverse().find((m) => m.role === 'assistant' && m.kind === 'analysis' && !m.pending && m.content.trim())
      const analysis = lastAnalysis ? replyChainOf(chat, lastAnalysis.id).content : aiText
      const scope = scopeLabel(accounts, selectedAccounts, rangeLabel)
      const html = reportToHtml('Trading report', scope, tradingReportMarkdown(analysis), get().chartInputs())
      const res = (await invoke('chat-pdf', { html, title: 'Trading report', mode: 'dialog' })) as Res
      if (res.ok === true || (res as Err).cancelled) return null
      return (res as Err).error ?? 'PDF export failed.'
    }
  }

})

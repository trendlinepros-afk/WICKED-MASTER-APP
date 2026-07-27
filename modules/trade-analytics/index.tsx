import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CandlestickChart,
  Clock,
  Download,
  FileDown,
  Grid3x3,
  LayoutGrid,
  Loader2,
  Sparkles,
  Trash2,
  TrendingUp,
  Upload,
  Wallet,
  X
} from 'lucide-react'
import { SHELL_IPC, type ApiProviderId } from '@shared/types'
import { buildReportPdf } from '../stock-planner/lib/pdf'
import { buildJournalReport } from './lib/report'
import { ID, useTrades, type Tab } from './store'
import type { Trade } from './lib/analytics'
import { dateShort, dateTime, duration, money, num, pct, shares, signedMoney } from './lib/format'
import { BarChart, ColumnChart, EquityCurve, WinLossDonut } from './components/charts'
import { AccountsBar, BreakdownTab, CalendarTab, ImportModal, ManageAccountsModal, SectorCard, StatsTab } from './components/panels'

const pos = (n: number): string => (n >= 0 ? 'text-ok' : 'text-danger')

/* --------------------------------- KPIs ---------------------------------- */

function Stat({
  label,
  value,
  sub,
  tone,
  icon
}: {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'danger' | 'accent'
  icon?: React.ReactNode
}): React.JSX.Element {
  const color = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-ink'
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-bold tracking-tight ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

/* ------------------------------- overview -------------------------------- */

function OverviewTab(): React.JSX.Element {
  const stats = useTrades((s) => s.stats)
  if (!stats) return <div className="p-8 text-sm text-muted">No data.</div>

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Realized P&L" value={signedMoney(stats.totalRealized)} tone={stats.totalRealized >= 0 ? 'ok' : 'danger'} sub={`${num(stats.closedTrades)} closed trades`} icon={<TrendingUp size={12} />} />
        <Stat label="Win rate" value={pct(stats.winRate, 1).replace('+', '')} sub={`${stats.wins}W · ${stats.losses}L · ${stats.breakeven}BE`} />
        <Stat label="Profit factor" value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} sub={`expectancy ${money(stats.expectancy)}/trade`} tone={stats.profitFactor >= 1 ? 'ok' : 'danger'} />
        <Stat label="Open positions" value={num(stats.openTrades)} sub={`cost basis ${money(stats.openCostBasis)}`} tone="accent" icon={<Wallet size={12} />} />
      </div>

      {/* equity curve */}
      <div className="rounded-xl border border-edge bg-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Equity curve — cumulative realized P&L</h3>
          <span className={`text-sm font-semibold ${pos(stats.totalRealized)}`}>{signedMoney(stats.totalRealized)}</span>
        </div>
        <EquityCurve values={stats.equityCurve.map((p) => p.cumulative)} />
      </div>

      {/* market sector P&L */}
      <SectorCard />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* win/loss */}
        <div className="flex flex-col items-center justify-center rounded-xl border border-edge bg-surface p-4">
          <WinLossDonut wins={stats.wins} losses={stats.losses} breakeven={stats.breakeven} />
          <div className="mt-2 flex gap-4 text-xs">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ok" /> {stats.wins} wins</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> {stats.losses} losses</span>
          </div>
        </div>

        {/* avg win/loss + streaks */}
        <div className="space-y-2 rounded-xl border border-edge bg-surface p-4 text-sm">
          <Row label="Average win" value={money(stats.avgWin)} tone="ok" />
          <Row label="Average loss" value={money(stats.avgLoss)} tone="danger" />
          <Row label="Largest win" value={money(stats.largestWin)} tone="ok" />
          <Row label="Largest loss" value={money(stats.largestLoss)} tone="danger" />
          <Row label="Max win streak" value={`${stats.maxWinStreak}`} />
          <Row label="Max loss streak" value={`${stats.maxLossStreak}`} />
          <Row label="Avg hold time" value={duration(stats.avgHoldSeconds)} />
        </div>

        {/* long vs short + volume */}
        <div className="space-y-2 rounded-xl border border-edge bg-surface p-4 text-sm">
          <Row label="Long P&L" value={`${signedMoney(stats.longPnl)} · ${stats.longTrades}`} tone={stats.longPnl >= 0 ? 'ok' : 'danger'} />
          <Row label="Short P&L" value={`${signedMoney(stats.shortPnl)} · ${stats.shortTrades}`} tone={stats.shortPnl >= 0 ? 'ok' : 'danger'} />
          <Row label="Gross profit" value={money(stats.grossProfit)} tone="ok" />
          <Row label="Gross loss" value={money(-stats.grossLoss)} tone="danger" />
          <Row label="Total volume" value={money(stats.totalVolume, false)} />
          <Row label="Shares traded" value={num(stats.sharesTraded)} />
          <Row label="Best / worst" value={`${stats.bestSymbol?.symbol ?? '—'} / ${stats.worstSymbol?.symbol ?? '—'}`} />
        </div>
      </div>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'danger' }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={`font-medium tabular-nums ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</span>
    </div>
  )
}

/* --------------------------------- trades -------------------------------- */

function TradeRow({ t }: { t: Trade }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-2 border-b border-edge/50 px-3 py-2 text-xs md:grid-cols-[70px_1fr_90px_90px_110px_110px]">
      <div className="flex items-center gap-1 font-semibold">
        {t.direction === 'long' ? <ArrowUpRight size={13} className="text-ok" /> : <ArrowDownRight size={13} className="text-danger" />}
        {t.symbol}
      </div>
      <div className="min-w-0 truncate text-muted">
        {t.isOpen ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 font-medium text-accent">OPEN · {shares(t.openQty)} sh</span>
        ) : (
          `${shares(t.qty)} sh · ${dateShort(t.openedAt)}→${dateShort(t.closedAt)}`
        )}
      </div>
      <div className="text-right tabular-nums text-muted">{t.avgEntry.toFixed(2)}</div>
      <div className="text-right tabular-nums text-muted">{t.isOpen ? '—' : t.avgExit.toFixed(2)}</div>
      <div className="text-right tabular-nums text-muted">{duration(t.holdSeconds)}</div>
      <div className={`text-right font-semibold tabular-nums ${t.isOpen ? 'text-accent' : pos(t.realizedPnl)}`}>
        {t.isOpen ? 'open' : `${signedMoney(t.realizedPnl)}`}
        {!t.isOpen && <span className="ml-1 text-[10px] font-normal opacity-70">{pct(t.realizedPct)}</span>}
      </div>
    </div>
  )
}

function TradesTab(): React.JSX.Element {
  const trades = useTrades((s) => s.trades)
  if (trades.length === 0) return <div className="p-8 text-sm text-muted">No trades yet.</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-[70px_1fr_90px_90px_110px_110px] gap-2 border-b border-edge px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <div>Symbol</div>
        <div>Detail</div>
        <div className="text-right">Entry</div>
        <div className="text-right">Exit</div>
        <div className="text-right">Hold</div>
        <div className="text-right">P&L</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trades.map((t) => (
          <TradeRow key={t.id} t={t} />
        ))}
      </div>
    </div>
  )
}

/* ------------------------------ open positions --------------------------- */

function OpenTab(): React.JSX.Element {
  const trades = useTrades((s) => s.trades)
  const open = trades.filter((t) => t.isOpen)
  if (open.length === 0)
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">
        No open positions — every buy has a matching sell. 🎉
      </div>
    )
  // realized P&L already banked on positions that were partially scaled out
  const bankedPartial = open.reduce((n, t) => n + (t.closedQty > 0 ? t.realizedPnl : 0), 0)
  return (
    <div className="p-4">
      <p className="mb-3 flex items-center gap-2 text-sm text-muted">
        <Wallet size={15} className="text-accent" /> {open.length} open position(s) — bought (or shorted) with no closing trade yet.
      </p>
      <div className="overflow-hidden rounded-xl border border-edge">
        <div className="grid grid-cols-[70px_60px_1fr_1fr_1fr_110px_1fr] gap-2 border-b border-edge bg-raised/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <div>Symbol</div>
          <div>Side</div>
          <div className="text-right">Open qty</div>
          <div className="text-right">Avg entry</div>
          <div className="text-right">Cost basis</div>
          <div className="text-right">Realized so far</div>
          <div className="text-right">Opened</div>
        </div>
        {open.map((t) => (
          <div key={t.id} className="grid grid-cols-[70px_60px_1fr_1fr_1fr_110px_1fr] items-center gap-2 border-b border-edge/50 px-3 py-2.5 text-xs">
            <div className="font-semibold">{t.symbol}</div>
            <div className={t.direction === 'long' ? 'text-ok' : 'text-danger'}>{t.direction}</div>
            <div className="text-right tabular-nums">{shares(t.openQty)}</div>
            <div className="text-right tabular-nums">{t.avgEntry.toFixed(4)}</div>
            <div className="text-right font-medium tabular-nums">{money(t.avgEntry * t.openQty)}</div>
            <div className={`text-right tabular-nums ${t.closedQty > 0 ? pos(t.realizedPnl) : 'text-muted'}`}>
              {t.closedQty > 0 ? `${signedMoney(t.realizedPnl)}` : '—'}
            </div>
            <div className="text-right tabular-nums text-muted">{dateTime(t.openedAt)}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted">
        Cost basis is what you paid to open. Unrealized P&L needs live prices (not in the Webull order
        export), so it isn&apos;t shown — import a fresh report after you close a position and it moves
        to your realized stats automatically.
        {bankedPartial !== 0 && (
          <>
            {' '}
            <strong className={pos(bankedPartial)}>{signedMoney(bankedPartial)}</strong> is already realized
            from partial scale-outs on these open positions (it joins your realized totals once each position
            is fully closed).
          </>
        )}
      </p>
    </div>
  )
}

/* -------------------------------- symbols -------------------------------- */

function SymbolsTab(): React.JSX.Element {
  const stats = useTrades((s) => s.stats)
  if (!stats || stats.bySymbol.length === 0) return <div className="p-8 text-sm text-muted">No data.</div>
  const traded = stats.bySymbol.filter((s) => s.trades > 0)
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Realized P&L by symbol</h3>
        <BarChart bars={traded.map((s) => ({ label: s.symbol, value: s.realizedPnl }))} maxBars={25} />
      </div>
      <div className="overflow-hidden rounded-xl border border-edge">
        <div className="grid grid-cols-[70px_1fr_70px_90px_1fr] gap-2 border-b border-edge bg-raised/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
          <div>Symbol</div>
          <div className="text-right">Trades</div>
          <div className="text-right">Win%</div>
          <div className="text-right">Volume</div>
          <div className="text-right">P&L</div>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {traded.map((s) => (
            <div key={s.symbol} className="grid grid-cols-[70px_1fr_70px_90px_1fr] items-center gap-2 border-b border-edge/50 px-3 py-2 text-xs">
              <div className="font-semibold">{s.symbol}</div>
              <div className="text-right tabular-nums text-muted">{s.trades}</div>
              <div className="text-right tabular-nums text-muted">{s.trades > 0 ? Math.round((s.wins / s.trades) * 100) : 0}%</div>
              <div className="text-right tabular-nums text-muted">{money(s.volume, false)}</div>
              <div className={`text-right font-semibold tabular-nums ${pos(s.realizedPnl)}`}>{signedMoney(s.realizedPnl)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- timing -------------------------------- */

function TimingTab(): React.JSX.Element {
  const stats = useTrades((s) => s.stats)
  if (!stats) return <div className="p-8 text-sm text-muted">No data.</div>
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">P&L by day of week</h3>
        <ColumnChart columns={stats.byDayOfWeek.map((b) => ({ label: b.label, value: b.pnl }))} />
      </div>
      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">P&L by hour of day (close time, ET)</h3>
        <ColumnChart columns={stats.byHour.map((b) => ({ label: b.label.replace(':00', ''), value: b.pnl }))} />
      </div>
      <div className="rounded-xl border border-edge bg-surface p-4">
        <h3 className="mb-3 text-sm font-semibold">Daily P&L</h3>
        <ColumnChart columns={stats.byDay.slice(-30).map((b) => ({ label: b.label.slice(5), value: b.pnl }))} height={140} />
        <p className="mt-2 text-xs text-muted">Last {Math.min(30, stats.byDay.length)} trading days shown.</p>
      </div>
    </div>
  )
}

/* -------------------------------- AI coach ------------------------------- */

function AiTab(): React.JSX.Element {
  const s = useTrades()
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState('')

  const exportPdf = async (): Promise<void> => {
    const { stats, aiText, executions } = useTrades.getState()
    if (!stats || exporting) return
    setExporting(true)
    setExportErr('')
    try {
      const now = new Date()
      const stamp = `${now.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })} ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      const spec = buildJournalReport(stats, aiText, executions.length, stamp)
      const b64 = buildReportPdf(spec, [], 'WICKED · TRADE JOURNAL')
      const res = (await window.wicked.invoke(`${ID}:save-pdf`, { data: b64 })) as {
        ok?: boolean
        cancelled?: boolean
        error?: string
      }
      if (!res.ok && !res.cancelled) setExportErr(res.error ?? 'PDF export failed.')
    } catch (err) {
      setExportErr(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {!s.hasAiKey && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-warn" />
          <span>Add an Anthropic, OpenAI, Gemini or DeepSeek key in <strong>Settings → API Keys</strong> to enable AI coaching.</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void s.analyze()}
          disabled={s.aiBusy || !s.hasAiKey || !s.stats || s.stats.closedTrades === 0}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {s.aiBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {s.aiText ? 'Re-analyze my trading' : 'Analyze my trading'}
        </button>
        <button
          onClick={() => void exportPdf()}
          disabled={exporting || !s.stats || s.stats.closedTrades === 0}
          title={s.aiText ? 'Export your stats + the AI coach analysis as a PDF' : 'Export your stats as a PDF (run the AI analysis first to include it)'}
          className="flex items-center gap-2 rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
        >
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />}
          Export PDF
        </button>
        {s.aiProvider && <span className="text-xs text-muted">via {s.aiProvider}</span>}
        {s.aiBusy && (
          <button onClick={() => void s.cancelAi()} className="rounded-lg bg-raised px-3 py-2 text-sm hover:bg-edge/60">
            Cancel
          </button>
        )}
      </div>
      {s.aiError && <div className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{s.aiError}</div>}
      {exportErr && <div className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{exportErr}</div>}
      {s.aiText ? (
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-xl border border-edge bg-surface p-4 text-sm leading-relaxed text-ink">
          {s.aiText}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-edge text-center text-sm text-muted">
          <div className="max-w-sm p-6">
            <Sparkles size={22} className="mx-auto text-accent" />
            <p className="mt-2">Get an AI coach&apos;s read on your stats — strengths, leaks, risk issues and concrete process fixes. Your numbers are sent to the AI; nothing about your account is stored.</p>
          </div>
        </div>
      )}
    </div>
  )
}

/* --------------------------------- shell --------------------------------- */

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <BarChart3 size={14} /> },
  { id: 'calendar', label: 'Calendar', icon: <CalendarDays size={14} /> },
  { id: 'stats', label: 'Stats', icon: <Grid3x3 size={14} /> },
  { id: 'breakdown', label: 'Breakdown', icon: <LayoutGrid size={14} /> },
  { id: 'trades', label: 'Trades', icon: <CandlestickChart size={14} /> },
  { id: 'open', label: 'Open Positions', icon: <Wallet size={14} /> },
  { id: 'symbols', label: 'Symbols', icon: <TrendingUp size={14} /> },
  { id: 'timing', label: 'Timing', icon: <Clock size={14} /> },
  { id: 'ai', label: 'AI Coach', icon: <Sparkles size={14} /> }
]

export default function TradeAnalytics(): React.JSX.Element {
  const s = useTrades()

  useEffect(() => {
    void s.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let mounted = true
    void window.wicked.invoke(SHELL_IPC.apiKeysStatus).then((status) => {
      if (!mounted) return
      const st = status as Partial<Record<ApiProviderId, boolean>>
      s.setHasAiKey(!!(st.anthropic || st.openai || st.gemini || st.deepseek))
    })
    const off = window.wicked.on(SHELL_IPC.apiKeysChanged, (status) => {
      const st = status as Partial<Record<ApiProviderId, boolean>>
      s.setHasAiKey(!!(st.anthropic || st.openai || st.gemini || st.deepseek))
    })
    return () => {
      mounted = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [manageOpen, setManageOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const paths: string[] = []
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const p = window.wicked.getPathForFile(f)
        if (p) paths.push(p)
      } catch {
        /* ignore */
      }
    }
    if (paths.length > 0) void s.importPaths(paths)
    else s.setDragOver(false)
  }

  // truly empty = nothing imported anywhere; a selected-but-empty account still
  // shows the dashboard chrome (accounts bar + tabs) with zeroed stats.
  const empty = s.loaded && s.allExecutions.length === 0

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        if (!s.dragOver) s.setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) s.setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <CandlestickChart size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">Trade Analytics</h1>
          <p className="truncate text-xs text-muted">
            {s.executions.length > 0 ? `${num(s.executions.length)} executions · ${num(s.trades.length)} trades · ${s.stats?.openTrades ?? 0} open` : 'Import your Webull order records'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setImportOpen(true)}
            disabled={s.importing}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Import CSV
          </button>
          {s.executions.length > 0 && (
            <button
              onClick={() => void s.clearAll()}
              disabled={s.importing}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
              title="Clear all imported data"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </header>

      {/* accounts bar (multi-select view + manage + import target) */}
      {!empty && <AccountsBar onManage={() => setManageOpen(true)} />}

      {/* tabs */}
      {!empty && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-edge px-4 pt-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => s.setTab(t.id)}
              className={`-mb-px flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
                s.tab === t.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {t.icon}
              {t.label}
              {t.id === 'open' && (s.stats?.openTrades ?? 0) > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">{s.stats?.openTrades}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* error */}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {empty ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="max-w-md text-center">
              <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-raised text-accent">
                <Download size={30} />
              </span>
              <h2 className="mt-4 text-lg font-bold">Import your Webull trades</h2>
              <p className="mt-2 text-sm text-muted">
                In Webull: <strong>Orders → Export</strong> your order records as CSV, then drop the file
                here or click Import. Re-import anytime — overlapping/old trades are de-duplicated
                automatically, so you never get doubles.
              </p>
              <button
                onClick={() => setImportOpen(true)}
                disabled={s.importing}
                className="mx-auto mt-5 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {s.importing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                Import CSV
              </button>
            </div>
          </div>
        ) : (
          <>
            {s.tab === 'overview' && <OverviewTab />}
            {s.tab === 'calendar' && <CalendarTab />}
            {s.tab === 'stats' && <StatsTab />}
            {s.tab === 'breakdown' && <BreakdownTab />}
            {s.tab === 'trades' && <TradesTab />}
            {s.tab === 'open' && <OpenTab />}
            {s.tab === 'symbols' && <SymbolsTab />}
            {s.tab === 'timing' && <TimingTab />}
            {s.tab === 'ai' && <AiTab />}
          </>
        )}
      </div>

      {manageOpen && <ManageAccountsModal onClose={() => setManageOpen(false)} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}

      {/* status bar */}
      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {s.importing && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <span className="truncate">{s.status}</span>
        {s.lastImport && !s.importing && (
          <span className="ml-auto shrink-0">{s.lastImport.imported} new · {s.lastImport.skipped} dupes skipped</span>
        )}
      </footer>

      {/* drag overlay */}
      {s.dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center">
            <Upload size={28} className="mx-auto text-accent" />
            <p className="mt-2 text-sm font-medium">Drop Webull CSV to import</p>
          </div>
        </div>
      )}
    </div>
  )
}

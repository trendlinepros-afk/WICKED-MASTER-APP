import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { AlertTriangle, Loader2, Plus, Search, Settings, Trash2, X } from 'lucide-react'
import { usePaper, type OrderDraft, type Tab, type Timeframe } from './store'
import { positionEquity, realizedSince, unrealizedPnl } from './engine'
import type { ClosedTrade, PaperAccount, Position } from './types'

/* -------------------------------- helpers -------------------------------- */

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const price = (n: number): string => `$${n.toFixed(2)}`
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${money(n)}`
const tone = (n: number): string => (n > 0 ? 'text-ok' : n < 0 ? 'text-danger' : 'text-ink')
const fmtDate = (ts: number): string => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
function cssRGB(v: string, fb: string): string {
  // Theme tokens are space-separated RGB ("148 155 170"); lightweight-charts only
  // parses comma-separated rgb(), so join with commas.
  try {
    const s = getComputedStyle(document.documentElement).getPropertyValue(v).trim()
    if (!s) return fb
    const p = s.split(/[\s,]+/).filter(Boolean)
    return p.length >= 3 ? `rgb(${p[0]}, ${p[1]}, ${p[2]})` : s.startsWith('#') || s.startsWith('rgb') ? s : fb
  } catch {
    return fb
  }
}

const TFS: Timeframe[] = ['1D', '5D', '1M', '3M', '1Y']
interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/* --------------------------------- chart --------------------------------- */

function Chart({ symbol, timeframe }: { symbol: string; timeframe: Timeframe }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const edge = cssRGB('--wk-edge', '#233043')
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssRGB('--wk-muted', '#94a3b8') },
      grid: { vertLines: { color: edge }, horzLines: { color: edge } },
      rightPriceScale: { borderColor: edge },
      timeScale: { borderColor: edge, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal }
    })
    const up = cssRGB('--wk-ok', '#22c55e')
    const dn = cssRGB('--wk-danger', '#ef4444')
    candleRef.current = chart.addCandlestickSeries({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn })
    volRef.current = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' })
    volRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      setMsg('')
      const res = (await window.wicked.invoke('paper-trading:candles', { symbol, timeframe })) as { ok?: boolean; bars?: Bar[]; error?: string }
      if (!alive) return
      const bars = res?.bars ?? []
      if (!bars.length) {
        setMsg(res?.error || `No data for ${symbol}.`)
        candleRef.current?.setData([])
        volRef.current?.setData([])
        return
      }
      const up = cssRGB('--wk-ok', '#22c55e')
      const dn = cssRGB('--wk-danger', '#ef4444')
      candleRef.current?.setData(bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c })))
      volRef.current?.setData(bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, value: b.v, color: b.c >= b.o ? up : dn })))
      chartRef.current?.timeScale().fitContent()
    })()
    return () => {
      alive = false
    }
  }, [symbol, timeframe])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={wrapRef} className="absolute inset-0" />
      {msg && <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1 text-xs text-danger">{msg}</div>}
    </div>
  )
}

/* ----------------------------- order ticket ------------------------------ */

const inputCls = 'w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent'
const lblCls = 'mb-1 block text-[11px] font-medium text-muted'

function OrderTicket({ symbol, mark }: { symbol: string; mark: number | null }): React.JSX.Element {
  const place = usePaper((s) => s.placeOrder)
  const busy = usePaper((s) => s.busy)
  const [kind, setKind] = useState<'stock' | 'option'>('stock')
  const [qty, setQty] = useState('100')
  const [stop, setStop] = useState('')
  const [tp, setTp] = useState('')
  const [optType, setOptType] = useState<'call' | 'put'>('call')
  const [strike, setStrike] = useState('')
  const [expiry, setExpiry] = useState('')
  const [premium, setPremium] = useState('')

  const submit = async (side: 'long' | 'short'): Promise<void> => {
    const o: OrderDraft = {
      kind,
      symbol,
      side,
      qty: Number(qty) || 0,
      stop: stop ? Number(stop) : null,
      takeProfit: tp ? Number(tp) : null,
      ...(kind === 'option' ? { optionType: optType, strike: Number(strike), expiry, price: Number(premium) } : {})
    }
    await place(o)
  }

  return (
    <div className="border-t border-edge bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-edge bg-raised p-0.5">
          {(['stock', 'option'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded-md px-3 py-1 text-xs font-medium ${kind === k ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
              {k === 'stock' ? 'Stock' : 'Option'}
            </button>
          ))}
        </div>
        <span className="text-sm font-semibold">{symbol}</span>
        {mark != null && <span className="text-xs text-muted">· mark {price(mark)}</span>}
      </div>

      {kind === 'stock' ? (
        <div className="grid grid-cols-3 gap-2">
          <label>
            <span className={lblCls}>Shares</span>
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Stop (optional)</span>
            <input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="—" className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Take profit (optional)</span>
            <input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" className={inputCls} />
          </label>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-3 flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-edge bg-raised p-0.5">
              {(['call', 'put'] as const).map((t) => (
                <button key={t} onClick={() => setOptType(t)} className={`rounded-md px-3 py-1 text-xs font-medium ${optType === t ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}>
                  {t === 'call' ? 'Call' : 'Put'}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted">Long only · you enter the premium (manual pricing)</span>
          </div>
          <label>
            <span className={lblCls}>Contracts</span>
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Strike</span>
            <input inputMode="decimal" value={strike} onChange={(e) => setStrike(e.target.value)} className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Expiry</span>
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Premium / share</span>
            <input inputMode="decimal" value={premium} onChange={(e) => setPremium(e.target.value)} placeholder="e.g. 1.25" className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Stop (premium)</span>
            <input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="—" className={inputCls} />
          </label>
          <label>
            <span className={lblCls}>Target (premium)</span>
            <input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" className={inputCls} />
          </label>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button onClick={() => void submit('long')} disabled={busy} className="flex-1 rounded-lg bg-ok px-3 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-50">
          Buy {kind === 'stock' ? '(Long)' : optType === 'call' ? 'Call' : 'Put'}
        </button>
        {kind === 'stock' && (
          <button onClick={() => void submit('short')} disabled={busy} className="flex-1 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-bg hover:opacity-90 disabled:opacity-50">
            Sell / Short
          </button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------- positions ------------------------------- */

function PositionRow({ p, mark }: { p: Position; mark: number }): React.JSX.Element {
  const close = usePaper((s) => s.closePosition)
  const updatePosition = usePaper((s) => s.updatePosition)
  const busy = usePaper((s) => s.busy)
  const pnl = unrealizedPnl(p, mark)
  const [closeQty, setCloseQty] = useState('')
  const isOpt = p.kind === 'option'
  return (
    <div className="rounded-lg border border-edge bg-surface p-2.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{p.symbol}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${p.side === 'short' ? 'bg-danger/15 text-danger' : 'bg-ok/15 text-ok'}`}>
          {isOpt ? `${p.optionType} ${p.strike}` : p.side}
        </span>
        <span className="text-xs text-muted">
          {p.qty} {isOpt ? 'ctr' : 'sh'} @ {price(p.entryPrice)}
          {isOpt && p.expiry ? ` · exp ${p.expiry}` : ''}
        </span>
        <span className={`ml-auto text-sm font-bold tabular-nums ${tone(pnl)}`}>{signed(pnl)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>mark {price(mark)}</span>
        {!isOpt && (
          <>
            <label className="flex items-center gap-1">
              stop
              <input
                defaultValue={p.stop ?? ''}
                onBlur={(e) => void updatePosition(p.id, { stop: e.target.value ? Number(e.target.value) : null })}
                placeholder="—"
                className="w-16 rounded border border-edge bg-raised px-1 py-0.5 text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1">
              target
              <input
                defaultValue={p.takeProfit ?? ''}
                onBlur={(e) => void updatePosition(p.id, { takeProfit: e.target.value ? Number(e.target.value) : null })}
                placeholder="—"
                className="w-16 rounded border border-edge bg-raised px-1 py-0.5 text-ink outline-none focus:border-accent"
              />
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {isOpt && (
            <input
              inputMode="decimal"
              value={closeQty}
              onChange={(e) => setCloseQty(e.target.value)}
              placeholder="close @ premium"
              className="w-28 rounded border border-edge bg-raised px-1.5 py-0.5 text-ink outline-none focus:border-accent"
            />
          )}
          <button
            onClick={() => void close(p.id, undefined, isOpt ? Number(closeQty) || undefined : undefined)}
            disabled={busy}
            className="rounded-md bg-raised px-2 py-1 text-[11px] font-medium hover:bg-edge/60 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------- review --------------------------------- */

function Review({ closed }: { closed: ClosedTrade[] }): React.JSX.Element {
  if (closed.length === 0) return <p className="p-6 text-center text-sm text-muted">No closed trades yet.</p>
  const wins = closed.filter((c) => c.pnl > 0)
  const losses = closed.filter((c) => c.pnl < 0)
  const total = closed.reduce((a, c) => a + c.pnl, 0)
  const winRate = (wins.length / closed.length) * 100
  const avgWin = wins.length ? wins.reduce((a, c) => a + c.pnl, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((a, c) => a + c.pnl, 0) / losses.length : 0
  const grossWin = wins.reduce((a, c) => a + c.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((a, c) => a + c.pnl, 0))
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0
  const best = Math.max(0, ...closed.map((c) => c.pnl))
  const worst = Math.min(0, ...closed.map((c) => c.pnl))
  const stats: [string, string, string?][] = [
    ['Net realized', signed(total), tone(total)],
    ['Trades', String(closed.length)],
    ['Win rate', `${winRate.toFixed(0)}%`],
    ['Avg win', signed(avgWin), 'text-ok'],
    ['Avg loss', signed(avgLoss), 'text-danger'],
    ['Profit factor', pf === Infinity ? '∞' : pf.toFixed(2), pf >= 1 ? 'text-ok' : 'text-danger'],
    ['Best', signed(best), 'text-ok'],
    ['Worst', signed(worst), 'text-danger']
  ]
  return (
    <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4">
      {stats.map(([l, v, t]) => (
        <div key={l} className="rounded-lg border border-edge bg-surface p-2.5">
          <div className="text-[11px] text-muted">{l}</div>
          <div className={`mt-0.5 text-base font-bold tabular-nums ${t ?? 'text-ink'}`}>{v}</div>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------- accounts modal ----------------------------- */

function AccountsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const data = usePaper((s) => s.data)
  const create = usePaper((s) => s.createAccount)
  const rename = usePaper((s) => s.renameAccount)
  const del = usePaper((s) => s.deleteAccount)
  const setActive = usePaper((s) => s.setActive)
  const [name, setName] = useState('')
  const [bal, setBal] = useState('5000')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Paper accounts</h3>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
          {(data?.accounts ?? []).map((a) => (
            <div key={a.id} className={`flex items-center gap-2 rounded-lg border p-2 ${a.id === data?.activeId ? 'border-accent bg-raised' : 'border-edge'}`}>
              <input
                defaultValue={a.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== a.name && void rename(a.id, e.target.value.trim())}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
              <span className="shrink-0 text-[11px] text-muted">start {money(a.startingBalance)}</span>
              {a.id !== data?.activeId && (
                <button onClick={() => void setActive(a.id)} className="shrink-0 rounded bg-raised px-2 py-1 text-[11px] hover:bg-edge/60">
                  Use
                </button>
              )}
              <button
                onClick={() => {
                  if (window.confirm(`Delete "${a.name}" and all its paper trades?`)) void del(a.id)
                }}
                className="shrink-0 rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-edge pt-3">
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <label>
              <span className={lblCls}>New account name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Swing Practice" className={inputCls} />
            </label>
            <label>
              <span className={lblCls}>Starting balance</span>
              <input inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value)} className={inputCls} />
            </label>
          </div>
          <button
            onClick={() => {
              void create(name.trim() || 'New account', Number(bal) || 5000)
              setName('')
              setBal('5000')
            }}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            <Plus size={14} /> Create account
          </button>
          <p className="mt-2 text-[11px] text-muted">Balance can only change through trades — it can’t be edited after creation.</p>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- screen -------------------------------- */

export default function PaperTrading(): React.JSX.Element {
  const s = usePaper()
  const [symInput, setSymInput] = useState('AAPL')
  const [showAccounts, setShowAccounts] = useState(false)

  useEffect(() => {
    void s.load()
    const t = setInterval(() => void usePaper.getState().pollQuotes(), 20_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const acct: PaperAccount | null = s.active()
  // Stocks mark at the live quote; options mark at their entry premium (v1 manual
  // pricing) so the underlying's price can't distort option P&L.
  const posMark = (p: Position): number => (p.kind === 'option' ? p.entryPrice : s.marks[p.symbol] ?? p.entryPrice)
  const equity = acct ? acct.cash + acct.positions.reduce((a, p) => a + positionEquity(p, posMark(p)), 0) : 0
  const openPnl = acct ? acct.positions.reduce((a, p) => a + unrealizedPnl(p, posMark(p)), 0) : 0
  const totalPnl = acct ? equity - acct.startingBalance : 0
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startWeek = startToday - ((now.getDay() + 6) % 7) * 86_400_000
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const realizedToday = acct ? realizedSince(acct.closed, startToday) : 0
  const realizedWeek = acct ? realizedSince(acct.closed, startWeek) : 0
  const realizedMonth = acct ? realizedSince(acct.closed, startMonth) : 0

  // symbol P&L (realized + unrealized)
  const symPnl = new Map<string, number>()
  if (acct) {
    for (const c of acct.closed) symPnl.set(c.symbol, (symPnl.get(c.symbol) ?? 0) + c.pnl)
    for (const p of acct.positions) symPnl.set(p.symbol, (symPnl.get(p.symbol) ?? 0) + unrealizedPnl(p, posMark(p)))
  }
  const symRows = [...symPnl.entries()].sort((a, b) => b[1] - a[1])

  const submitSym = (): void => {
    const v = symInput.trim().toUpperCase()
    if (v) s.setChartSymbol(v)
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2">
        <span className="text-sm font-bold tracking-tight"><ModuleTitle fallback="Paper Trading" /></span>
        <select
          value={s.data?.activeId ?? ''}
          onChange={(e) => void s.setActive(e.target.value)}
          className="rounded-lg border border-edge bg-raised px-2 py-1 text-xs outline-none focus:border-accent"
        >
          {(s.data?.accounts ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-muted">Equity </span>
            <span className="font-bold tabular-nums">{money(equity)}</span>
          </div>
          <div>
            <span className="text-muted">Cash </span>
            <span className="font-semibold tabular-nums">{money(acct?.cash ?? 0)}</span>
          </div>
          <div>
            <span className="text-muted">Total P&L </span>
            <span className={`font-bold tabular-nums ${tone(totalPnl)}`}>{signed(totalPnl)}</span>
          </div>
        </div>
        <button onClick={() => setShowAccounts(true)} title="Manage paper accounts" className="ml-auto flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-xs font-medium hover:border-accent">
          <Settings size={14} /> Accounts
        </button>
      </header>

      {s.status && <div className="border-b border-edge bg-accent/10 px-4 py-1 text-[11px] text-accent">{s.status}</div>}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          <AlertTriangle size={13} /> {s.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left: chart + ticket */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-edge">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
            <div className="flex items-center rounded-lg border border-edge bg-raised pl-2">
              <Search size={13} className="text-muted" />
              <input
                value={symInput}
                onChange={(e) => setSymInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && submitSym()}
                placeholder="Ticker"
                className="w-24 bg-transparent px-2 py-1.5 text-sm outline-none"
              />
            </div>
            <span className="text-sm font-semibold">{s.chartSymbol}</span>
            {s.marks[s.chartSymbol] != null && <span className="text-xs text-muted">{price(s.marks[s.chartSymbol])}</span>}
            <div className="ml-2 flex gap-1">
              {TFS.map((t) => (
                <button key={t} onClick={() => s.setTimeframe(t)} className={`rounded-md px-2 py-1 text-xs font-medium ${t === s.timeframe ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:text-ink'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <Chart symbol={s.chartSymbol} timeframe={s.timeframe} />
          <OrderTicket symbol={s.chartSymbol} mark={s.marks[s.chartSymbol] ?? null} />
        </div>

        {/* right: P&L + tabs */}
        <div className="flex w-[46%] min-w-[360px] flex-col">
          {/* P&L summary */}
          <div className="grid grid-cols-2 gap-2 border-b border-edge p-3 sm:grid-cols-4">
            <div className="rounded-lg border border-edge bg-surface p-2">
              <div className="text-[10px] text-muted">Open P&L</div>
              <div className={`text-sm font-bold tabular-nums ${tone(openPnl)}`}>{signed(openPnl)}</div>
            </div>
            <div className="rounded-lg border border-edge bg-surface p-2">
              <div className="text-[10px] text-muted">Realized today</div>
              <div className={`text-sm font-bold tabular-nums ${tone(realizedToday)}`}>{signed(realizedToday)}</div>
            </div>
            <div className="rounded-lg border border-edge bg-surface p-2">
              <div className="text-[10px] text-muted">This week</div>
              <div className={`text-sm font-bold tabular-nums ${tone(realizedWeek)}`}>{signed(realizedWeek)}</div>
            </div>
            <div className="rounded-lg border border-edge bg-surface p-2">
              <div className="text-[10px] text-muted">This month</div>
              <div className={`text-sm font-bold tabular-nums ${tone(realizedMonth)}`}>{signed(realizedMonth)}</div>
            </div>
          </div>

          {/* tabs */}
          <div className="flex gap-1 border-b border-edge px-2 pt-1">
            {(['positions', 'history', 'review'] as Tab[]).map((t) => (
              <button key={t} onClick={() => s.setTab(t)} className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm capitalize ${t === s.tab ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
                {t}
                {t === 'positions' && acct && acct.positions.length > 0 ? ` (${acct.positions.length})` : ''}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {s.loading ? (
              <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
                <Loader2 size={15} className="animate-spin" /> Loading…
              </div>
            ) : s.tab === 'positions' ? (
              acct && acct.positions.length > 0 ? (
                <div className="space-y-2">
                  {acct.positions.map((p) => (
                    <PositionRow key={p.id} p={p} mark={posMark(p)} />
                  ))}
                </div>
              ) : (
                <p className="p-6 text-center text-sm text-muted">No open positions. Buy or short the charted symbol below.</p>
              )
            ) : s.tab === 'history' ? (
              acct && acct.closed.length > 0 ? (
                <div className="space-y-1">
                  {acct.closed.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 rounded-lg border border-edge bg-surface p-2 text-xs">
                      <span className="font-semibold">{c.symbol}</span>
                      <span className={`rounded px-1 py-0.5 text-[10px] uppercase ${c.side === 'short' ? 'bg-danger/15 text-danger' : 'bg-ok/15 text-ok'}`}>{c.kind === 'option' ? c.optionType : c.side}</span>
                      <span className="text-muted">
                        {c.qty} @ {price(c.entryPrice)} → {price(c.exitPrice)}
                      </span>
                      {c.reason !== 'manual' && <span className="rounded bg-warn/15 px-1 py-0.5 text-[10px] text-warn">{c.reason}</span>}
                      <span className={`ml-auto font-bold tabular-nums ${tone(c.pnl)}`}>{signed(c.pnl)}</span>
                      <span className="w-28 shrink-0 text-right text-[10px] text-muted">{fmtDate(c.exitAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="p-6 text-center text-sm text-muted">No closed trades yet.</p>
              )
            ) : (
              <div>
                <Review closed={acct?.closed ?? []} />
                {symRows.length > 0 && (
                  <div className="mt-3 px-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Symbol P&L</div>
                    <div className="space-y-1">
                      {symRows.map(([sym, v]) => (
                        <div key={sym} className="flex items-center justify-between rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-sm">
                          <span className="font-medium">{sym}</span>
                          <span className={`font-bold tabular-nums ${tone(v)}`}>{signed(v)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {showAccounts && <AccountsModal onClose={() => setShowAccounts(false)} />}
    </div>
  )
}

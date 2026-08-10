import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type UTCTimestamp
} from 'lightweight-charts'
import {
  AlertTriangle,
  Camera,
  Loader2,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  X
} from 'lucide-react'

const ID = 'trade-now'

interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface TradeLeg {
  id: string
  side: 'buy' | 'sell'
  price: number
  quantity: number
  at: number
}

interface TradeSummary {
  buyQty: number
  sellQty: number
  openShares: number
  avgBuy: number
  totalBought: number
  totalSold: number
  realized: number
  openCost: number
  status: 'open' | 'closed'
  firstAt: number
  lastAt: number
}

interface Entry {
  id: string
  symbol: string
  name: string
  createdAt: number
  high52: number | null
  low52: number | null
  reason: string
  prediction: string
  legs: TradeLeg[]
  summary: TradeSummary
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

function cssRGB(varName: string, fallback: string): string {
  try {
    const s = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    if (!s) return fallback
    const p = s.split(/[\s,]+/).filter(Boolean)
    return p.length >= 3 ? `rgb(${p[0]}, ${p[1]}, ${p[2]})` : s.startsWith('#') || s.startsWith('rgb') ? s : fallback
  } catch {
    return fallback
  }
}

const money = (v: number | null | undefined, dp = 2): string =>
  v == null || !Number.isFinite(v)
    ? 'n/a'
    : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`

const qty = (v: number): string => (Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 4 }))

const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

/** yyyy-mm-dd for a date input (local). */
const toDateInput = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const fromDateInput = (s: string): number => {
  const d = new Date(`${s}T12:00:00`)
  return Number.isFinite(d.getTime()) ? d.getTime() : Date.now()
}

export default function TradeNow(): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ticker, setTicker] = useState('')
  const [newQty, setNewQty] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [hasMassive, setHasMassive] = useState(true)

  const refreshList = async (): Promise<Entry[]> => {
    const res = (await invoke('list')) as { ok?: boolean; entries?: Entry[] }
    const list = res.ok && res.entries ? res.entries : []
    setEntries(list)
    return list
  }

  useEffect(() => {
    void (async () => {
      const st = (await invoke('status')) as { hasMassive?: boolean }
      setHasMassive(st?.hasMassive !== false)
      await refreshList()
    })()
  }, [])

  const selected = entries.find((e) => e.id === selectedId) ?? null

  const snapshot = async (): Promise<void> => {
    const symbol = ticker.trim().toUpperCase()
    if (!symbol || creating) return
    setCreating(true)
    setError('')
    const res = (await invoke('create', {
      symbol,
      quantity: Number(newQty) || 0,
      buyPrice: Number(newPrice) || undefined
    })) as { ok?: boolean; entry?: Entry; error?: string }
    setCreating(false)
    if (res.ok && res.entry) {
      setTicker('')
      setNewQty('')
      setNewPrice('')
      await refreshList()
      setSelectedId(res.entry.id)
    } else {
      setError(res.error ?? 'Could not create the position.')
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    await invoke('delete', { id })
    if (selectedId === id) setSelectedId(null)
    await refreshList()
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Camera size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight"><ModuleTitle fallback="Trade Now" /></h1>
          <p className="truncate text-xs text-muted">
            Snapshot the moment you buy, then track the position — add buys/sells over time until it's closed.
          </p>
        </div>
      </header>

      {!hasMassive && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-xs text-warn">
          <AlertTriangle size={13} className="shrink-0" />
          Add your <strong>Massive/Polygon</strong> key in Settings → API Keys to use Trade Now.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-xs text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left: new position + list */}
        <div className="flex w-[300px] shrink-0 flex-col border-r border-edge">
          <div className="border-b border-edge p-3">
            <label className="text-xs font-semibold text-muted">Open a new position</label>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void snapshot()
              }}
              placeholder="Ticker (e.g. JBLU)"
              spellCheck={false}
              className="mt-1.5 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm font-semibold outline-none placeholder:font-normal focus:border-accent"
            />
            <div className="mt-1.5 flex gap-1.5">
              <input
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                type="number"
                min="0"
                placeholder="Shares"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              <input
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                type="number"
                min="0"
                step="0.01"
                placeholder="Buy $ (opt)"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
            </div>
            <button
              onClick={() => void snapshot()}
              disabled={creating || !ticker.trim() || !hasMassive}
              className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
              Snap the buy
            </button>
            <p className="mt-1.5 text-[11px] leading-snug text-muted">
              Leave the buy price blank to use the current market price. You can edit everything after.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {entries.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted">
                No positions yet. Enter a ticker and snap your buy.
              </p>
            ) : (
              entries.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setSelectedId(e.id)}
                  className={`mb-1 w-full rounded-lg border px-2.5 py-2 text-left ${
                    selectedId === e.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-raised'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold">{e.symbol}</span>
                    <StatusPill status={e.summary.status} />
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted">
                    <span>
                      {e.summary.status === 'open'
                        ? `${qty(e.summary.openShares)} sh @ ${money(e.summary.avgBuy)}`
                        : `closed · ${fmtDate(e.summary.lastAt)}`}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* right: position detail */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <PositionView key={selected.id} entry={selected} onChanged={refreshList} onDelete={removeEntry} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
              <div>
                <Camera size={30} className="mx-auto mb-3 opacity-40" />
                Open a position on the left, or pick one from the list.
                <br />
                Each position stays <strong>In Trade</strong> until you&apos;ve sold everything you bought.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: 'open' | 'closed' }): React.JSX.Element {
  return status === 'open' ? (
    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">In Trade</span>
  ) : (
    <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] font-semibold uppercase text-muted">Closed</span>
  )
}

/* ------------------------------ position view ----------------------------- */

function PositionView({
  entry,
  onChanged,
  onDelete
}: {
  entry: Entry
  onChanged: () => Promise<Entry[]>
  onDelete: (id: string) => Promise<void>
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [reason, setReason] = useState(entry.reason)
  const [prediction, setPrediction] = useState(entry.prediction)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [price, setPrice] = useState<number | null>(null)
  const [bars, setBars] = useState<Bar[]>([])
  const [adding, setAdding] = useState<'buy' | 'sell' | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const s = entry.summary
  // seed notes when switching positions
  useEffect(() => {
    setReason(entry.reason)
    setPrediction(entry.prediction)
  }, [entry.id])

  // load the position-spanning chart + latest price
  useEffect(() => {
    let alive = true
    void (async () => {
      const res = (await invoke('chart', { id: entry.id })) as { ok?: boolean; bars?: Bar[]; price?: number | null }
      if (!alive) return
      if (res.ok) {
        setBars(res.bars ?? [])
        if (typeof res.price === 'number') setPrice(res.price)
      }
    })()
    return () => {
      alive = false
    }
  }, [entry.id, entry.legs.length])

  // draw chart with a marker for every leg
  useEffect(() => {
    const el = wrapRef.current
    if (!el || bars.length === 0) return
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
    const down = cssRGB('--wk-danger', '#ef4444')
    const candle = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down
    })
    candle.setData(
      bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
    )
    const markers = [...entry.legs]
      .sort((a, b) => a.at - b.at)
      .map((leg) => ({
        time: Math.floor(leg.at / 1000) as UTCTimestamp,
        position: leg.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        color: leg.side === 'buy' ? up : down,
        shape: leg.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        text: `${leg.side === 'buy' ? 'BUY' : 'SELL'} ${qty(leg.quantity)} @ ${money(leg.price)}`
      }))
    candle.setMarkers(markers)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [bars, entry.legs])

  const scheduleSaveNotes = (r: string, p: string): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void invoke('update-notes', { id: entry.id, reason: r, prediction: p })
    }, 500)
  }

  const openShares = s.openShares
  const marketValue = price != null ? Math.max(0, openShares) * price : null
  const unrealized = price != null ? Math.max(0, openShares) * (price - s.avgBuy) : null
  const totalPnl = (s.realized || 0) + (unrealized ?? 0)
  const pnlPct = s.avgBuy > 0 && price != null ? ((price - s.avgBuy) / s.avgBuy) * 100 : null

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight">{entry.symbol}</h2>
            <StatusPill status={s.status} />
            <span className="truncate text-sm text-muted">{entry.name}</span>
          </div>
          <p className="mt-0.5 text-sm text-muted">
            Opened {fmtDate(entry.createdAt)} · 52-wk {money(entry.low52)}–{money(entry.high52)}
            {price != null && (
              <>
                {' '}· now <span className="font-semibold text-ink">{money(price)}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-muted">Delete this position?</span>
              <button onClick={() => void onDelete(entry.id)} className="rounded-lg bg-danger px-2.5 py-1.5 font-medium text-white hover:opacity-90">
                Delete
              </button>
              <button onClick={() => setConfirmDelete(false)} className="rounded-lg border border-edge px-2.5 py-1.5 text-muted hover:bg-raised">
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete this position"
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-danger"
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>

      {/* stat chips */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={s.status === 'open' ? 'Shares held' : 'Shares (all sold)'} value={qty(Math.max(0, openShares))} />
        <Stat label="Avg buy price" value={money(s.avgBuy)} />
        <Stat label="Cost basis (open)" value={money(s.openCost)} />
        <Stat
          label="Market value"
          value={marketValue != null ? money(marketValue) : '…'}
        />
        <Stat label="Total bought" value={money(s.totalBought)} sub={`${qty(s.buyQty)} sh`} />
        <Stat label="Total sold" value={money(s.totalSold)} sub={`${qty(s.sellQty)} sh`} />
        <Stat
          label="Realized P/L"
          value={money(s.realized)}
          tone={s.realized > 0 ? 'ok' : s.realized < 0 ? 'danger' : undefined}
        />
        <Stat
          label={s.status === 'open' ? 'Unrealized P/L' : 'Total P/L'}
          value={s.status === 'open' ? (unrealized != null ? money(unrealized) : '…') : money(totalPnl)}
          sub={s.status === 'open' && pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : undefined}
          tone={(s.status === 'open' ? unrealized ?? 0 : totalPnl) > 0 ? 'ok' : (s.status === 'open' ? unrealized ?? 0 : totalPnl) < 0 ? 'danger' : undefined}
        />
      </div>

      {/* the ledger */}
      <div className="rounded-xl border border-edge bg-surface">
        <div className="flex items-center justify-between border-b border-edge px-3 py-2">
          <span className="text-sm font-semibold">Order ledger</span>
          <div className="flex gap-1.5">
            <button
              onClick={() => setAdding('buy')}
              className="flex items-center gap-1 rounded-lg bg-ok/15 px-2.5 py-1 text-xs font-medium text-ok hover:bg-ok/25"
            >
              <Plus size={12} /> Add buy
            </button>
            <button
              onClick={() => setAdding('sell')}
              className="flex items-center gap-1 rounded-lg bg-danger/15 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/25"
            >
              <Plus size={12} /> Add sell
            </button>
          </div>
        </div>
        <div className="divide-y divide-edge">
          {[...entry.legs]
            .sort((a, b) => a.at - b.at)
            .map((leg) => (
              <LegRow key={leg.id} entryId={entry.id} leg={leg} onChanged={onChanged} />
            ))}
          {entry.legs.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-muted">No orders yet.</div>
          )}
        </div>
        {adding && (
          <LegForm
            entryId={entry.id}
            side={adding}
            defaultPrice={adding === 'sell' ? price ?? undefined : undefined}
            onClose={() => setAdding(null)}
            onChanged={onChanged}
          />
        )}
      </div>

      {/* chart */}
      <div className="rounded-xl border border-edge bg-surface p-3">
        <div className="text-xs font-semibold text-muted">
          Chart from your first buy to now — every buy (▲) and sell (▼) is marked
        </div>
        {bars.length > 0 ? (
          <div ref={wrapRef} className="mt-2 h-[320px] w-full" />
        ) : (
          <p className="py-10 text-center text-xs text-muted">Loading chart…</p>
        )}
      </div>

      {/* thesis */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-edge bg-surface p-3">
          <label className="text-xs font-semibold">Why I bought</label>
          <textarea
            rows={4}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              scheduleSaveNotes(e.target.value, prediction)
            }}
            maxLength={2000}
            placeholder="The setup, the catalyst, what you saw…"
            className="mt-1.5 w-full resize-none rounded-lg bg-raised/40 px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted/60 focus:bg-raised/70"
          />
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <label className="text-xs font-semibold">My prediction</label>
          <textarea
            rows={4}
            value={prediction}
            onChange={(e) => {
              setPrediction(e.target.value)
              scheduleSaveNotes(reason, e.target.value)
            }}
            maxLength={2000}
            placeholder="Where it's going, by when, and what would prove you wrong…"
            className="mt-1.5 w-full resize-none rounded-lg bg-raised/40 px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted/60 focus:bg-raised/70"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted">
        Notes save automatically. Prices come from your market-data feed (15-minute delayed). Realized P/L uses
        average cost.
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone
}: {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'danger'
}): React.JSX.Element {
  const color = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-ink'
  return (
    <div className="rounded-xl border border-edge bg-surface p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 flex items-baseline gap-1.5 text-lg font-bold tabular-nums ${color}`}>
        {tone && (tone === 'ok' ? <TrendingUp size={15} /> : <TrendingDown size={15} />)}
        {value}
        {sub && <span className="text-xs font-semibold">{sub}</span>}
      </div>
    </div>
  )
}

/* -------------------------------- leg rows -------------------------------- */

function LegRow({
  entryId,
  leg,
  onChanged
}: {
  entryId: string
  leg: TradeLeg
  onChanged: () => Promise<Entry[]>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <LegForm
        entryId={entryId}
        side={leg.side}
        leg={leg}
        onClose={() => setEditing(false)}
        onChanged={onChanged}
      />
    )
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
          leg.side === 'buy' ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger'
        }`}
      >
        {leg.side}
      </span>
      <span className="tabular-nums">
        {qty(leg.quantity)} @ {money(leg.price)}
      </span>
      <span className="tabular-nums text-muted">= {money(leg.quantity * leg.price)}</span>
      <span className="ml-auto text-xs text-muted">{fmtDate(leg.at)}</span>
      <button
        onClick={() => setEditing(true)}
        className="rounded px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink"
      >
        Edit
      </button>
    </div>
  )
}

function LegForm({
  entryId,
  side,
  leg,
  defaultPrice,
  onClose,
  onChanged
}: {
  entryId: string
  side: 'buy' | 'sell'
  leg?: TradeLeg
  defaultPrice?: number
  onClose: () => void
  onChanged: () => Promise<Entry[]>
}): React.JSX.Element {
  const [sideVal, setSideVal] = useState<'buy' | 'sell'>(leg?.side ?? side)
  const [price, setPrice] = useState(leg ? String(leg.price) : defaultPrice ? String(defaultPrice) : '')
  const [quantity, setQuantity] = useState(leg ? String(leg.quantity) : '')
  const [date, setDate] = useState(toDateInput(leg?.at ?? Date.now()))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (): Promise<void> => {
    const p = Number(price)
    const q = Number(quantity)
    if (!(p > 0) || !(q > 0)) {
      setErr('Enter a price and quantity greater than 0.')
      return
    }
    setBusy(true)
    const payload = { id: entryId, side: sideVal, price: p, quantity: q, at: fromDateInput(date) }
    const res = leg
      ? ((await invoke('update-leg', { ...payload, legId: leg.id })) as { ok?: boolean; error?: string })
      : ((await invoke('add-leg', payload)) as { ok?: boolean; error?: string })
    setBusy(false)
    if (res.ok) {
      await onChanged()
      onClose()
    } else {
      setErr(res.error ?? 'Could not save.')
    }
  }

  const remove = async (): Promise<void> => {
    if (!leg) return
    setBusy(true)
    await invoke('delete-leg', { id: entryId, legId: leg.id })
    await onChanged()
    onClose()
  }

  const inp = 'rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent'
  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-edge bg-raised/30 px-3 py-2.5">
      <label className="flex flex-col gap-0.5 text-[10px] uppercase text-muted">
        Side
        <select value={sideVal} onChange={(e) => setSideVal(e.target.value as 'buy' | 'sell')} className={inp}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase text-muted">
        Shares
        <input type="number" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`${inp} w-24`} />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase text-muted">
        Price
        <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className={`${inp} w-24`} />
      </label>
      <label className="flex flex-col gap-0.5 text-[10px] uppercase text-muted">
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inp} />
      </label>
      <div className="ml-auto flex items-center gap-1.5">
        {leg && (
          <button onClick={() => void remove()} disabled={busy} title="Delete this order" className="rounded-lg p-2 text-muted hover:bg-danger/15 hover:text-danger">
            <Trash2 size={14} />
          </button>
        )}
        <button onClick={onClose} className="rounded-lg p-2 text-muted hover:bg-raised">
          <X size={14} />
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {leg ? 'Save' : 'Add'}
        </button>
      </div>
      {err && <p className="w-full text-xs text-danger">{err}</p>}
    </div>
  )
}

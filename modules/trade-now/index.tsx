import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type UTCTimestamp
} from 'lightweight-charts'
import { AlertTriangle, Camera, Loader2, Trash2, TrendingDown, TrendingUp } from 'lucide-react'

const ID = 'trade-now'

interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface EntryMeta {
  id: string
  symbol: string
  name: string
  boughtAt: number
  price: number | null
  high52: number | null
  low52: number | null
  reason: string
  prediction: string
}

interface Entry extends EntryMeta {
  bars: Bar[]
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

const fmtMoney = (v: number | null): string =>
  v == null ? 'n/a' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function TradeNow(): React.JSX.Element {
  const [entries, setEntries] = useState<EntryMeta[]>([])
  const [selected, setSelected] = useState<Entry | null>(null)
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [hasMassive, setHasMassive] = useState(true)

  const refreshList = async (): Promise<void> => {
    const res = (await invoke('list')) as { ok?: boolean; entries?: EntryMeta[] }
    if (res.ok && res.entries) setEntries(res.entries)
  }

  useEffect(() => {
    void (async () => {
      const st = (await invoke('status')) as { hasMassive?: boolean }
      setHasMassive(st?.hasMassive !== false)
      await refreshList()
    })()
  }, [])

  const openEntry = async (id: string): Promise<void> => {
    const res = (await invoke('get', { id })) as { ok?: boolean; entry?: Entry; error?: string }
    if (res.ok && res.entry) setSelected(res.entry)
    else setError(res.error ?? 'Could not open that snapshot.')
  }

  const snapshot = async (): Promise<void> => {
    const symbol = input.trim().toUpperCase()
    if (!symbol || creating) return
    setCreating(true)
    setError('')
    const res = (await invoke('create', { symbol })) as { ok?: boolean; entry?: Entry; error?: string }
    setCreating(false)
    if (res.ok && res.entry) {
      setInput('')
      setSelected(res.entry)
      await refreshList()
    } else {
      setError(res.error ?? 'Could not create the snapshot.')
    }
  }

  const removeEntry = async (id: string): Promise<void> => {
    await invoke('delete', { id })
    if (selected?.id === id) setSelected(null)
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
            Snapshot the moment you buy — price, 52-week range, the chart marked at your entry, and your thesis.
          </p>
        </div>
      </header>

      {!hasMassive && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-xs text-warn">
          <AlertTriangle size={13} className="shrink-0" />
          Add your <strong>Massive/Polygon</strong> key in Settings → API Keys to take snapshots.
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-xs text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left: capture + history */}
        <div className="flex w-[280px] shrink-0 flex-col border-r border-edge">
          <div className="border-b border-edge p-3">
            <label className="text-xs font-semibold text-muted">I just bought…</label>
            <div className="mt-1.5 flex gap-1.5">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void snapshot()
                }}
                placeholder="Ticker"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm font-semibold outline-none placeholder:font-normal focus:border-accent"
              />
              <button
                onClick={() => void snapshot()}
                disabled={creating || !input.trim() || !hasMassive}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
                Snap
              </button>
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-muted">
              Captures this exact moment: price, 52-week range and the chart with your entry marked.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {entries.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted">
                No snapshots yet. Type the ticker you just bought and hit Snap.
              </p>
            ) : (
              entries.map((e) => (
                <button
                  key={e.id}
                  onClick={() => void openEntry(e.id)}
                  className={`mb-1 w-full rounded-lg border px-2.5 py-2 text-left ${
                    selected?.id === e.id ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-raised'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold">{e.symbol}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted">{fmtMoney(e.price)}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted">{fmtWhen(e.boughtAt)}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* right: the snapshot */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <SnapshotView key={selected.id} entry={selected} onDelete={removeEntry} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
              <div>
                <Camera size={30} className="mx-auto mb-3 opacity-40" />
                Take a snapshot on the left, or open one from the history.
                <br />
                Each snapshot is frozen at the moment you bought — the chart never changes afterwards.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ snapshot view ------------------------------ */

function SnapshotView({
  entry,
  onDelete
}: {
  entry: Entry
  onDelete: (id: string) => Promise<void>
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [reason, setReason] = useState(entry.reason)
  const [prediction, setPrediction] = useState(entry.prediction)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [now, setNow] = useState<{ price: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // live "where is it now" vs the frozen buy price
  useEffect(() => {
    void (async () => {
      const res = (await invoke('quote', { symbol: entry.symbol })) as { ok?: boolean; price?: number }
      if (res.ok && typeof res.price === 'number') setNow({ price: res.price })
    })()
  }, [entry.symbol])

  // the frozen chart with the BUY mark at the entry moment
  useEffect(() => {
    const el = wrapRef.current
    if (!el || entry.bars.length === 0) return
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
    const accent = cssRGB('--wk-accent', '#e11d48')
    const candle = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down
    })
    candle.setData(
      entry.bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
    )
    const last = entry.bars[entry.bars.length - 1]
    candle.setMarkers([
      {
        time: Math.floor(last.t / 1000) as UTCTimestamp,
        position: 'belowBar',
        color: accent,
        shape: 'arrowUp',
        text: `BUY ${fmtMoney(entry.price)}`
      }
    ])
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [entry])

  const scheduleSave = (nextReason: string, nextPrediction: string): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void invoke('update-notes', { id: entry.id, reason: nextReason, prediction: nextPrediction })
    }, 500)
  }

  const delta = now && entry.price ? ((now.price - entry.price) / entry.price) * 100 : null

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-xl font-bold tracking-tight">{entry.symbol}</h2>
            <span className="truncate text-sm text-muted">{entry.name}</span>
          </div>
          <p className="mt-0.5 text-sm text-muted">
            Bought <span className="font-semibold text-ink">{fmtWhen(entry.boughtAt)}</span> at{' '}
            <span className="font-semibold text-ink">{fmtMoney(entry.price)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {confirmDelete ? (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-muted">Delete this snapshot?</span>
              <button
                onClick={() => void onDelete(entry.id)}
                className="rounded-lg bg-danger px-2.5 py-1.5 font-medium text-white hover:opacity-90"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-lg border border-edge px-2.5 py-1.5 text-muted hover:bg-raised"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete this snapshot"
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-danger"
            >
              <Trash2 size={13} /> Delete
            </button>
          )}
        </div>
      </div>

      {/* stat chips */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Price at buy</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{fmtMoney(entry.price)}</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">52-week high</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{fmtMoney(entry.high52)}</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">52-week low</div>
          <div className="mt-1 text-lg font-bold tabular-nums">{fmtMoney(entry.low52)}</div>
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted">Now</div>
          {now && delta != null ? (
            <div className={`mt-1 flex items-center gap-1.5 text-lg font-bold tabular-nums ${delta >= 0 ? 'text-ok' : 'text-danger'}`}>
              {delta >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
              {fmtMoney(now.price)}
              <span className="text-xs font-semibold">
                {delta >= 0 ? '+' : ''}
                {delta.toFixed(1)}%
              </span>
            </div>
          ) : (
            <div className="mt-1 text-lg font-bold text-muted">…</div>
          )}
        </div>
      </div>

      {/* the frozen, marked chart */}
      <div className="rounded-xl border border-edge bg-surface p-3">
        <div className="flex items-baseline justify-between">
          <div className="text-xs font-semibold text-muted">
            The chart as it looked when you bought (4h candles, ~90 days) — frozen forever
          </div>
        </div>
        {entry.bars.length > 0 ? (
          <div ref={wrapRef} className="mt-2 h-[340px] w-full" />
        ) : (
          <p className="py-10 text-center text-xs text-muted">No chart bars were available at capture time.</p>
        )}
      </div>

      {/* thesis */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-edge bg-surface p-3">
          <label className="text-xs font-semibold">Why I bought</label>
          <textarea
            rows={5}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              scheduleSave(e.target.value, prediction)
            }}
            maxLength={2000}
            placeholder="The setup, the catalyst, what you saw…"
            className="mt-1.5 w-full resize-none rounded-lg bg-raised/40 px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted/60 focus:bg-raised/70"
          />
        </div>
        <div className="rounded-xl border border-edge bg-surface p-3">
          <label className="text-xs font-semibold">My prediction</label>
          <textarea
            rows={5}
            value={prediction}
            onChange={(e) => {
              setPrediction(e.target.value)
              scheduleSave(reason, e.target.value)
            }}
            maxLength={2000}
            placeholder="Where it's going, by when, and what would prove you wrong…"
            className="mt-1.5 w-full resize-none rounded-lg bg-raised/40 px-2.5 py-2 text-sm leading-relaxed outline-none placeholder:text-muted/60 focus:bg-raised/70"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted">
        Notes save automatically. Prices come from your market-data feed (15-minute delayed).
      </p>
    </div>
  )
}

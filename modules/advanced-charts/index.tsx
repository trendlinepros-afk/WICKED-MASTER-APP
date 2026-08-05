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
import { AlertTriangle, LayoutGrid, LineChart, Loader2 } from 'lucide-react'

const ID = 'advanced-charts'

interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/** Candle durations offered everywhere (top override + per-chart). */
const INTERVALS = [
  { id: '1m', label: '1 min' },
  { id: '5m', label: '5 min' },
  { id: '15m', label: '15 min' },
  { id: '30m', label: '30 min' },
  { id: '1h', label: '1 hour' },
  { id: '2h', label: '2 hours' },
  { id: '4h', label: '4 hours' },
  { id: '1D', label: 'Daily' },
  { id: '1W', label: 'Weekly' }
] as const

const DEFAULT_TF = '4h'
const LAYOUTS = [1, 2, 4, 6, 8, 10, 12] as const

/** Grid columns per layout; rows fill in via auto-rows. */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  4: 'grid-cols-2',
  6: 'grid-cols-3',
  8: 'grid-cols-4',
  10: 'grid-cols-5',
  12: 'grid-cols-4'
}

/** Resolve a shell theme token to an rgb() string. Tokens are space-separated RGB
 *  ("34 197 94"); lightweight-charts only parses comma-separated rgb(), so join with commas. */
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

export default function AdvancedCharts(): React.JSX.Element {
  const [layout, setLayout] = useState<number>(() => {
    const n = Number(localStorage.getItem('ac-layout'))
    return (LAYOUTS as readonly number[]).includes(n) ? n : 4
  })
  const [globalTf, setGlobalTf] = useState<string>(
    () => localStorage.getItem('ac-tf') ?? DEFAULT_TF
  )
  // bumped every time the top dropdown changes → every chart snaps to globalTf
  const [tfEpoch, setTfEpoch] = useState(0)
  const [hasMassive, setHasMassive] = useState(true)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const noteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    void (async () => {
      const st = (await window.wicked.invoke(`${ID}:status`)) as { hasMassive?: boolean }
      setHasMassive(st?.hasMassive !== false)
      const res = (await window.wicked.invoke(`${ID}:notes-get`)) as { notes?: Record<string, string> }
      if (res?.notes) setNotes(res.notes)
    })()
  }, [])

  /** Update a ticker's note locally and persist it (debounced per ticker). */
  const onNote = (symbol: string, text: string): void => {
    setNotes((n) => ({ ...n, [symbol]: text }))
    const timers = noteTimers.current
    const t = timers.get(symbol)
    if (t) clearTimeout(t)
    timers.set(
      symbol,
      setTimeout(() => {
        timers.delete(symbol)
        void window.wicked.invoke(`${ID}:note-set`, { symbol, text })
      }, 500)
    )
  }

  const overrideAll = (tf: string): void => {
    setGlobalTf(tf)
    setTfEpoch((e) => e + 1)
    localStorage.setItem('ac-tf', tf)
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-2">
        <LineChart size={16} className="text-accent" />
        <span className="text-sm font-semibold"><ModuleTitle fallback="Advanced Charts" /></span>

        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">
          <LayoutGrid size={13} />
          Charts
          <select
            value={layout}
            onChange={(e) => {
              const n = Number(e.target.value)
              setLayout(n)
              localStorage.setItem('ac-layout', String(n))
            }}
            className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            {LAYOUTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted">
          Candles
          <select
            value={globalTf}
            onChange={(e) => overrideAll(e.target.value)}
            title="Sets the candle duration on ALL charts (overrides per-chart choices)"
            className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            {INTERVALS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-muted">applies to all charts · each chart can differ until you change this</span>

        <span className="ml-auto text-[11px] text-muted">Lightweight Charts · Massive data</span>
      </div>

      {!hasMassive && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-4 py-2 text-xs text-warn">
          <AlertTriangle size={13} className="shrink-0" />
          Add your <strong>Massive/Polygon</strong> key in Settings → API Keys to load charts.
        </div>
      )}

      {/* chart grid */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`grid min-h-full auto-rows-[minmax(300px,1fr)] gap-3 p-3 ${GRID_COLS[layout] ?? 'grid-cols-2'}`}>
          {Array.from({ length: layout }, (_, i) => (
            <ChartTile
              key={i}
              globalTf={globalTf}
              tfEpoch={tfEpoch}
              notes={notes}
              onNote={onNote}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------- one chart ------------------------------- */

function ChartTile({
  globalTf,
  tfEpoch,
  notes,
  onNote
}: {
  globalTf: string
  tfEpoch: number
  notes: Record<string, string>
  onNote: (symbol: string, text: string) => void
}): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  const [input, setInput] = useState('')
  const [symbol, setSymbol] = useState('')
  const [tf, setTf] = useState(globalTf)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // The top dropdown overrides every chart whenever it changes.
  useEffect(() => {
    setTf(globalTf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tfEpoch])

  // Build the chart once.
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
    const down = cssRGB('--wk-danger', '#ef4444')
    const candle = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down
    })
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    chartRef.current = chart
    candleRef.current = candle
    volRef.current = vol
    return () => {
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volRef.current = null
    }
  }, [])

  // Load candles on symbol / interval change.
  useEffect(() => {
    if (!symbol) return
    let alive = true
    void (async () => {
      setLoading(true)
      setError('')
      const res = (await window.wicked.invoke(`${ID}:candles`, { symbol, timeframe: tf })) as {
        ok?: boolean
        bars?: Bar[]
        error?: string
        note?: string
      }
      if (!alive) return
      setLoading(false)
      const bars = res?.bars ?? []
      if (!bars.length) {
        setError(res?.error || res?.note || 'No data.')
        candleRef.current?.setData([])
        volRef.current?.setData([])
        return
      }
      const up = cssRGB('--wk-ok', '#22c55e')
      const down = cssRGB('--wk-danger', '#ef4444')
      candleRef.current?.setData(
        bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }))
      )
      volRef.current?.setData(
        bars.map((b) => ({ time: Math.floor(b.t / 1000) as UTCTimestamp, value: b.v, color: b.c >= b.o ? up : down }))
      )
      chartRef.current?.timeScale().fitContent()
    })()
    return () => {
      alive = false
    }
  }, [symbol, tf])

  const submit = (): void => {
    const s = input.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10)
    if (s) {
      setInput(s)
      setSymbol(s)
      setError('')
    }
  }

  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-edge bg-surface">
      {/* tile header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          onBlur={() => {
            if (input.trim() && input.trim().toUpperCase() !== symbol) submit()
          }}
          placeholder="Ticker"
          spellCheck={false}
          className="w-20 min-w-0 rounded-md border border-edge bg-raised px-2 py-1 text-xs font-semibold outline-none placeholder:font-normal focus:border-accent"
        />
        {loading && <Loader2 size={12} className="shrink-0 animate-spin text-muted" />}
        {error && symbol && (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-danger" title={error}>
            {error}
          </span>
        )}
        <select
          value={tf}
          onChange={(e) => setTf(e.target.value)}
          title="Candle duration for this chart only (the top dropdown overrides it)"
          className="ml-auto shrink-0 rounded-md border border-edge bg-raised px-1.5 py-1 text-[11px] text-muted outline-none focus:border-accent"
        >
          {INTERVALS.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
      </div>

      {/* chart */}
      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className="absolute inset-0" />
        {!symbol && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted">
            Type a ticker above and press Enter to load this chart.
          </div>
        )}
      </div>

      {/* per-ticker note */}
      <div className="shrink-0 border-t border-edge p-1.5">
        <textarea
          rows={2}
          value={symbol ? notes[symbol] ?? '' : ''}
          disabled={!symbol}
          onChange={(e) => {
            if (symbol) onNote(symbol, e.target.value)
          }}
          maxLength={500}
          placeholder={symbol ? `Notes for ${symbol} — saved automatically, follows the ticker` : 'Notes appear here once a ticker is loaded'}
          className="w-full resize-none rounded-md bg-raised/40 px-2 py-1 text-xs leading-snug text-ink outline-none placeholder:text-muted/60 focus:bg-raised/70 disabled:opacity-50"
        />
      </div>
    </div>
  )
}

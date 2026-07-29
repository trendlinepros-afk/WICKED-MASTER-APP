import { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { AlertTriangle, LineChart, Loader2, Search } from 'lucide-react'

const ID = 'advanced-charts'

interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}
const TFS = ['1D', '5D', '1M', '3M', '1Y'] as const
type TF = (typeof TFS)[number]

/** Resolve a shell theme token (space-separated RGB, e.g. "34 197 94") to an rgb() string. */
function cssRGB(varName: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
    return v ? `rgb(${v})` : fallback
  } catch {
    return fallback
  }
}

export default function AdvancedCharts(): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)

  const [symbol, setSymbol] = useState('SPY')
  const [input, setInput] = useState('SPY')
  const [tf, setTf] = useState<TF>('1D')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasMassive, setHasMassive] = useState(true)

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

  // Load candles on symbol / timeframe change.
  useEffect(() => {
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
      if (res?.error && /massive|api key/i.test(res.error)) setHasMassive(false)
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
    const s = input.trim().toUpperCase()
    if (s) {
      setSymbol(s)
      setError('')
    }
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <LineChart size={16} className="text-accent" />
        <div className="flex items-center rounded-lg border border-edge bg-raised pl-2">
          <Search size={13} className="text-muted" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            placeholder="Symbol"
            className="w-24 bg-transparent px-2 py-1.5 text-sm outline-none"
          />
        </div>
        <span className="text-sm font-semibold text-ink">{symbol}</span>
        <div className="ml-2 flex items-center gap-1">
          {TFS.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${t === tf ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:text-ink'}`}
            >
              {t}
            </button>
          ))}
        </div>
        {loading && <Loader2 size={14} className="animate-spin text-muted" />}
        <span className="ml-auto text-[11px] text-muted">Lightweight Charts · Massive data</span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={wrapRef} className="absolute inset-0" />
        {!hasMassive && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/80 p-8 text-center">
            <div className="max-w-sm text-sm text-muted">
              <AlertTriangle size={22} className="mx-auto mb-2 text-warn" />
              Add your <strong className="text-ink">Massive/Polygon</strong> key in Settings → API Keys to load charts.
            </div>
          </div>
        )}
        {hasMassive && error && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-lg bg-danger/10 px-3 py-1.5 text-xs text-danger">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

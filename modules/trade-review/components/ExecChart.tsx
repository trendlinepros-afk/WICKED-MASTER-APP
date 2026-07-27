import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Hand-rolled SVG execution chart (ported — no chart library): 1-minute
 * candles with buy/sell triangle markers, qty@price labels, dashed green/red
 * connector lines per round trip, wheel zoom about the cursor, drag pan, and
 * fit-trades / full-day framing. Colors are hardcoded (not theme vars) so the
 * SVG serializes cleanly to PNG for the PDF.
 */

export interface ChartBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface ChartFill {
  side: 'buy' | 'sell' | 'short'
  qty: number
  price: number
  at: number | null
}

export interface ChartTrip {
  openedAt: number | null
  closedAt: number | null
  avgEntry: number
  avgExit: number
  win: boolean
}

const W = 960
const H = 420
const PAD_L = 8
const PAD_R = 56
const PAD_T = 14
const PAD_B = 26

const BG = '#0b1022'
const GRID = '#1c2338'
const UP = '#22c55e'
const DOWN = '#ef4444'
const TEXT = '#93a0bd'
const ACCENT = '#21d4fd'

export interface ExecChartHandle {
  svg: SVGSVGElement | null
}

export const ExecChart = forwardRef<SVGSVGElement, {
  bars: ChartBar[]
  fills: ChartFill[]
  trips: ChartTrip[]
}>(function ExecChart({ bars, fills, trips }, ref) {
  const localRef = useRef<SVGSVGElement | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null) // bar index range
  const rangeRef = useRef<[number, number] | null>(null)
  const dragging = useRef<{ x: number; range: [number, number] } | null>(null)

  useEffect(() => {
    rangeRef.current = range
  }, [range])

  // React's synthetic onWheel is PASSIVE (preventDefault is ignored), so bind
  // a native non-passive listener for zoom-about-cursor.
  useEffect(() => {
    const el = localRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      e.preventDefault()
      const r = rangeRef.current
      if (!r || bars.length === 0) return
      const rect = el.getBoundingClientRect()
      const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      const span = r[1] - r[0] + 1
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18
      const newSpan = Math.max(8, Math.min(bars.length, Math.round(span * factor)))
      const anchor = r[0] + fx * span
      let n0 = Math.round(anchor - fx * newSpan)
      n0 = Math.max(0, Math.min(n0, bars.length - newSpan))
      setRange([n0, n0 + newSpan - 1])
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [bars])

  const idxOf = (t: number | null): number => {
    if (t == null || bars.length === 0) return -1
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < bars.length; i++) {
      const d = Math.abs(bars[i].t - t)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  const fitTrades = (): void => {
    if (bars.length === 0) return
    const times = fills.map((f) => f.at).filter((t): t is number => t != null)
    if (times.length === 0) {
      setRange([0, bars.length - 1])
      return
    }
    const lo = Math.max(0, idxOf(Math.min(...times)) - 20)
    const hi = Math.min(bars.length - 1, idxOf(Math.max(...times)) + 20)
    setRange([lo, Math.max(hi, lo + 5)])
  }
  const fullDay = (): void => {
    if (bars.length > 0) setRange([0, bars.length - 1])
  }

  // reframe when the data set changes
  useEffect(() => {
    fitTrades()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, fills])

  const view = useMemo(() => {
    if (!range || bars.length === 0) return null
    const [i0, i1] = range
    const slice = bars.slice(i0, i1 + 1)
    if (slice.length === 0) return null
    let min = Infinity
    let max = -Infinity
    for (const b of slice) {
      min = Math.min(min, b.l)
      max = Math.max(max, b.h)
    }
    for (const f of fills) {
      if (f.at != null) {
        const i = idxOf(f.at)
        if (i >= i0 && i <= i1) {
          min = Math.min(min, f.price)
          max = Math.max(max, f.price)
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    const pad = (max - min || 1) * 0.08
    min -= pad
    max += pad
    const innerW = W - PAD_L - PAD_R
    const innerH = H - PAD_T - PAD_B
    const x = (i: number): number => PAD_L + ((i - i0 + 0.5) / (i1 - i0 + 1)) * innerW
    const y = (p: number): number => PAD_T + (1 - (p - min) / (max - min)) * innerH
    return { i0, i1, min, max, x, y, cw: Math.max(1, (innerW / (i1 - i0 + 1)) * 0.66) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, bars, fills])

  if (bars.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-edge bg-surface text-sm text-muted">
        No 1-minute candle data — add your Massive key in Settings → API Keys, or the market was closed.
      </div>
    )
  }
  if (!view || !range) return <div className="h-64" />

  const { i0, i1, min, max, x, y, cw } = view

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    dragging.current = { x: e.clientX, range: [i0, i1] }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = dragging.current
    if (!d) return
    const rect = e.currentTarget.getBoundingClientRect()
    const span = d.range[1] - d.range[0] + 1
    const shift = Math.round(((d.x - e.clientX) / rect.width) * span)
    let n0 = Math.max(0, Math.min(d.range[0] + shift, bars.length - span))
    setRange([n0, n0 + span - 1])
  }
  const onPointerUp = (): void => {
    dragging.current = null
  }

  // horizontal grid: 5 price lines
  const gridLines = Array.from({ length: 5 }, (_, k) => min + ((max - min) * (k + 1)) / 6)
  const fmtTime = (t: number): string =>
    new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })

  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-1.5 text-xs text-muted">
        <span>Wheel = zoom · drag = pan</span>
        <div className="ml-auto flex gap-1.5">
          <button onClick={fitTrades} className="rounded bg-raised px-2 py-0.5 font-medium text-ink hover:bg-edge/60">
            Fit trades
          </button>
          <button onClick={fullDay} className="rounded bg-raised px-2 py-0.5 font-medium text-ink hover:bg-edge/60">
            Full day
          </button>
        </div>
      </div>
      <svg
        ref={(el) => {
          localRef.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full cursor-grab active:cursor-grabbing"
        style={{ background: BG, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <rect x={0} y={0} width={W} height={H} fill={BG} />
        {gridLines.map((p, k) => (
          <g key={k}>
            <line x1={PAD_L} y1={y(p)} x2={W - PAD_R} y2={y(p)} stroke={GRID} strokeWidth={1} />
            <text x={W - PAD_R + 4} y={y(p) + 3} fill={TEXT} fontSize={10}>
              {p.toFixed(2)}
            </text>
          </g>
        ))}

        {/* candles */}
        {bars.slice(i0, i1 + 1).map((b, k) => {
          const i = i0 + k
          const up = b.c >= b.o
          const color = up ? UP : DOWN
          const cx = x(i)
          return (
            <g key={b.t}>
              <line x1={cx} y1={y(b.h)} x2={cx} y2={y(b.l)} stroke={color} strokeWidth={1} />
              <rect
                x={cx - cw / 2}
                y={Math.min(y(b.o), y(b.c))}
                width={cw}
                height={Math.max(1, Math.abs(y(b.o) - y(b.c)))}
                fill={color}
              />
            </g>
          )
        })}

        {/* round-trip connectors */}
        {trips.map((t, k) => {
          const a = idxOf(t.openedAt)
          const b = idxOf(t.closedAt)
          if (a < 0 || b < 0) return null
          if (b < i0 || a > i1) return null
          return (
            <line
              key={`trip-${k}`}
              x1={x(Math.max(a, i0))}
              y1={y(t.avgEntry)}
              x2={x(Math.min(b, i1))}
              y2={y(t.avgExit)}
              stroke={t.win ? UP : DOWN}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              opacity={0.9}
            />
          )
        })}

        {/* fill markers */}
        {fills.map((f, k) => {
          const i = idxOf(f.at)
          if (i < i0 || i > i1) return null
          const cx = x(i)
          const buy = f.side === 'buy'
          const py = y(f.price)
          const ty = buy ? py + 14 : py - 14
          const tri = buy
            ? `${cx},${ty - 7} ${cx - 6},${ty + 4} ${cx + 6},${ty + 4}`
            : `${cx},${ty + 7} ${cx - 6},${ty - 4} ${cx + 6},${ty - 4}`
          return (
            <g key={`f-${k}`}>
              <polygon points={tri} fill={buy ? UP : DOWN} stroke={BG} strokeWidth={1} />
              <text
                x={cx}
                y={buy ? ty + 16 : ty - 12}
                fill={buy ? UP : DOWN}
                fontSize={9}
                textAnchor="middle"
                fontFamily="monospace"
              >
                {`${f.qty}@${f.price.toFixed(2)}`}
              </text>
            </g>
          )
        })}

        {/* time axis: first/mid/last visible */}
        {[i0, Math.floor((i0 + i1) / 2), i1].map((i, k) => (
          <text key={k} x={x(i)} y={H - 8} fill={TEXT} fontSize={10} textAnchor="middle">
            {bars[i] ? fmtTime(bars[i].t) : ''}
          </text>
        ))}
        <text x={PAD_L + 2} y={12} fill={ACCENT} fontSize={10} fontFamily="monospace">
          1-minute · ET
        </text>
      </svg>
    </div>
  )
})

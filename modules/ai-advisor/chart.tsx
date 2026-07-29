import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

/**
 * Inline SVG charts the advisor can render by emitting a ```wicked-chart``` block.
 * No chart library — theme-aware via Tailwind fill-current/stroke-current + tokens.
 *   candles  → fetches trade-review:candles for {symbol, ymd}
 *   bar/line → data:[{label,value}]  (stats the model computed from tool data)
 *   pie      → data:[{label,value}]  (positive values)
 */

type Spec = Record<string, unknown>
interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const fmtNum = (n: number, unit?: string): string =>
  unit === '$' ? money(n) : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit && unit !== '$' ? unit : ''}`

function asData(spec: Spec): { label: string; value: number }[] {
  const d = Array.isArray(spec.data) ? spec.data : []
  return d
    .map((r) => {
      const o = (typeof r === 'object' && r ? r : {}) as { label?: unknown; value?: unknown; x?: unknown; y?: unknown }
      const value = typeof o.value === 'number' ? o.value : typeof o.y === 'number' ? o.y : NaN
      const label = String(o.label ?? o.x ?? '')
      return { label, value }
    })
    .filter((r) => Number.isFinite(r.value))
}

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16']

function Frame({ title, sub, children }: { title?: string; sub?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="my-2 rounded-xl border border-edge bg-surface p-3">
      {title && <div className="text-xs font-semibold text-ink">{title}</div>}
      {sub && <div className="mt-0.5 text-[10px] text-muted">{sub}</div>}
      <div className="mt-2 overflow-x-auto">{children}</div>
    </div>
  )
}

function BarChart({ spec }: { spec: Spec }): React.JSX.Element {
  const data = asData(spec)
  const unit = typeof spec.unit === 'string' ? spec.unit : ''
  if (!data.length) return <Frame title={String(spec.title ?? 'Chart')}><p className="text-xs text-muted">No data.</p></Frame>
  const H = 210
  const pad = 30
  const W = Math.max(340, data.length * 66)
  const max = Math.max(0, ...data.map((d) => d.value))
  const min = Math.min(0, ...data.map((d) => d.value))
  const span = max - min || 1
  const y = (v: number): number => H - pad - ((v - min) / span) * (H - pad * 2)
  const zeroY = y(0)
  const slot = (W - pad * 2) / data.length
  const bw = Math.min(46, slot * 0.6)
  return (
    <Frame title={String(spec.title ?? '')}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="max-w-none">
        <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} className="stroke-current text-edge" strokeWidth={1} />
        {data.map((d, i) => {
          const cx = pad + (i + 0.5) * slot
          const top = Math.min(zeroY, y(d.value))
          const h = Math.max(1, Math.abs(y(d.value) - zeroY))
          const pos = d.value >= 0
          return (
            <g key={i} className={pos ? 'text-ok' : 'text-danger'}>
              <rect x={cx - bw / 2} y={top} width={bw} height={h} rx={2} className="fill-current" opacity={0.85} />
              <text x={cx} y={pos ? top - 4 : top + h + 11} textAnchor="middle" fontSize={9} className="fill-current text-ink">
                {fmtNum(d.value, unit)}
              </text>
              <text x={cx} y={H - 8} textAnchor="middle" fontSize={9} className="fill-current text-muted">
                {d.label.slice(0, 10)}
              </text>
            </g>
          )
        })}
      </svg>
    </Frame>
  )
}

function LineChart({ spec }: { spec: Spec }): React.JSX.Element {
  const data = asData(spec)
  const unit = typeof spec.unit === 'string' ? spec.unit : ''
  if (!data.length) return <Frame title={String(spec.title ?? 'Chart')}><p className="text-xs text-muted">No data.</p></Frame>
  const H = 210
  const pad = 30
  const W = Math.max(340, data.length * 50)
  const vals = data.map((d) => d.value)
  const max = Math.max(...vals)
  const min = Math.min(...vals)
  const span = max - min || 1
  const x = (i: number): number => pad + (data.length === 1 ? 0.5 : i / (data.length - 1)) * (W - pad * 2)
  const y = (v: number): number => H - pad - ((v - min) / span) * (H - pad * 2)
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')
  const step = Math.ceil(data.length / 8) || 1
  return (
    <Frame title={String(spec.title ?? '')} sub={unit ? `Latest: ${fmtNum(data[data.length - 1].value, unit)}` : undefined}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="max-w-none">
        <polyline points={pts} fill="none" className="stroke-current text-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={i} cx={x(i)} cy={y(d.value)} r={2.4} className="fill-current text-accent" />
        ))}
        {data.map((d, i) =>
          i % step === 0 ? (
            <text key={`t${i}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} className="fill-current text-muted">
              {d.label.slice(0, 10)}
            </text>
          ) : null
        )}
      </svg>
    </Frame>
  )
}

function PieChart({ spec }: { spec: Spec }): React.JSX.Element {
  const data = asData(spec).filter((d) => d.value > 0)
  if (!data.length) return <Frame title={String(spec.title ?? 'Chart')}><p className="text-xs text-muted">No positive data to chart.</p></Frame>
  const total = data.reduce((a, d) => a + d.value, 0) || 1
  const cx = 80
  const cy = 80
  const R = 70
  const r = 42
  let a0 = -Math.PI / 2
  const segs = data.map((d, i) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p = (ang: number, rad: number): string => `${(cx + rad * Math.cos(ang)).toFixed(2)} ${(cy + rad * Math.sin(ang)).toFixed(2)}`
    const path = `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${large} 0 ${p(a0, r)} Z`
    a0 = a1
    return { path, color: PALETTE[i % PALETTE.length], d }
  })
  return (
    <Frame title={String(spec.title ?? '')}>
      <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 160 160" width={160} height={160}>
          {segs.map((s, i) => (
            <path key={i} d={s.path} fill={s.color} opacity={0.9} />
          ))}
        </svg>
        <ul className="space-y-1 text-[11px]">
          {segs.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              <span className="text-ink">{s.d.label}</span>
              <span className="text-muted">{((s.d.value / total) * 100).toFixed(0)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Frame>
  )
}

function CandleChart({ spec }: { spec: Spec }): React.JSX.Element {
  const symbol = String(spec.symbol ?? '').toUpperCase()
  const ymd = String(spec.ymd ?? '')
  const [state, setState] = useState<{ loading: boolean; error?: string; bars?: Bar[] }>({ loading: true })

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
        setState({ loading: false, error: 'A candle chart needs a symbol and ymd (YYYY-MM-DD).' })
        return
      }
      try {
        const res = (await window.wicked.invoke('trade-review:candles', { symbol, ymd })) as {
          ok?: boolean
          bars?: Bar[]
          error?: string
        }
        if (!alive) return
        if (res?.ok && Array.isArray(res.bars) && res.bars.length) setState({ loading: false, bars: res.bars })
        else setState({ loading: false, error: res?.error || 'No candle data for that symbol/day.' })
      } catch (e) {
        if (alive) setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to load candles.' })
      }
    })()
    return () => {
      alive = false
    }
  }, [symbol, ymd])

  const title = String(spec.title ?? `${symbol} — ${ymd}`)
  if (state.loading)
    return (
      <Frame title={title}>
        <div className="flex items-center gap-2 p-3 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" /> Loading {symbol} candles…
        </div>
      </Frame>
    )
  if (state.error || !state.bars) return <Frame title={title}><p className="text-xs text-danger">{state.error}</p></Frame>

  const bars = state.bars
  const H = 230
  const pad = 22
  const cw = Math.max(2, Math.min(8, Math.floor(1000 / bars.length)))
  const gap = Math.max(1, Math.floor(cw / 2))
  const W = Math.max(340, bars.length * (cw + gap) + pad * 2)
  const hi = Math.max(...bars.map((b) => b.h))
  const lo = Math.min(...bars.map((b) => b.l))
  const span = hi - lo || 1
  const y = (v: number): number => pad + (1 - (v - lo) / span) * (H - pad * 2)
  const first = bars[0].o
  const last = bars[bars.length - 1].c
  const chg = last - first
  const pct = first ? (chg / first) * 100 : 0
  return (
    <Frame
      title={title}
      sub={`O ${first.toFixed(2)} · C ${last.toFixed(2)} · ${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars.length} × 1-min`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="max-w-none">
        {bars.map((b, i) => {
          const x = pad + i * (cw + gap) + cw / 2
          const up = b.c >= b.o
          const bodyTop = y(Math.max(b.o, b.c))
          const bodyH = Math.max(1, Math.abs(y(b.o) - y(b.c)))
          return (
            <g key={i} className={up ? 'text-ok' : 'text-danger'}>
              <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} className="stroke-current" strokeWidth={1} />
              <rect x={x - cw / 2} y={bodyTop} width={cw} height={bodyH} className="fill-current" />
            </g>
          )
        })}
      </svg>
    </Frame>
  )
}

/** Render one parsed ```wicked-chart``` spec. */
export function ChartBlock({ spec }: { spec: Spec }): React.JSX.Element {
  const kind = String(spec.kind ?? '').toLowerCase()
  if (kind === 'candles' || kind === 'candle' || kind === 'candlestick') return <CandleChart spec={spec} />
  if (kind === 'bar' || kind === 'column') return <BarChart spec={spec} />
  if (kind === 'line' || kind === 'area') return <LineChart spec={spec} />
  if (kind === 'pie' || kind === 'donut') return <PieChart spec={spec} />
  return (
    <Frame title={String(spec.title ?? 'Chart')}>
      <p className="text-xs text-muted">Unknown chart kind “{kind || '—'}”.</p>
    </Frame>
  )
}

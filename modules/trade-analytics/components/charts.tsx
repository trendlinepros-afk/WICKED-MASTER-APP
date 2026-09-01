import { useId, useRef, useState } from 'react'

/**
 * Lightweight, dependency-free, theme-aware SVG charts. Colors come from the
 * shell theme tokens (--wk-*), so they track light/dark automatically. Each
 * chart scales to its container width via a viewBox.
 */

const OK = 'rgb(var(--wk-ok))'
const DANGER = 'rgb(var(--wk-danger))'
const ACCENT = 'rgb(var(--wk-accent))'
const MUTED = 'rgb(var(--wk-muted))'
const EDGE = 'rgb(var(--wk-edge))'

/* ------------------------------ equity curve ----------------------------- */

export interface EquityPoint {
  /** ms timestamp for the point (trade close time) */
  at: number
  /** cumulative value plotted on the curve */
  value: number
}

function fmtDay(at: number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtSignedMoney(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

/**
 * Cumulative realized P&L line. Hovering shows a crosshair that snaps to the
 * nearest day and a readout of that day's value beside it, tracking the mouse
 * as it slides horizontally along the curve.
 */
export function EquityCurve({
  points,
  height = 200
}: {
  points: EquityPoint[]
  height?: number
}): React.JSX.Element {
  const gid = useId()
  const overlayRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 800
  const H = height
  const padL = 8
  const padR = 8
  const padT = 12
  const padB = 12
  if (points.length < 2) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted">Not enough closed trades to chart yet.</div>
  }
  const values = points.map((p) => p.value)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const n = points.length
  const x = (i: number): number => padL + (i / (n - 1)) * (W - padL - padR)
  const y = (v: number): number => padT + (1 - (v - min) / range) * (H - padT - padB)
  // fractions (0..1) of the plot box, for the HTML crosshair overlay
  const fx = (i: number): number => x(i) / W
  const fy = (v: number): number => y(v) / H
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(n - 1).toFixed(1)},${y(min).toFixed(1)} L${x(0).toFixed(1)},${y(min).toFixed(1)} Z`
  const zeroY = y(0)
  const last = values[n - 1]
  const stroke = last >= 0 ? OK : DANGER

  const onMove = (e: React.MouseEvent): void => {
    const el = overlayRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const frac = (e.clientX - rect.left) / rect.width
    const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))))
    setHover(i)
  }

  const hp = hover != null ? points[hover] : null
  const leftPct = hover != null ? fx(hover) * 100 : 0
  const topPct = hp ? fy(hp.value) * 100 : 0
  const flip = leftPct > 55 // keep the tooltip on-screen near the right edge

  return (
    <div className="relative w-full select-none">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" preserveAspectRatio="none" role="img" aria-label="Cumulative realized P&L">
        <defs>
          <linearGradient id={`eq-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* zero baseline */}
        <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke={EDGE} strokeWidth="1" strokeDasharray="4 4" />
        <path d={area} fill={`url(#eq-${gid})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>

      {/* crosshair + readout overlay (matches the SVG box exactly) */}
      <div
        ref={overlayRef}
        className="absolute inset-0 cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {hp && (
          <>
            <div className="pointer-events-none absolute bottom-0 top-0 w-px" style={{ left: `${leftPct}%`, backgroundColor: MUTED, opacity: 0.55 }} />
            <div className="pointer-events-none absolute left-0 right-0 h-px" style={{ top: `${topPct}%`, backgroundColor: MUTED, opacity: 0.3 }} />
            <div
              className="pointer-events-none absolute h-2.5 w-2.5 rounded-full border-2 bg-surface"
              style={{ left: `${leftPct}%`, top: `${topPct}%`, borderColor: stroke, transform: 'translate(-50%,-50%)' }}
            />
            <div
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-edge bg-surface px-2 py-1 text-[11px] shadow-lg"
              style={{
                left: `${leftPct}%`,
                top: `${topPct}%`,
                transform: `translateY(-50%) translateX(${flip ? 'calc(-100% - 10px)' : '10px'})`
              }}
            >
              <div className="font-medium text-ink">{fmtDay(hp.at)}</div>
              <div className={hp.value >= 0 ? 'text-ok' : 'text-danger'}>{fmtSignedMoney(hp.value)}</div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* -------------------------------- bar chart ------------------------------ */

export interface Bar {
  label: string
  value: number
  sub?: string
}

export function BarChart({
  bars,
  height = 220,
  maxBars = 20
}: {
  bars: Bar[]
  height?: number
  maxBars?: number
}): React.JSX.Element {
  const data = bars.slice(0, maxBars)
  if (data.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No data.</div>
  const maxAbs = Math.max(1, ...data.map((b) => Math.abs(b.value)))
  return (
    <div className="space-y-1.5" style={{ minHeight: height }}>
      {data.map((b) => {
        const w = (Math.abs(b.value) / maxAbs) * 100
        const pos = b.value >= 0
        return (
          <div key={b.label} className="flex items-center gap-2 text-xs">
            <div className="w-16 shrink-0 truncate text-right font-medium text-ink" title={b.label}>
              {b.label}
            </div>
            <div className="relative flex h-5 min-w-0 flex-1 items-center">
              {/* center line */}
              <div className="absolute left-1/2 top-0 h-full w-px bg-edge" />
              <div className="flex h-full w-1/2 justify-end">
                {!pos && (
                  <div
                    className="h-full rounded-l"
                    style={{ width: `${w}%`, background: DANGER, opacity: 0.85 }}
                  />
                )}
              </div>
              <div className="flex h-full w-1/2 justify-start">
                {pos && (
                  <div
                    className="h-full rounded-r"
                    style={{ width: `${w}%`, background: OK, opacity: 0.85 }}
                  />
                )}
              </div>
            </div>
            <div
              className={`w-20 shrink-0 text-right tabular-nums ${pos ? 'text-ok' : 'text-danger'}`}
              title={b.sub}
            >
              {pos ? '+' : '-'}${Math.abs(b.value).toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* --------------------------- vertical column chart ----------------------- */

export function ColumnChart({
  columns,
  height = 180,
  maxColWidth = 130
}: {
  columns: { label: string; value: number }[]
  height?: number
  /** cap per-bar width so a few bars on a wide window read as columns, not slabs */
  maxColWidth?: number
}): React.JSX.Element {
  if (columns.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No data.</div>
  const maxAbs = Math.max(1, ...columns.map((c) => Math.abs(c.value)))
  // Bar heights are computed in PIXELS, not CSS percentages: a %-height chain
  // inside auto-height flex columns silently resolves to 0 and every bar
  // collapses to its 2px min-height stub.
  const showValues = columns.length <= 16
  const labelH = 18
  const valueH = showValues ? 16 : 0
  const barArea = Math.max(24, height - labelH - valueH)
  return (
    <div className="flex items-stretch justify-center gap-1.5" style={{ height: barArea + labelH + valueH }}>
      {columns.map((c) => {
        const px = Math.round((Math.abs(c.value) / maxAbs) * barArea)
        const pos = c.value >= 0
        return (
          <div
            key={c.label}
            className="flex min-w-0 flex-1 flex-col"
            style={{ maxWidth: maxColWidth }}
            title={`${c.label}: ${pos ? '+' : '-'}$${Math.abs(c.value).toFixed(2)}`}
          >
            <div className="flex w-full flex-col items-center justify-end" style={{ height: barArea + valueH }}>
              {showValues && (
                <div className={`w-full truncate text-center text-[11px] font-medium tabular-nums ${pos ? 'text-ok' : 'text-danger'}`}>
                  {pos ? '+' : '-'}${Math.abs(c.value) >= 1000 ? `${(Math.abs(c.value) / 1000).toFixed(1)}k` : Math.abs(c.value).toFixed(0)}
                </div>
              )}
              <div
                className="w-full rounded-t"
                style={{ height: px, background: pos ? OK : DANGER, opacity: 0.85, minHeight: c.value !== 0 ? 3 : 0 }}
              />
            </div>
            <div className="w-full truncate text-center text-[11px] text-muted" style={{ height: labelH, lineHeight: `${labelH}px` }}>
              {c.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* --------------------------------- donut --------------------------------- */

export function WinLossDonut({
  wins,
  losses,
  breakeven = 0,
  size = 130
}: {
  wins: number
  losses: number
  breakeven?: number
  size?: number
}): React.JSX.Element {
  const total = wins + losses + breakeven
  const r = 54
  const c = 2 * Math.PI * r
  const winFrac = total > 0 ? wins / total : 0
  const lossFrac = total > 0 ? losses / total : 0
  const rate = total > 0 ? (wins / total) * 100 : 0
  return (
    <svg viewBox="0 0 120 120" style={{ width: size, height: size }} role="img" aria-label="Win / loss ratio">
      <circle cx="60" cy="60" r={r} fill="none" stroke={EDGE} strokeWidth="12" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke={DANGER}
        strokeWidth="12"
        strokeDasharray={`${(lossFrac * c).toFixed(2)} ${c}`}
        transform={`rotate(${-90 + winFrac * 360} 60 60)`}
        strokeLinecap="butt"
      />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke={OK}
        strokeWidth="12"
        strokeDasharray={`${(winFrac * c).toFixed(2)} ${c}`}
        transform="rotate(-90 60 60)"
        strokeLinecap="butt"
      />
      <text x="60" y="56" textAnchor="middle" fontSize="22" fontWeight="700" fill="rgb(var(--wk-ink))">
        {rate.toFixed(0)}%
      </text>
      <text x="60" y="74" textAnchor="middle" fontSize="10" fill={MUTED}>
        win rate
      </text>
    </svg>
  )
}

/* --------------------- labelled aggregate-PnL columns -------------------- */

export interface MetricCol {
  label: string
  pnl: number
  trades: number
  wins: number
  losses: number
}

/** Vertical +/- columns with a zero baseline, rotated labels, hover tooltip. */
export function AggPnlColumns({
  cols,
  height = 200
}: {
  cols: MetricCol[]
  height?: number
}): React.JSX.Element {
  if (cols.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No data.</div>
  const maxAbs = Math.max(1, ...cols.map((c) => Math.abs(c.pnl)))
  // Pixel-based bar heights (see ColumnChart) — % chains collapse to 0 here.
  const labelH = 38
  const halfH = Math.max(20, Math.floor((height - labelH - 1) / 2))
  return (
    <div className="w-full overflow-x-auto">
      <div className="flex min-w-full items-stretch gap-1" style={{ height: halfH * 2 + 1 + labelH }}>
        {cols.map((c) => {
          const px = Math.round((Math.abs(c.pnl) / maxAbs) * halfH)
          const pos = c.pnl >= 0
          return (
            <div
              key={c.label}
              className="group relative flex min-w-[26px] flex-1 flex-col"
              title={`${c.label}\n${pos ? '+' : '-'}$${Math.abs(c.pnl).toFixed(2)} · ${c.trades} trade(s) · ${c.wins}W/${c.losses}L`}
            >
              <div className="flex w-full flex-col justify-end" style={{ height: halfH }}>
                {pos && <div className="w-full rounded-t" style={{ height: px, background: OK, opacity: 0.88, minHeight: c.pnl !== 0 ? 3 : 0 }} />}
              </div>
              <div className="h-px w-full bg-edge" />
              <div className="flex w-full flex-col justify-start" style={{ height: halfH }}>
                {!pos && <div className="w-full rounded-b" style={{ height: px, background: DANGER, opacity: 0.88, minHeight: c.pnl !== 0 ? 3 : 0 }} />}
              </div>
              <div className="mt-1 origin-top-left -rotate-45 whitespace-nowrap text-[10px] leading-tight text-muted">{c.label}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Side-by-side win vs loss COUNT columns per bucket. */
export function WinLossColumns({
  cols,
  height = 180
}: {
  cols: MetricCol[]
  height?: number
}): React.JSX.Element {
  if (cols.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No data.</div>
  const maxN = Math.max(1, ...cols.map((c) => Math.max(c.wins, c.losses)))
  // Pixel-based bar heights (see ColumnChart) — % chains collapse to 0 here.
  const labelH = 38
  const barArea = Math.max(24, height - labelH)
  return (
    <div className="w-full overflow-x-auto">
      <div className="flex min-w-full items-stretch gap-1.5" style={{ height: barArea + labelH }}>
        {cols.map((c) => (
          <div
            key={c.label}
            className="group flex min-w-[26px] flex-1 flex-col"
            title={`${c.label}\n${c.wins} win(s) / ${c.losses} loss(es)`}
          >
            <div className="flex w-full items-end justify-center gap-0.5" style={{ height: barArea }}>
              <div className="w-1/2 rounded-t" style={{ height: Math.round((c.wins / maxN) * barArea), background: OK, opacity: 0.88, minHeight: c.wins ? 3 : 0 }} />
              <div className="w-1/2 rounded-t" style={{ height: Math.round((c.losses / maxN) * barArea), background: DANGER, opacity: 0.88, minHeight: c.losses ? 3 : 0 }} />
            </div>
            <div className="mt-1 origin-top-left -rotate-45 whitespace-nowrap text-[10px] leading-tight text-muted">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------ drawdown area ---------------------------- */

export function DrawdownArea({
  points,
  height = 180
}: {
  points: { date: string; value: number }[]
  height?: number
}): React.JSX.Element {
  const gid = useId()
  const W = 800
  const H = height
  const padL = 8
  const padR = 8
  const padT = 8
  const padB = 18
  if (points.length < 2) return <div className="flex h-40 items-center justify-center text-sm text-muted">Not enough days to chart drawdown yet.</div>
  const min = Math.min(...points.map((p) => p.value), 0)
  const range = Math.abs(min) || 1
  const x = (i: number): number => padL + (i / (points.length - 1)) * (W - padL - padR)
  const y = (v: number): number => padT + (-v / range) * (H - padT - padB) // v ≤ 0
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Daily drawdown">
      <defs>
        <linearGradient id={`dd-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={DANGER} stopOpacity="0.04" />
          <stop offset="100%" stopColor={DANGER} stopOpacity="0.30" />
        </linearGradient>
      </defs>
      <line x1={padL} y1={y(0)} x2={W - padR} y2={y(0)} stroke={EDGE} strokeWidth="1" />
      <path d={area} fill={`url(#dd-${gid})`} />
      <path d={line} fill="none" stroke={DANGER} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export { ACCENT, OK, DANGER }

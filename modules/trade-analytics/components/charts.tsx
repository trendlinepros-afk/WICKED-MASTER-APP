import { useId } from 'react'

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

export function EquityCurve({
  values,
  height = 200
}: {
  values: number[]
  height?: number
}): React.JSX.Element {
  const gid = useId()
  const W = 800
  const H = height
  const padL = 8
  const padR = 8
  const padT = 12
  const padB = 12
  if (values.length < 2) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted">Not enough closed trades to chart yet.</div>
  }
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const x = (i: number): number => padL + (i / (values.length - 1)) * (W - padL - padR)
  const y = (v: number): number => padT + (1 - (v - min) / range) * (H - padT - padB)
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(values.length - 1).toFixed(1)},${y(min).toFixed(1)} L${x(0).toFixed(1)},${y(min).toFixed(1)} Z`
  const zeroY = y(0)
  const last = values[values.length - 1]
  const stroke = last >= 0 ? OK : DANGER

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label="Cumulative realized P&L">
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
  height = 160
}: {
  columns: { label: string; value: number }[]
  height?: number
}): React.JSX.Element {
  if (columns.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-muted">No data.</div>
  const maxAbs = Math.max(1, ...columns.map((c) => Math.abs(c.value)))
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {columns.map((c) => {
        const h = (Math.abs(c.value) / maxAbs) * 100
        const pos = c.value >= 0
        return (
          <div key={c.label} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${c.label}: ${pos ? '+' : '-'}$${Math.abs(c.value).toFixed(0)}`}>
            <div className="flex h-full w-full flex-col justify-end">
              <div
                className="w-full rounded-t"
                style={{ height: `${h}%`, background: pos ? OK : DANGER, opacity: 0.85, minHeight: c.value !== 0 ? 2 : 0 }}
              />
            </div>
            <div className="w-full truncate text-center text-[10px] text-muted">{c.label}</div>
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

export { ACCENT }

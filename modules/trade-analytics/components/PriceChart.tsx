import { useMemo, useRef, useState } from 'react'
import type { Trade } from '../lib/analytics'
import type { Candle } from '../lib/instrument'
import type { Excursion } from '../lib/excursion'
import { etParts } from '../lib/et'
import { fmtMove, fmtPrice } from '../lib/instrument'
import { signedMoney } from '../lib/format'

const OK = 'rgb(var(--wk-ok))'
const DANGER = 'rgb(var(--wk-danger))'
const ACCENT = 'rgb(var(--wk-accent))'
const MUTED = 'rgb(var(--wk-muted))'
const INK = 'rgb(var(--wk-ink))'
const EDGE = 'rgb(var(--wk-edge))'
const SURFACE = 'rgb(var(--wk-surface))'

const p2 = (n: number): string => String(n).padStart(2, '0')
function etLabel(ms: number, daily: boolean, withDay: boolean): string {
  const p = etParts(ms)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1]
  if (daily) return `${mon} ${p.d}`
  const hh = p.hour % 12 === 0 ? 12 : p.hour % 12
  const t = `${hh}:${p2(p.minute)}`
  return withDay ? `${mon} ${p.d} ${t}` : t
}
function etFull(ms: number, withSeconds = false): string {
  const d = new Date(ms)
  return (
    d.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {})
    }) + ' ET'
  )
}

/**
 * Candlestick chart of the market around a trade, with the trade drawn on
 * top: every fill as a buy ▲ / sell ▼ marker at its exact time and price, the
 * average entry/exit lines across the hold, the hold window shaded, and the
 * best/worst price reached while in the trade.
 */
export function PriceChart({
  trade,
  candles,
  intervalMs,
  decimals,
  excursion,
  height = 380
}: {
  trade: Trade
  candles: Candle[]
  intervalMs: number
  decimals: number
  excursion: Excursion | null
  height?: number
}): React.JSX.Element {
  const W = 900
  const H = height
  const padL = 8
  const padR = 94
  const padT = 14
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null)

  const n = candles.length
  const barW = plotW / Math.max(1, n)
  const daily = intervalMs >= 86_400_000
  const multiDay = n > 0 && etParts(candles[0].t).ymd !== etParts(candles[n - 1].t).ymd

  /** time → x, placing a time inside its bar (bars are evenly spaced; gaps collapse) */
  const xOf = useMemo(() => {
    return (t: number): number => {
      if (!n) return padL
      if (t <= candles[0].t) return padL
      let lo = 0
      let hi = n - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (candles[mid].t <= t) lo = mid
        else hi = mid - 1
      }
      const frac = Math.min(1, Math.max(0, (t - candles[lo].t) / intervalMs))
      return padL + (lo + frac) * barW
    }
  }, [candles, n, intervalMs, barW])

  const end = trade.isOpen ? Date.now() : (trade.closedAt ?? Date.now())
  const fillPrices = trade.fills.map((f) => f.price).filter((p) => p > 0)
  const all = [...candles.flatMap((c) => [c.h, c.l]), ...fillPrices, trade.avgEntry, ...(trade.avgExit > 0 ? [trade.avgExit] : [])]
  let yMin = Math.min(...all)
  let yMax = Math.max(...all)
  if (yMax - yMin < 1e-9) {
    yMin -= 1
    yMax += 1
  }
  const pad = (yMax - yMin) * 0.07
  yMin -= pad
  yMax += pad
  const yOf = (p: number): number => padT + ((yMax - p) / (yMax - yMin)) * plotH
  const priceAt = (y: number): number => yMax - ((y - padT) / plotH) * (yMax - yMin)

  const profit = trade.realizedPnl >= 0
  const pnlColor = trade.isOpen ? ACCENT : profit ? OK : DANGER
  const xIn = xOf(trade.openedAt ?? candles[0]?.t ?? 0)
  const xOut = xOf(end)

  // axis ticks
  // round-number gridlines (1 / 2 / 2.5 / 5 × 10^k)
  const rawStep = (yMax - yMin) / 5
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rawStep) ?? 10) * mag
  const yTicks: number[] = []
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v)
  const xTickEvery = Math.max(1, Math.round(n / 7))
  const xTicks = candles.map((c, i) => ({ c, i })).filter(({ i }) => i % xTickEvery === 0)

  const isBuy = (side: string): boolean => side === 'buy'

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const svg = svgRef.current
    if (!svg || !n) return
    const r = svg.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    if (x < padL || x > W - padR || y < padT || y > H - padB) {
      setHover(null)
      return
    }
    setHover({ i: Math.min(n - 1, Math.max(0, Math.floor((x - padL) / barW))), y })
  }

  const hc = hover ? candles[hover.i] : null
  // label pills on the price axis (entry/exit/hover), nudged apart if they collide
  const pills: { y: number; text: string; color: string }[] = []
  pills.push({ y: yOf(trade.avgEntry), text: `in ${fmtPrice(trade.avgEntry, decimals)}`, color: MUTED })
  if (!trade.isOpen && trade.avgExit > 0) pills.push({ y: yOf(trade.avgExit), text: `out ${fmtPrice(trade.avgExit, decimals)}`, color: pnlColor })
  pills.sort((a, b) => a.y - b.y)
  for (let i = 1; i < pills.length; i++) if (pills[i].y - pills[i - 1].y < 16) pills[i].y = pills[i - 1].y + 16

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* grid + price axis */}
        {yTicks.map((p, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yOf(p)} y2={yOf(p)} stroke={EDGE} strokeWidth="1" opacity="0.45" />
            {!pills.some((q) => Math.abs(q.y - yOf(p)) < 13) && (
              <text x={W - padR + 6} y={yOf(p)} dominantBaseline="middle" fontSize="10.5" fill={MUTED}>
                {fmtPrice(p, decimals)}
              </text>
            )}
          </g>
        ))}

        {/* hold window */}
        <rect x={xIn} y={padT} width={Math.max(2, xOut - xIn)} height={plotH} fill={pnlColor} opacity="0.08" />
        <line x1={xIn} x2={xIn} y1={padT} y2={H - padB} stroke={pnlColor} strokeWidth="1" opacity="0.35" />
        <line x1={xOut} x2={xOut} y1={padT} y2={H - padB} stroke={pnlColor} strokeWidth="1" opacity="0.35" />

        {/* candles */}
        {candles.map((c, i) => {
          const x = padL + (i + 0.5) * barW
          const up = c.c >= c.o
          const color = up ? OK : DANGER
          const top = yOf(Math.max(c.o, c.c))
          const bh = Math.max(1, Math.abs(yOf(c.o) - yOf(c.c)))
          const bw = Math.max(1, barW * 0.62)
          return (
            <g key={c.t} opacity={hover && hover.i !== i ? 0.85 : 1}>
              <line x1={x} x2={x} y1={yOf(c.h)} y2={yOf(c.l)} stroke={color} strokeWidth="1" />
              <rect x={x - bw / 2} y={top} width={bw} height={bh} fill={color} opacity={up ? 0.85 : 0.9} />
            </g>
          )
        })}

        {/* best / worst while in the trade */}
        {excursion && excursion.mfePts > 0 && (
          <g>
            <line x1={xIn - 3} x2={xOut} y1={yOf(excursion.bestPrice)} y2={yOf(excursion.bestPrice)} stroke={OK} strokeWidth="1.2" strokeDasharray="2 3" />
            <text x={xIn - 5} y={yOf(excursion.bestPrice)} textAnchor="end" dominantBaseline="middle" fontSize="10" fontWeight="600" fill={OK} stroke={SURFACE} strokeWidth="3" paintOrder="stroke">
              best {fmtMove(trade.symbol, excursion.mfePts, decimals)}
            </text>
          </g>
        )}
        {excursion && excursion.maePts > 0 && (
          <g>
            <line x1={xIn - 3} x2={xOut} y1={yOf(excursion.worstPrice)} y2={yOf(excursion.worstPrice)} stroke={DANGER} strokeWidth="1.2" strokeDasharray="2 3" />
            <text x={xIn - 5} y={yOf(excursion.worstPrice)} textAnchor="end" dominantBaseline="middle" fontSize="10" fontWeight="600" fill={DANGER} stroke={SURFACE} strokeWidth="3" paintOrder="stroke">
              heat {fmtMove(trade.symbol, -excursion.maePts, decimals)}
            </text>
          </g>
        )}

        {/* average entry / exit across the hold */}
        <line x1={xIn} x2={W - padR} y1={yOf(trade.avgEntry)} y2={yOf(trade.avgEntry)} stroke={INK} strokeWidth="1.2" strokeDasharray="6 4" opacity="0.7" />
        {!trade.isOpen && trade.avgExit > 0 && (
          <line x1={xOut} x2={W - padR} y1={yOf(trade.avgExit)} y2={yOf(trade.avgExit)} stroke={pnlColor} strokeWidth="1.2" strokeDasharray="6 4" />
        )}
        {!trade.isOpen && trade.avgExit > 0 && (
          <line x1={xIn} y1={yOf(trade.avgEntry)} x2={xOut} y2={yOf(trade.avgExit)} stroke={pnlColor} strokeWidth="1.5" opacity="0.6" />
        )}

        {/* fills */}
        {trade.fills
          .filter((f) => f.price > 0 && f.at != null)
          .map((f, i) => {
            const x = xOf(f.at!)
            const y = yOf(f.price)
            const buy = isBuy(f.side)
            const s = 7
            const d = buy ? `M${x},${y} L${x - s},${y + s * 1.6} L${x + s},${y + s * 1.6} Z` : `M${x},${y} L${x - s},${y - s * 1.6} L${x + s},${y - s * 1.6} Z`
            return (
              <g key={i}>
                <path d={d} fill={buy ? OK : DANGER} stroke={SURFACE} strokeWidth="1.2" />
                <text x={x} y={buy ? y + s * 1.6 + 11 : y - s * 1.6 - 4} textAnchor="middle" fontSize="9.5" fontWeight="600" fill={buy ? OK : DANGER}>
                  {buy ? 'B' : 'S'}
                  {f.qty !== 1 ? ` ${Number(f.qty.toFixed(4))}` : ''}
                </text>
                <title>{`${buy ? 'BUY' : 'SELL'} ${Number(f.qty.toFixed(4))} @ ${fmtPrice(f.price, decimals)} · ${etFull(f.at!, true)}`}</title>
              </g>
            )
          })}

        {/* price-axis pills */}
        {pills.map((p, i) => (
          <g key={i}>
            <rect x={W - padR + 2} y={p.y - 8} width={padR - 4} height="16" rx="3" fill={p.color} opacity="0.9" />
            <text x={W - padR / 2} y={p.y} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="600" fill={SURFACE}>
              {p.text}
            </text>
          </g>
        ))}

        {/* time axis */}
        {xTicks.map(({ c, i }) => (
          <text key={c.t} x={padL + (i + 0.5) * barW} y={H - 8} textAnchor="middle" fontSize="10" fill={MUTED}>
            {etLabel(c.t, daily, multiDay && !daily && i === 0)}
          </text>
        ))}

        {/* crosshair */}
        {hover && hc && (
          <g pointerEvents="none">
            <line x1={padL + (hover.i + 0.5) * barW} x2={padL + (hover.i + 0.5) * barW} y1={padT} y2={H - padB} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />
            <line x1={padL} x2={W - padR} y1={hover.y} y2={hover.y} stroke={MUTED} strokeWidth="1" strokeDasharray="3 3" />
            <rect x={W - padR + 2} y={hover.y - 8} width={padR - 4} height="16" rx="3" fill={INK} />
            <text x={W - padR / 2} y={hover.y} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="600" fill={SURFACE}>
              {fmtPrice(priceAt(hover.y), decimals)}
            </text>
          </g>
        )}
      </svg>

      {/* P&L badge */}
      <div
        className="pointer-events-none absolute left-2 top-2 rounded-lg border bg-surface/90 px-2.5 py-1.5 text-right backdrop-blur-sm"
        style={{ borderColor: pnlColor }}
      >
        <div className="text-[9px] font-semibold uppercase tracking-wider text-muted">{trade.isOpen ? 'Open trade' : 'Trade P&L'}</div>
        <div className="text-lg font-bold leading-tight tabular-nums" style={{ color: pnlColor }}>
          {trade.isOpen ? '—' : signedMoney(trade.realizedPnl)}
        </div>
        {excursion && !trade.isOpen && (
          <div className="text-[10px] tabular-nums text-muted">{fmtMove(trade.symbol, excursion.realizedPts, decimals)}</div>
        )}
      </div>

      {/* hover OHLC */}
      {hover && hc && (
        <div className="pointer-events-none absolute right-24 top-2 rounded-md border border-edge bg-surface/95 px-2.5 py-1.5 text-[10.5px] tabular-nums text-ink shadow">
          <div className="mb-0.5 font-semibold text-muted">{etFull(hc.t)}</div>
          <div className="grid grid-cols-[auto_auto] gap-x-2">
            <span className="text-muted">O</span>
            <span>{fmtPrice(hc.o, decimals)}</span>
            <span className="text-muted">H</span>
            <span>{fmtPrice(hc.h, decimals)}</span>
            <span className="text-muted">L</span>
            <span>{fmtPrice(hc.l, decimals)}</span>
            <span className="text-muted">C</span>
            <span className={hc.c >= hc.o ? 'text-ok' : 'text-danger'}>{fmtPrice(hc.c, decimals)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

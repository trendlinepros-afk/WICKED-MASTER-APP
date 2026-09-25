import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2, X } from 'lucide-react'
import type { Trade } from '../lib/analytics'
import {
  allowedIntervals,
  autoInterval,
  chartWindow,
  fmtMove,
  fmtPrice,
  INTERVAL_MS,
  priceDecimals,
  qtyUnit,
  type Candle,
  type Context,
  type Interval
} from '../lib/instrument'
import { excursions } from '../lib/excursion'
import { dateShort, dateTime, duration, shares, signedMoney } from '../lib/format'
import { ID } from '../store'
import { PriceChart } from './PriceChart'
import { TradeChart } from './charts'

interface CandleRes {
  ok: boolean
  candles: Candle[]
  ticker?: string
  note?: string
  mismatch?: boolean
  error?: string
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'danger' | 'warn' }): React.JSX.Element {
  const color = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-ink'
  return (
    <div className="rounded-lg border border-edge bg-bg/40 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[10.5px] leading-snug text-muted">{sub}</div>}
    </div>
  )
}

const LABEL: Record<Interval, string> = { '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '1h', '1d': '1D' }

export function TradeChartModal({ trade, onClose }: { trade: Trade; onClose: () => void }): React.JSX.Element {
  const openedAt = trade.openedAt ?? trade.fills.find((f) => f.at != null)?.at ?? null
  const closedAt = trade.isOpen ? Date.now() : (trade.closedAt ?? openedAt)
  const decimals = priceDecimals(trade.symbol, trade.fills.map((f) => f.price))
  const qty = trade.isOpen ? trade.openQty : trade.qty
  const unit = qtyUnit(trade.symbol, trade.multiplier, qty)
  const ptVal = trade.multiplier && trade.multiplier !== 1 && unit.startsWith('contract') ? trade.multiplier : null

  const [interval, setInterval_] = useState<Interval>(() => (openedAt && closedAt ? autoInterval(openedAt, closedAt) : '1d'))
  const [context, setContext] = useState<Context>('normal')
  const [res, setRes] = useState<CandleRes | null>(null)
  const [loading, setLoading] = useState(false)

  const allowed = useMemo(() => {
    if (!openedAt || !closedAt) return [] as Interval[]
    return (['1m', '2m', '5m', '15m', '30m', '60m', '1d'] as Interval[]).filter((iv) => {
      const w = chartWindow(openedAt, closedAt, iv, 'wide')
      return allowedIntervals(w.from, w.to).includes(iv) && (closedAt - openedAt) / INTERVAL_MS[iv] < 1500
    })
  }, [openedAt, closedAt])

  useEffect(() => {
    if (!openedAt || !closedAt) return
    let alive = true
    const w = chartWindow(openedAt, closedAt, interval, context)
    setLoading(true)
    void (
      window.wicked.invoke(`${ID}:trade-candles`, {
        symbol: trade.symbol,
        interval,
        from: w.from,
        to: Math.min(w.to, Date.now()),
        refPrice: trade.avgEntry,
        refFrom: openedAt,
        refTo: closedAt
      }) as Promise<CandleRes>
    )
      .then((r) => alive && setRes(r))
      .catch((err) => alive && setRes({ ok: false, candles: [], error: err instanceof Error ? err.message : String(err) }))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [trade.symbol, trade.avgEntry, openedAt, closedAt, interval, context])

  const candles = res?.ok ? res.candles : []
  const ex = useMemo(() => (candles.length ? excursions(trade, candles, INTERVAL_MS[interval]) : null), [trade, candles, interval])
  const perPt = (trade.multiplier || 1) * (trade.isOpen ? trade.openQty : trade.closedQty)
  const fills = [...trade.fills].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-edge bg-surface" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          {trade.direction === 'long' ? <ArrowUpRight size={16} className="text-ok" /> : <ArrowDownRight size={16} className="text-danger" />}
          <span className="text-sm font-semibold">{trade.symbol}</span>
          <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] uppercase text-muted">{trade.direction}</span>
          <span className="min-w-0 truncate text-xs text-muted">
            {shares(qty)} {unit}
            {ptVal ? ` · $${ptVal}/pt` : ''} · {trade.isOpen ? 'open' : `${dateShort(trade.openedAt)} → ${dateShort(trade.closedAt)}`}
          </span>
          <button onClick={onClose} className="ml-auto rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* controls */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-raised p-0.5">
              {allowed.map((iv) => (
                <button
                  key={iv}
                  onClick={() => setInterval_(iv)}
                  className={`rounded-md px-2.5 py-1 text-xs ${iv === interval ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
                >
                  {LABEL[iv]}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg bg-raised p-0.5">
              {(['tight', 'normal', 'wide'] as Context[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setContext(c)}
                  className={`rounded-md px-2.5 py-1 text-xs capitalize ${c === context ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
                >
                  {c === 'tight' ? 'Zoom in' : c === 'wide' ? 'Zoom out' : 'Normal'}
                </button>
              ))}
            </div>
            {loading && <Loader2 size={14} className="animate-spin text-muted" />}
            <span className="ml-auto text-[11px] text-muted">Times in ET · hover for OHLC</span>
          </div>

          <div className="rounded-xl border border-edge bg-bg/40 p-2">
            {candles.length > 0 ? (
              <PriceChart trade={trade} candles={candles} intervalMs={INTERVAL_MS[interval]} decimals={decimals} excursion={ex} />
            ) : loading && !res ? (
              <div className="flex h-[380px] items-center justify-center gap-2 text-sm text-muted">
                <Loader2 size={16} className="animate-spin" /> Loading market data…
              </div>
            ) : (
              <div>
                <TradeChart trade={trade} />
                <p className="mt-1 flex items-start gap-1.5 px-1 text-[11px] text-warn">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Couldn’t load price candles{res?.error ? ` — ${res.error}` : ''}. Showing your fills only.
                  </span>
                </p>
              </div>
            )}
          </div>
          {res?.ok && res.note && (
            <p className={`mt-1 flex items-center gap-1.5 px-1 text-[11px] ${res.mismatch ? 'text-warn' : 'text-muted'}`}>
              {res.mismatch && <AlertTriangle size={12} />} {res.note}
            </p>
          )}

          {/* what happened */}
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Tile label="Avg entry" value={fmtPrice(trade.avgEntry, decimals)} sub={trade.openedAt ? dateTime(trade.openedAt) : undefined} />
            <Tile
              label="Avg exit"
              value={trade.isOpen ? 'open' : fmtPrice(trade.avgExit, decimals)}
              sub={trade.closedAt && !trade.isOpen ? `${dateTime(trade.closedAt)} · held ${duration(trade.holdSeconds)}` : undefined}
            />
            <Tile
              label="Realized P&L"
              value={trade.isOpen ? 'open' : signedMoney(trade.realizedPnl)}
              sub={ex && !trade.isOpen ? `${fmtMove(trade.symbol, ex.realizedPts, decimals)}${trade.fees ? ` · fees ${signedMoney(-trade.fees)}` : ''}` : undefined}
              tone={trade.isOpen ? undefined : trade.realizedPnl >= 0 ? 'ok' : 'danger'}
            />
            <Tile
              label="Captured"
              value={
                !ex || trade.isOpen
                  ? '—'
                  : ex.realizedPts < 0
                    ? 'Closed at a loss'
                    : ex.capturePct != null
                      ? `${Math.round(Math.min(ex.capturePct, 100))}% of the move`
                      : '—'
              }
              sub={
                !ex
                  ? 'needs price data'
                  : ex.realizedPts < 0
                    ? ex.mfePts > 0
                      ? `price went ${fmtMove(trade.symbol, ex.mfePts, decimals)} your way first (${signedMoney(ex.mfeUsd)})`
                      : 'it never moved your way while you were in'
                    : 'your exit vs the best price reached while you were in'
              }
              tone={
                !ex || trade.isOpen ? undefined : ex.realizedPts < 0 ? 'danger' : (ex.capturePct ?? 0) >= 60 ? 'ok' : (ex.capturePct ?? 0) >= 25 ? 'warn' : 'danger'
              }
            />
            <Tile
              label="Best available (MFE)"
              value={ex ? fmtMove(trade.symbol, ex.mfePts, decimals) : '—'}
              sub={ex ? `${signedMoney(ex.mfeUsd)} at ${fmtPrice(ex.bestPrice, decimals)}` : undefined}
              tone={ex ? 'ok' : undefined}
            />
            <Tile
              label="Heat taken (MAE)"
              value={ex ? fmtMove(trade.symbol, -ex.maePts, decimals) : '—'}
              sub={ex ? `${signedMoney(-ex.maeUsd)} at ${fmtPrice(ex.worstPrice, decimals)}` : undefined}
              tone={ex && ex.maePts > 0 ? 'danger' : undefined}
            />
            <Tile
              label={ex ? `After exit (next ${ex.afterMinutes >= 120 ? `${Math.round(ex.afterMinutes / 60)}h` : `${ex.afterMinutes}m`})` : 'After exit'}
              value={ex?.afterBestPts != null ? `${fmtMove(trade.symbol, ex.afterBestPts, decimals)} more` : '—'}
              sub={
                ex?.afterBestPts != null && ex.afterWorstPts != null
                  ? `ran up to ${signedMoney(ex.afterBestPts * perPt)} further your way; came back ${fmtMove(trade.symbol, -ex.afterWorstPts, decimals)}`
                  : trade.isOpen
                    ? 'still open'
                    : 'no bars after the exit yet'
              }
            />
            <Tile
              label="Risk / reward seen"
              value={ex && ex.maePts > 0 ? `${(ex.mfePts / ex.maePts).toFixed(2)} : 1` : ex ? 'no heat' : '—'}
              sub={ex ? 'best available ÷ heat taken during the hold' : undefined}
            />
          </div>

          {/* fills */}
          <div className="mt-3 overflow-hidden rounded-lg border border-edge">
            <div className="grid grid-cols-[1fr_64px_90px_110px] gap-2 border-b border-edge bg-raised/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              <div>Fill time</div>
              <div>Side</div>
              <div className="text-right">Qty</div>
              <div className="text-right">Price</div>
            </div>
            <div className="max-h-44 overflow-y-auto">
              {fills.map((f, i) => (
                <div key={i} className="grid grid-cols-[1fr_64px_90px_110px] gap-2 border-b border-edge/50 px-3 py-1.5 text-xs last:border-0">
                  <div className="truncate text-muted">{f.at != null ? dateTime(f.at) : '—'}</div>
                  <div className={`font-medium ${f.side === 'buy' ? 'text-ok' : 'text-danger'}`}>{f.side.toUpperCase()}</div>
                  <div className="text-right tabular-nums">
                    {shares(f.qty)} <span className="text-muted">{qtyUnit(trade.symbol, trade.multiplier, f.qty)}</span>
                  </div>
                  <div className="text-right tabular-nums">{fmtPrice(f.price, decimals)}</div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            ▲ buys and ▼ sells are your fills at their exact time and price; the shaded band is your time in the trade. MFE/MAE are
            read from the bars while you were in (bar-level, so the entry/exit bars can include a few seconds outside the trade).
          </p>
        </div>
      </div>
    </div>
  )
}

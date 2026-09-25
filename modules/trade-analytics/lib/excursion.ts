/**
 * What price did while you were in a trade, and right after you left (pure).
 *
 *   MFE — max favourable excursion: the best price reached during the hold,
 *         measured from your average entry (what was available).
 *   MAE — max adverse excursion: the worst price during the hold (the heat
 *         you sat through).
 *   Capture — your realized move as a share of the MFE.
 *   After exit — how far price ran further your way / came back against you
 *         in the window right after the exit.
 *
 * Bar-level approximation: the bar containing a fill also holds prices from
 * just before/after that fill, so extremes can include a few seconds of price
 * you weren't in the trade for.
 */
import type { Candle } from './instrument'
import type { Trade } from './analytics'

export interface Excursion {
  /** points in the trade's favour (>= 0) */
  mfePts: number
  /** points against the trade (>= 0) */
  maePts: number
  mfeUsd: number
  maeUsd: number
  bestPrice: number
  worstPrice: number
  /** realized points (signed, in the trade's direction) */
  realizedPts: number
  /** realized ÷ MFE, 0-100+ (null when there was no favourable move) */
  capturePct: number | null
  /** after exit: best further move your way / worst move against, in points (both >= 0) */
  afterBestPts: number | null
  afterWorstPts: number | null
  afterMinutes: number
}

export function excursions(trade: Trade, candles: Candle[], intervalMs: number, now = Date.now()): Excursion | null {
  if (!trade.openedAt || !candles.length || !(trade.avgEntry > 0)) return null
  const dir = trade.direction === 'long' ? 1 : -1
  const end = trade.isOpen ? now : (trade.closedAt ?? now)
  const during = candles.filter((c) => c.t + intervalMs > trade.openedAt! && c.t <= end)
  if (!during.length) return null
  // your own fills are real prices too — include them so the extremes can
  // never be narrower than what you actually traded (feeds differ slightly)
  const fillPx = trade.fills.filter((f) => f.price > 0).map((f) => f.price)
  const hi = Math.max(...during.map((c) => c.h), ...fillPx)
  const lo = Math.min(...during.map((c) => c.l), ...fillPx)
  const best = dir === 1 ? hi : lo
  const worst = dir === 1 ? lo : hi
  const mfePts = Math.max(0, (best - trade.avgEntry) * dir)
  const maePts = Math.max(0, (trade.avgEntry - worst) * dir)
  const qty = trade.isOpen ? trade.openQty : trade.closedQty
  const perPt = (trade.multiplier || 1) * qty
  const exitPx = trade.isOpen ? (during[during.length - 1]?.c ?? trade.avgEntry) : trade.avgExit
  const realizedPts = (exitPx - trade.avgEntry) * dir

  let afterBestPts: number | null = null
  let afterWorstPts: number | null = null
  const holdMs = Math.max(0, end - trade.openedAt)
  const afterMs = Math.max(15 * intervalMs, Math.min(holdMs, 60 * intervalMs))
  if (!trade.isOpen && trade.avgExit > 0) {
    const after = candles.filter((c) => c.t > end && c.t <= end + afterMs)
    if (after.length) {
      const aHi = Math.max(...after.map((c) => c.h))
      const aLo = Math.min(...after.map((c) => c.l))
      afterBestPts = Math.max(0, ((dir === 1 ? aHi : aLo) - trade.avgExit) * dir)
      afterWorstPts = Math.max(0, (trade.avgExit - (dir === 1 ? aLo : aHi)) * dir)
    }
  }
  return {
    mfePts,
    maePts,
    mfeUsd: mfePts * perPt,
    maeUsd: maePts * perPt,
    bestPrice: best,
    worstPrice: worst,
    realizedPts,
    capturePct: mfePts > 0 ? (realizedPts / mfePts) * 100 : null,
    afterBestPts,
    afterWorstPts,
    afterMinutes: Math.round(afterMs / 60_000)
  }
}

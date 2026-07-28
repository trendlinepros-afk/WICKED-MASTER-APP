/**
 * Technical SIGNALS + a unified TRADE SCORE (pure — no network, unit-tested).
 *
 * The screener already knows a stock MOVED (price/%/volume). These turn that into
 * "is the move real and tradable?": relative volume, gap, ATR (range), 52-week
 * position, moving-average trend, and RSI — computed from daily bars — then
 * fused into a single 0–100, momentum-biased Trade Score with a plain-English
 * "why". Everything is defensive about short history (returns null, never NaN).
 */

import type { Bar } from './massive'

export interface Signals {
  /** today's volume ÷ ~20-day average (2 = twice normal) */
  rvol: number | null
  /** open vs prior close, % */
  gapPct: number | null
  atr14: number | null
  /** ATR as % of price (typical daily range) */
  atrPct: number | null
  high52: number | null
  low52: number | null
  /** (price − 52w high) / 52w high × 100 (0 = at the high, negative = below) */
  pctFrom52High: number | null
  sma20: number | null
  sma50: number | null
  aboveSma20: boolean
  aboveSma50: boolean
  /** sma20 > sma50 (short-term trend up) */
  trendUp: boolean
  rsi14: number | null
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Simple moving average of the LAST n values (null if not enough history). */
export function sma(values: number[], n: number): number | null {
  if (values.length < n || n <= 0) return null
  return mean(values.slice(-n))
}

/** Wilder-ish RSI over the last n closes (null if not enough history). */
export function rsi(closes: number[], n = 14): number | null {
  if (closes.length < n + 1) return null
  let gains = 0
  let losses = 0
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }
  const avgGain = gains / n
  const avgLoss = losses / n
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** Average True Range over the last n bars (null if not enough history). */
export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null
  const trs: number[] = []
  for (let i = bars.length - n; i < bars.length; i++) {
    const prevC = bars[i - 1].c
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC))
    trs.push(tr)
  }
  return mean(trs)
}

/**
 * Compute signals from ascending daily bars + the live snapshot numbers. Daily
 * bars supply history (avg volume, ATR, 52-week range, SMAs, RSI); the live
 * price/volume/open/prevClose come from the snapshot so intraday reads are fresh.
 */
export function computeSignals(
  bars: Bar[],
  live: { price: number | null; todayVolume: number | null; dayOpen: number | null; prevClose: number | null }
): Signals {
  // history excludes a trailing partial bar for "today" when present (dedupe by
  // assuming the last bar may be today; use prior bars for the average).
  const hist = bars.length > 1 ? bars.slice(0, -1) : bars
  const closes = bars.map((b) => b.c)

  const vols = hist.map((b) => b.v).filter((v) => Number.isFinite(v) && v > 0)
  const avgVol = vols.length >= 5 ? mean(vols.slice(-20)) : null
  const rvol = avgVol && live.todayVolume ? live.todayVolume / avgVol : null

  const gapPct =
    live.dayOpen != null && live.prevClose != null && live.prevClose > 0
      ? ((live.dayOpen - live.prevClose) / live.prevClose) * 100
      : null

  const atr14 = atr(bars, 14)
  const price = live.price
  const atrPct = atr14 != null && price ? (atr14 / price) * 100 : null

  const year = bars.slice(-252)
  const high52 = year.length ? Math.max(...year.map((b) => b.h)) : null
  const low52 = year.length ? Math.min(...year.map((b) => b.l)) : null
  const pctFrom52High = high52 && price ? ((price - high52) / high52) * 100 : null

  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const aboveSma20 = price != null && sma20 != null && price > sma20
  const aboveSma50 = price != null && sma50 != null && price > sma50
  const trendUp = sma20 != null && sma50 != null && sma20 > sma50

  return {
    rvol: rvol != null ? round(rvol, 2) : null,
    gapPct: gapPct != null ? round(gapPct, 2) : null,
    atr14: atr14 != null ? round(atr14, 4) : null,
    atrPct: atrPct != null ? round(atrPct, 2) : null,
    high52: high52 != null ? round(high52, 2) : null,
    low52: low52 != null ? round(low52, 2) : null,
    pctFrom52High: pctFrom52High != null ? round(pctFrom52High, 2) : null,
    sma20: sma20 != null ? round(sma20, 2) : null,
    sma50: sma50 != null ? round(sma50, 2) : null,
    aboveSma20,
    aboveSma50,
    trendUp,
    rsi14: rsi(closes, 14) != null ? round(rsi(closes, 14) as number, 1) : null
  }
}

const round = (v: number, d: number): number => {
  const f = 10 ** d
  return Math.round(v * f) / f
}
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

/* --------------------------- session-aware RVOL --------------------------- */

export type VolMode =
  /** market open: compare volume-so-far vs the fraction of a day elapsed */
  | { kind: 'intraday'; fraction: number }
  /** premarket/closed: today's tape is empty — judge the LAST COMPLETE day */
  | { kind: 'lastComplete'; todayYmd: string }

const barYmd = (t: number): string => new Date(t).toISOString().slice(0, 10)

/**
 * Relative volume that doesn't lie by session. Naive RVOL (today ÷ 20-day avg)
 * reads ~0 in premarket and ~0.1 just after the open, which silently kills any
 * volume filter. Intraday mode scales the average by the elapsed fraction of
 * the session; lastComplete mode rates the most recent finished day instead.
 */
export function sessionRvol(bars: Bar[], todayVolume: number | null, mode: VolMode): number | null {
  if (bars.length === 0) return null
  if (mode.kind === 'lastComplete') {
    let idx = -1
    for (let i = bars.length - 1; i >= 0; i--) {
      if (barYmd(bars[i].t) < mode.todayYmd) {
        idx = i
        break
      }
    }
    if (idx < 20) return null
    let s = 0
    for (let k = idx - 20; k < idx; k++) s += bars[k].v
    const avg = s / 20
    return avg > 0 ? round(bars[idx].v / avg, 2) : null
  }
  if (todayVolume == null || todayVolume <= 0) return null
  const hist = bars.length > 1 ? bars.slice(0, -1) : bars
  const vols = hist.map((b) => b.v).filter((v) => Number.isFinite(v) && v > 0)
  if (vols.length < 5) return null
  const avg = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length)
  const frac = Math.max(0.05, Math.min(1, mode.fraction))
  return avg > 0 ? round(todayVolume / (avg * frac), 2) : null
}

/* -------------------------------- score ---------------------------------- */

export interface ScoreInput {
  changePct: number | null
  rvol: number | null
  gapPct: number | null
  atrPct: number | null
  pctFrom52High: number | null
  rsi14: number | null
  aboveSma20: boolean
  aboveSma50: boolean
  trendUp: boolean
  hasNews: boolean
  hasSocial?: boolean
  /** market regime context — chase-y components are damped in risk-off tape */
  regime?: 'risk-on' | 'neutral' | 'risk-off'
}

export interface ScoreResult {
  score: number
  label: 'A' | 'B' | 'C' | 'D' | 'F'
  reasons: string[]
}

/**
 * Fuse the signals into one 0–100 momentum/long-biased Trade Score. Weights:
 * relative volume 30, momentum 20, trend 15, breakout proximity 12, volatility
 * 8, RSI zone 5, news catalyst 10, social 5. Returns the top contributing
 * reasons so ranking is explainable, not a black box.
 */
export function tradeScore(i: ScoreInput): ScoreResult {
  const parts: { pts: number; reason: string; show: boolean }[] = []
  // In risk-off tape, damp the chase-y components (today's pop, breakout
  // proximity); in risk-on give them a modest boost. Volume/trend are regime-
  // agnostic evidence and stay untouched.
  const regimeMult = i.regime === 'risk-off' ? 0.6 : i.regime === 'risk-on' ? 1.15 : 1

  const rvolPts = i.rvol != null ? clamp01((i.rvol - 1) / 2) * 30 : 0
  parts.push({ pts: rvolPts, reason: i.rvol != null ? `${i.rvol.toFixed(1)}× relative volume` : '', show: (i.rvol ?? 0) >= 1.5 })

  const momPts = (i.changePct != null ? clamp01(i.changePct / 10) * 20 : 0) * regimeMult
  parts.push({ pts: momPts, reason: i.changePct != null ? `up ${i.changePct.toFixed(1)}% today` : '', show: (i.changePct ?? 0) >= 3 })

  const trendPts = (i.aboveSma20 ? 6 : 0) + (i.aboveSma50 ? 5 : 0) + (i.trendUp ? 4 : 0)
  parts.push({ pts: trendPts, reason: 'in an uptrend (above 20/50-day)', show: i.aboveSma20 && i.aboveSma50 })

  const breakoutPts = (i.pctFrom52High != null ? clamp01(1 - Math.abs(i.pctFrom52High) / 10) * 12 : 0) * regimeMult
  parts.push({ pts: breakoutPts, reason: 'near 52-week highs', show: (i.pctFrom52High ?? -99) > -3 })

  const atrPts = i.atrPct != null ? clamp01(i.atrPct / 6) * 8 : 0
  parts.push({ pts: atrPts, reason: 'high daily range', show: (i.atrPct ?? 0) >= 4 })

  const rsiPts = i.rsi14 == null ? 3 : i.rsi14 >= 80 ? 1 : i.rsi14 <= 30 ? 2 : i.rsi14 >= 50 ? 5 : 3
  parts.push({ pts: rsiPts, reason: i.rsi14 != null && i.rsi14 >= 80 ? 'overbought (RSI>80)' : 'healthy momentum (RSI)', show: i.rsi14 != null && i.rsi14 >= 80 })

  const newsPts = i.hasNews ? 10 : 0
  parts.push({ pts: newsPts, reason: 'fresh news catalyst', show: i.hasNews })

  const socialPts = i.hasSocial ? 5 : 0
  parts.push({ pts: socialPts, reason: 'social buzz', show: !!i.hasSocial })

  const score = Math.max(0, Math.min(100, Math.round(rvolPts + momPts + trendPts + breakoutPts + atrPts + rsiPts + newsPts + socialPts)))
  const label = score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : score >= 30 ? 'D' : 'F'
  const reasons = parts
    .filter((p) => p.show && p.reason)
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 4)
    .map((p) => p.reason)
  return { score, label, reasons }
}

/* ----------------------------- setup + plan ------------------------------ */

/** Classify the candidate into a recognizable trade setup archetype. */
export function classifySetup(s: Signals | undefined, changePct: number | null): string {
  if (!s) return 'Mover'
  const chg = changePct ?? 0
  const gap = s.gapPct ?? 0
  const rvol = s.rvol ?? 0
  const nearHigh = s.pctFrom52High != null && s.pctFrom52High > -3
  if (chg <= -3 && s.rsi14 != null && s.rsi14 < 35) return 'Oversold Bounce'
  if (gap >= 3 && rvol >= 1.5 && chg > 0) return 'Gap & Go'
  if (nearHigh && s.trendUp && rvol >= 1.2) return 'Momentum Breakout'
  if (s.trendUp && s.aboveSma20 && chg > 0) return 'Trend Continuation'
  if (rvol >= 2) return 'High-Volume Mover'
  return 'Mover'
}

export interface TradePlan {
  entry: number
  stop: number
  target: number
  rr: number
}

/**
 * A rough long-side trade plan from ATR: stop 1.5×ATR under entry, target the
 * greater of 2R or (if close overhead) the 52-week high. Educational scaffolding
 * for a plan — NOT advice.
 */
export function tradePlan(price: number | null, s: Signals | undefined): TradePlan | null {
  if (price == null || price <= 0 || !s || s.atr14 == null || s.atr14 <= 0) return null
  const atr = s.atr14
  const entry = round(price, 2)
  const stop = round(Math.max(0.01, price - 1.5 * atr), 2)
  const risk = entry - stop
  if (risk <= 0) return null
  let target = round(entry + 2 * risk, 2)
  if (s.high52 != null && s.high52 > entry && s.high52 < entry + 3 * risk) target = round(s.high52, 2)
  return { entry, stop, target, rr: round((target - entry) / risk, 2) }
}

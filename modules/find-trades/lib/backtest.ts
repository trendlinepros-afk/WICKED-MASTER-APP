import { tradeScore } from '../../stock-planner/ipc/market/signals'

/**
 * BACKTEST ENGINE (pure, unit-tested) — measures whether the Trade Score has
 * real predictive edge. Whole-market daily OHLCV history is folded into
 * per-ticker series; for each evaluable day we reconstruct the score exactly as
 * the screener would have computed it THAT morning (same tradeScore function,
 * point-in-time windows, no lookahead) and record the forward 1/5/20-trading-day
 * returns. Results are pooled per score grade (A–F) against the whole-universe
 * baseline, so "edge" = grade average − universe average.
 *
 * Honest limits, by design: no news/social inputs historically (those points of
 * the score can't fire, capping backtest scores slightly), and 52-week-high
 * proximity needs ~252 days so it only engages when enough history is supplied.
 * Survivorship is handled naturally: grouped-daily includes everything that
 * traded that day, delisted or not.
 */

export interface GroupedRow {
  T: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface DayRows {
  ymd: string
  rows: GroupedRow[]
}

export interface Series {
  dates: string[]
  o: number[]
  h: number[]
  l: number[]
  c: number[]
  v: number[]
}

/** Fold per-day whole-market rows into per-ticker aligned series (asc by date). */
export function buildSeries(days: DayRows[]): Map<string, Series> {
  const sorted = [...days].sort((a, b) => (a.ymd < b.ymd ? -1 : 1))
  const map = new Map<string, Series>()
  for (const day of sorted) {
    for (const r of day.rows) {
      if (!(r.c > 0) || !(r.v >= 0)) continue
      let s = map.get(r.T)
      if (!s) {
        s = { dates: [], o: [], h: [], l: [], c: [], v: [] }
        map.set(r.T, s)
      }
      s.dates.push(day.ymd)
      s.o.push(r.o)
      s.h.push(r.h)
      s.l.push(r.l)
      s.c.push(r.c)
      s.v.push(r.v)
    }
  }
  return map
}

/* ------------------------- windowed helpers (no alloc) -------------------- */

export function meanSlice(a: number[], from: number, to: number): number {
  let s = 0
  let n = 0
  for (let i = Math.max(0, from); i < to; i++) {
    s += a[i]
    n++
  }
  return n ? s / n : 0
}

/** SMA of the n values ending at index i (inclusive); null if not enough. */
export function smaAt(closes: number[], i: number, n: number): number | null {
  if (i + 1 < n) return null
  return meanSlice(closes, i - n + 1, i + 1)
}

/** RSI over the n diffs ending at index i; null if not enough history. */
export function rsiAt(closes: number[], i: number, n: number): number | null {
  if (i < n) return null
  let gains = 0
  let losses = 0
  for (let k = i - n + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1]
    if (d >= 0) gains += d
    else losses -= d
  }
  const avgGain = gains / n
  const avgLoss = losses / n
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** ATR over the n bars ending at index i; null if not enough history. */
export function atrAt(h: number[], l: number[], c: number[], i: number, n: number): number | null {
  if (i < n) return null
  let s = 0
  for (let k = i - n + 1; k <= i; k++) {
    const prevC = c[k - 1]
    s += Math.max(h[k] - l[k], Math.abs(h[k] - prevC), Math.abs(l[k] - prevC))
  }
  return s / n
}

/* --------------------------------- engine -------------------------------- */

export interface BtBucket {
  label: string
  n: number
  avgR1: number | null
  avgR5: number | null
  avgR20: number | null
  winRate5: number | null
  /** avgR5 minus the universe avgR5 (percentage points) */
  edge5: number | null
}

export interface BtResult {
  buckets: BtBucket[]
  all: BtBucket
  points: number
  tickers: number
  from: string
  to: string
}

export interface BtOptions {
  /** how many recent trading days per ticker to evaluate */
  evalWindow?: number
  minPrice?: number
  minDollarVol?: number
}

interface Agg {
  n: number
  s1: number
  n1: number
  s5: number
  n5: number
  w5: number
  s20: number
  n20: number
}

const newAgg = (): Agg => ({ n: 0, s1: 0, n1: 0, s5: 0, n5: 0, w5: 0, s20: 0, n20: 0 })
const rnd = (v: number): number => Math.round(v * 100) / 100

function toBucket(label: string, a: Agg, allAvg5: number | null): BtBucket {
  const avg = (s: number, n: number): number | null => (n > 0 ? rnd(s / n) : null)
  const avg5 = avg(a.s5, a.n5)
  return {
    label,
    n: a.n,
    avgR1: avg(a.s1, a.n1),
    avgR5: avg5,
    avgR20: avg(a.s20, a.n20),
    winRate5: a.n5 > 0 ? rnd((a.w5 / a.n5) * 100) : null,
    edge5: avg5 != null && allAvg5 != null ? rnd(avg5 - allAvg5) : null
  }
}

/** Replay the Trade Score across history and pool forward returns per grade. */
export function runBacktest(series: Map<string, Series>, opts: BtOptions = {}): BtResult {
  const evalWindow = opts.evalWindow ?? 60
  const minPrice = opts.minPrice ?? 1
  const minDollarVol = opts.minDollarVol ?? 1_000_000

  const byLabel = new Map<string, Agg>()
  const all = newAgg()
  let points = 0
  let tickers = 0
  let from = ''
  let to = ''

  for (const s of series.values()) {
    const L = s.c.length
    // need 21 bars of history (rvol 20 + prev close) and at least 1 forward bar
    const iStart = Math.max(21, L - 1 - evalWindow)
    const iEnd = L - 2
    if (iEnd < iStart) continue
    let used = false

    for (let i = iStart; i <= iEnd; i++) {
      const price = s.c[i]
      if (price < minPrice || price * s.v[i] < minDollarVol) continue

      const avgVol = meanSlice(s.v, i - 20, i)
      const prevC = s.c[i - 1]
      const atr = atrAt(s.h, s.l, s.c, i, 14)
      const sma20 = smaAt(s.c, i, 20)
      const sma50 = smaAt(s.c, i, 50)
      let high52: number | null = null
      if (i >= 252) {
        let m = 0
        for (let k = i - 251; k <= i; k++) if (s.h[k] > m) m = s.h[k]
        high52 = m
      }

      const score = tradeScore({
        changePct: prevC > 0 ? ((price - prevC) / prevC) * 100 : null,
        rvol: avgVol > 0 ? s.v[i] / avgVol : null,
        gapPct: prevC > 0 && s.o[i] > 0 ? ((s.o[i] - prevC) / prevC) * 100 : null,
        atrPct: atr != null ? (atr / price) * 100 : null,
        pctFrom52High: high52 != null && high52 > 0 ? ((price - high52) / high52) * 100 : null,
        rsi14: rsiAt(s.c, i, 14),
        aboveSma20: sma20 != null && price > sma20,
        aboveSma50: sma50 != null && price > sma50,
        trendUp: sma20 != null && sma50 != null && sma20 > sma50,
        hasNews: false
      })

      const r1 = (s.c[i + 1] / price - 1) * 100
      const r5 = i + 5 < L ? (s.c[i + 5] / price - 1) * 100 : null
      const r20 = i + 20 < L ? (s.c[i + 20] / price - 1) * 100 : null

      const agg = byLabel.get(score.label) ?? newAgg()
      for (const a of [agg, all]) {
        a.n++
        a.s1 += r1
        a.n1++
        if (r5 != null) {
          a.s5 += r5
          a.n5++
          if (r5 > 0) a.w5++
        }
        if (r20 != null) {
          a.s20 += r20
          a.n20++
        }
      }
      byLabel.set(score.label, agg)

      points++
      used = true
      const d = s.dates[i]
      if (!from || d < from) from = d
      if (!to || d > to) to = d
    }
    if (used) tickers++
  }

  const allBucket = toBucket('ALL', all, null)
  const buckets = ['A', 'B', 'C', 'D', 'F'].map((lb) => toBucket(lb, byLabel.get(lb) ?? newAgg(), allBucket.avgR5))
  return { buckets, all: allBucket, points, tickers, from, to }
}

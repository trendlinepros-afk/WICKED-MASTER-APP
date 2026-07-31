/**
 * Technical indicators computed from daily OHLCV bars (pure, no I/O). Feeds the
 * report's "Technical setup" section real numbers — moving averages, RSI, trend,
 * 52-week position, volume trend, volatility and recent support/resistance — so
 * the model can actually build a technical picture instead of saying "not
 * provided". Everything is null-safe: too little history → that field is null.
 */

export interface TechBar {
  h: number
  l: number
  c: number
  v: number
}

export interface Technicals {
  price: number
  weeklyChange: number | null
  sma20: number | null
  sma50: number | null
  sma200: number | null
  priceVsSma50Pct: number | null
  priceVsSma200Pct: number | null
  trend: string
  maRegime: string | null
  rsi14: number | null
  ret1m: number | null
  ret3m: number | null
  ret6m: number | null
  ret1y: number | null
  high52: number | null
  low52: number | null
  pctOfRange: number | null
  pctFromHigh: number | null
  avgVol20: number | null
  volTrendPct: number | null
  atrPct: number | null
  recentHigh: number | null
  recentLow: number | null
}

const avg = (a: number[]): number => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : 0)
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d

/** SMA over the last `n` closes, or null if there aren't enough. */
function sma(closes: number[], n: number): number | null {
  return closes.length >= n ? round(avg(closes.slice(-n))) : null
}

/** Simple RSI(period) from closes (0–100), or null if too short. */
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1]
    if (ch >= 0) gains += ch
    else losses -= ch
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return round(100 - 100 / (1 + rs), 1)
}

export function computeTechnicals(bars: TechBar[]): Technicals | null {
  const rows = bars.filter((b) => Number.isFinite(b.c) && b.c > 0)
  if (rows.length < 2) return null
  const closes = rows.map((b) => b.c)
  const last = closes[closes.length - 1]

  const retN = (n: number): number | null => {
    const i = closes.length - 1 - n
    if (i < 0) return null
    const past = closes[i]
    return past > 0 ? round(((last - past) / past) * 100, 2) : null
  }

  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)

  // 52-week range from intraday highs/lows over the last ~252 sessions.
  const yr = rows.slice(-252)
  const high52 = yr.length ? round(Math.max(...yr.map((b) => b.h))) : null
  const low52 = yr.length ? round(Math.min(...yr.map((b) => b.l))) : null
  const pctOfRange =
    high52 !== null && low52 !== null && high52 > low52 ? round(((last - low52) / (high52 - low52)) * 100, 0) : null
  const pctFromHigh = high52 !== null && high52 > 0 ? round(((last - high52) / high52) * 100, 1) : null

  // Volume trend: recent 10-day average vs the ~50-day average.
  const vols = rows.map((b) => b.v).filter((v) => Number.isFinite(v) && v > 0)
  const avgVol20 = vols.length >= 20 ? Math.round(avg(vols.slice(-20))) : null
  const vRecent = vols.length >= 10 ? avg(vols.slice(-10)) : null
  const vBase = vols.length >= 50 ? avg(vols.slice(-50)) : null
  const volTrendPct = vRecent !== null && vBase && vBase > 0 ? round(((vRecent - vBase) / vBase) * 100, 0) : null

  // ATR(14) as a % of price → a plain-English volatility gauge.
  let atrPct: number | null = null
  if (rows.length >= 15) {
    let sum = 0
    for (let i = rows.length - 14; i < rows.length; i++) {
      const tr = Math.max(
        rows[i].h - rows[i].l,
        Math.abs(rows[i].h - rows[i - 1].c),
        Math.abs(rows[i].l - rows[i - 1].c)
      )
      sum += tr
    }
    atrPct = last > 0 ? round((sum / 14 / last) * 100, 1) : null
  }

  // Recent swing high/low (~20 sessions) = the nearest support/resistance.
  const recent = rows.slice(-20)
  const recentHigh = recent.length ? round(Math.max(...recent.map((b) => b.h))) : null
  const recentLow = recent.length ? round(Math.min(...recent.map((b) => b.l))) : null

  const up = sma50 !== null && sma200 !== null && last > sma50 && sma50 > sma200
  const down = sma50 !== null && sma200 !== null && last < sma50 && sma50 < sma200
  const trend = up ? 'Uptrend' : down ? 'Downtrend' : 'Sideways / mixed'
  const maRegime =
    sma50 !== null && sma200 !== null
      ? sma50 >= sma200
        ? '50-DMA above 200-DMA (bullish structure)'
        : '50-DMA below 200-DMA (bearish structure)'
      : null

  return {
    price: round(last),
    weeklyChange: retN(5),
    sma20,
    sma50,
    sma200,
    priceVsSma50Pct: sma50 && sma50 > 0 ? round(((last - sma50) / sma50) * 100, 1) : null,
    priceVsSma200Pct: sma200 && sma200 > 0 ? round(((last - sma200) / sma200) * 100, 1) : null,
    trend,
    maRegime,
    rsi14: rsi(closes, 14),
    ret1m: retN(21),
    ret3m: retN(63),
    ret6m: retN(126),
    ret1y: retN(252),
    high52,
    low52,
    pctOfRange,
    pctFromHigh,
    avgVol20,
    volTrendPct,
    atrPct,
    recentHigh,
    recentLow
  }
}

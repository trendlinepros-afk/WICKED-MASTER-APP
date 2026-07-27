import type { Trade } from './analytics'
import { etParts } from './et'

/**
 * TradeViz-style metric suite (pure, unit-testable). Takes the round-trip
 * trades from analytics.buildTrades* and produces the scalar stat grid, the
 * bucket breakdowns (price / volume / time-of-day / day / month / year /
 * duration / position / asset type), per-bucket highlight panels, a drawdown
 * series, and — when a symbol→sector map is supplied — P&L by market sector.
 * All day/time grouping goes through the shared ET helper (lib/et.ts).
 *
 * Webull's order export carries no commissions, deposits/withdrawals or live
 * prices, so Gross == Net == Realized, and Unrealized / Total-Account-Value are
 * intentionally NOT produced (that whole "Account & Transactions" section was
 * excluded by request).
 */

/* ------------------------------- buckets --------------------------------- */

export interface MetricBucket {
  label: string
  pnl: number
  trades: number
  wins: number
  losses: number
  volume: number // summed cost basis
  shares: number
}

const emptyBucket = (label: string): MetricBucket => ({
  label,
  pnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  volume: 0,
  shares: 0
})

function addToBucket(b: MetricBucket, t: Trade): void {
  b.pnl += t.realizedPnl
  b.trades += 1
  if (t.realizedPnl > 1e-6) b.wins += 1
  else if (t.realizedPnl < -1e-6) b.losses += 1
  b.volume += t.costBasis
  b.shares += t.qty
}

/** Ranges are [min, maxExclusive); the last has max = Infinity. */
interface Range {
  label: string
  min: number
  max: number
}

const PRICE_RANGES: Range[] = [
  { label: '0 – 0.99', min: 0, max: 1 },
  { label: '1 – 1.99', min: 1, max: 2 },
  { label: '2 – 2.99', min: 2, max: 3 },
  { label: '3 – 3.99', min: 3, max: 4 },
  { label: '4 – 4.99', min: 4, max: 5 },
  { label: '5 – 9.99', min: 5, max: 10 },
  { label: '10 – 19.99', min: 10, max: 20 },
  { label: '20 – 49.99', min: 20, max: 50 },
  { label: '50 – 99.99', min: 50, max: 100 },
  { label: '100 – 199.99', min: 100, max: 200 },
  { label: '200 – 499.99', min: 200, max: 500 },
  { label: '500 +', min: 500, max: Infinity }
]

const VOLUME_RANGES: Range[] = [
  { label: '0 – 1', min: 0, max: 2 },
  { label: '2 – 3', min: 2, max: 4 },
  { label: '4 – 5', min: 4, max: 6 },
  { label: '5 – 10', min: 6, max: 11 },
  { label: '10 – 20', min: 11, max: 21 },
  { label: '20 – 50', min: 21, max: 51 },
  { label: '50 – 100', min: 51, max: 101 },
  { label: '100 – 500', min: 101, max: 501 },
  { label: '500 – 1000', min: 501, max: 1001 },
  { label: '1000 – 2000', min: 1001, max: 2001 },
  { label: '2000 – 3000', min: 2001, max: 3001 },
  { label: '3000 – 5000', min: 3001, max: 5001 },
  { label: '5000 – 10000', min: 5001, max: 10001 },
  { label: '10000 +', min: 10001, max: Infinity }
]

const DURATION_RANGES: Range[] = [
  { label: '0 – 10s', min: 0, max: 10 },
  { label: '10 – 30s', min: 10, max: 30 },
  { label: '30 – 60s', min: 30, max: 60 },
  { label: '1 – 2m', min: 60, max: 120 },
  { label: '2 – 5m', min: 120, max: 300 },
  { label: '5 – 10m', min: 300, max: 600 },
  { label: '10 – 20m', min: 600, max: 1200 },
  { label: '20 – 40m', min: 1200, max: 2400 },
  { label: '40 – 60m', min: 2400, max: 3600 },
  { label: '1 – 2h', min: 3600, max: 7200 },
  { label: '2 – 4h', min: 7200, max: 14400 },
  { label: '4 – 6h', min: 14400, max: 21600 },
  { label: '6h – 1d', min: 21600, max: 86400 },
  { label: '1 – 2d', min: 86400, max: 172800 },
  { label: '2 – 7d', min: 172800, max: 604800 },
  { label: '7 – 14d', min: 604800, max: 1209600 },
  { label: '14d +', min: 1209600, max: Infinity }
]

function bucketByRange(trades: Trade[], ranges: Range[], valueOf: (t: Trade) => number | null): MetricBucket[] {
  const buckets = ranges.map((r) => emptyBucket(r.label))
  for (const t of trades) {
    const v = valueOf(t)
    if (v == null) continue
    const idx = ranges.findIndex((r) => v >= r.min && v < r.max)
    if (idx >= 0) addToBucket(buckets[idx], t)
  }
  return buckets
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/* --------------------------- highlight panels ---------------------------- */

export interface BucketHighlights {
  best: MetricBucket | null // max pnl
  worst: MetricBucket | null // min pnl
  sweetSpot: { label: string; pnl: number } | null // best contiguous run
  dangerZone: { label: string; pnl: number } | null // worst contiguous run
  volumeHub: MetricBucket | null // most trades (activity concentration)
}

/** Best/worst single bucket, best/worst contiguous run, busiest bucket. */
export function highlightsOf(buckets: MetricBucket[]): BucketHighlights {
  const active = buckets.filter((b) => b.trades > 0)
  if (active.length === 0) return { best: null, worst: null, sweetSpot: null, dangerZone: null, volumeHub: null }
  const best = active.reduce((a, b) => (b.pnl > a.pnl ? b : a))
  const worst = active.reduce((a, b) => (b.pnl < a.pnl ? b : a))
  const volumeHub = active.reduce((a, b) => (b.trades > a.trades ? b : a))

  // best / worst contiguous run of buckets (Kadane, both directions), over the
  // ordered bucket list so "sweet spot" is a contiguous price/vol/time band.
  const run = (sign: 1 | -1): { label: string; pnl: number } | null => {
    let bestSum = -Infinity
    let bestLo = 0
    let bestHi = 0
    let curSum = 0
    let curLo = 0
    for (let i = 0; i < buckets.length; i++) {
      const v = buckets[i].pnl * sign
      if (curSum <= 0) {
        curSum = v
        curLo = i
      } else curSum += v
      if (curSum > bestSum) {
        bestSum = curSum
        bestLo = curLo
        bestHi = i
      }
    }
    if (bestSum <= 0) return null
    const label = bestLo === bestHi ? buckets[bestLo].label : `${buckets[bestLo].label} → ${buckets[bestHi].label}`
    let pnl = 0
    for (let i = bestLo; i <= bestHi; i++) pnl += buckets[i].pnl
    return { label, pnl }
  }
  return { best, worst, sweetSpot: run(1), dangerZone: run(-1), volumeHub }
}

/* ------------------------------ scalar grid ------------------------------ */

export interface PeriodAvg {
  pnl: number
  pct: number // avg % return over the period's cost basis
}

export interface TradeMetrics {
  // TOTALS (no commission/deposit data → gross = net = realized)
  totalPnl: number
  onlyProfit: number
  onlyLoss: number
  // EXTREMES
  bestTrade: number
  worstTrade: number
  bestDay: number
  worstDay: number
  // BY PERIOD (rolling windows ending at the latest close)
  lastDay: number
  lastWeek: number
  lastMonth: number
  lastYear: number
  // AVERAGES • PERIOD / WINNING / LOSING
  avgPerTrade: PeriodAvg
  avgPerDay: PeriodAvg
  avgPerMonth: PeriodAvg
  avgPerYear: PeriodAvg
  winAvgPerTrade: number
  winAvgPerDay: number
  winAvgPerMonth: number
  winAvgPerYear: number
  lossAvgPerTrade: number
  lossAvgPerDay: number
  lossAvgPerMonth: number
  lossAvgPerYear: number
  // WIN / LOSS %
  winningTradesPct: number
  breakevenTradesPct: number
  avgWinningPct: number
  avgLosingPct: number
  // counts used above
  tradingDays: number
  tradingMonths: number
  tradingYears: number
  closedTrades: number

  // BUCKET BREAKDOWNS
  byPriceRange: MetricBucket[]
  byVolumeRange: MetricBucket[]
  byTimeOfDay: MetricBucket[]
  byDayOfWeek: MetricBucket[]
  byMonth: MetricBucket[]
  byYear: MetricBucket[]
  byDurationRange: MetricBucket[]
  byPosition: MetricBucket[]
  byAssetType: MetricBucket[]
  // derived highlight panels
  priceHi: BucketHighlights
  volumeHi: BucketHighlights
  timeHi: BucketHighlights
  durationHi: BucketHighlights
  // special time windows
  marketOpen: MetricBucket // 09:30–10:30 ET
  powerHour: MetricBucket // 15:00–16:00 ET
  // drawdown curve (daily)
  drawdown: { date: string; value: number }[]
  // scalar drawdown / consistency (competitor-journal staples)
  maxDrawdown: number // most-negative $ from a running peak (≤ 0)
  maxDrawdownPct: number // that trough as % of the peak it fell from (≤ 0)
  longestDrawdownDays: number // longest run of consecutive days under water
  dailyStdev: number // std-dev of daily P&L (consistency)
  // per-day P&L for the calendar heatmap
  daily: { date: string; pnl: number; trades: number; wins: number; losses: number }[]
  // per-trade P&L histogram
  pnlDistribution: MetricBucket[]
  // weekday × hour P&L heatmap ([dow 0-6][hour 0-23])
  weekdayHourPnl: number[][]
  weekdayHourN: number[][]
  // P&L by market sector (populated only when a sector map is supplied)
  bySector: MetricBucket[]
}

const PNL_RANGES: Range[] = [
  { label: '≤ -500', min: -Infinity, max: -500 },
  { label: '-500 to -200', min: -500, max: -200 },
  { label: '-200 to -100', min: -200, max: -100 },
  { label: '-100 to -50', min: -100, max: -50 },
  { label: '-50 to 0', min: -50, max: 0 },
  { label: '0 to 50', min: 0, max: 50 },
  { label: '50 to 100', min: 50, max: 100 },
  { label: '100 to 200', min: 100, max: 200 },
  { label: '200 to 500', min: 200, max: 500 },
  { label: '500 +', min: 500, max: Infinity }
]

/** Half-open [start,end) minute-of-day windows for time-of-day buckets (30m). */
function timeOfDayLabel(hour: number, minute: number): string {
  const startMin = minute < 30 ? 0 : 30
  const hh = String(hour).padStart(2, '0')
  const mm = String(startMin).padStart(2, '0')
  const endH = startMin === 30 ? (hour + 1) % 24 : hour
  const endM = startMin === 30 ? 0 : 30
  return `${hh}:${mm}–${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
}

export function computeMetrics(trades: Trade[], sectorOf?: Record<string, string>): TradeMetrics {
  const closed = trades.filter((t) => !t.isOpen && t.closedQty > 0 && t.closedAt != null)

  let onlyProfit = 0
  let onlyLoss = 0
  let bestTrade = 0
  let worstTrade = 0
  let winPctSum = 0
  let winPctCount = 0
  let lossPctSum = 0
  let lossPctCount = 0
  let allPctSum = 0 // mean of every closed trade's % return (true per-trade avg %)
  let breakeven = 0
  let winning = 0

  const dayPnl = new Map<string, number>()
  const dayMap = new Map<string, MetricBucket>() // richer per-day (for the calendar)
  const monthKeys = new Set<string>()
  const yearKeys = new Set<string>()
  const weekdayHourPnl = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const weekdayHourN = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))

  const timeBuckets = new Map<string, MetricBucket>()
  const dow = DOW_LABEL.map((l) => emptyBucket(l))
  const monthAgg = MONTHS.map((l) => emptyBucket(l))
  const yearMap = new Map<number, MetricBucket>()
  const marketOpen = emptyBucket('Market open (9:30–10:30)')
  const powerHour = emptyBucket('Power hour (15:00–16:00)')
  const sectorMap = new Map<string, MetricBucket>()

  for (const t of closed) {
    const pnl = t.realizedPnl
    allPctSum += t.realizedPct
    if (pnl > 1e-6) {
      onlyProfit += pnl
      winning++
      winPctSum += t.realizedPct
      winPctCount++
    } else if (pnl < -1e-6) {
      onlyLoss += pnl
      lossPctSum += t.realizedPct
      lossPctCount++
    } else breakeven++
    bestTrade = Math.max(bestTrade, pnl)
    worstTrade = Math.min(worstTrade, pnl)

    const p = etParts(t.closedAt as number)
    dayPnl.set(p.ymd, (dayPnl.get(p.ymd) ?? 0) + pnl)
    const db = dayMap.get(p.ymd) ?? emptyBucket(p.ymd)
    addToBucket(db, t)
    dayMap.set(p.ymd, db)
    weekdayHourPnl[p.dow][p.hour] += pnl
    weekdayHourN[p.dow][p.hour] += 1
    monthKeys.add(`${p.y}-${p.m}`)
    yearKeys.add(String(p.y))

    // time of day
    const tl = timeOfDayLabel(p.hour, p.minute)
    const tb = timeBuckets.get(tl) ?? emptyBucket(tl)
    addToBucket(tb, t)
    timeBuckets.set(tl, tb)
    const mins = p.hour * 60 + p.minute
    if (mins >= 570 && mins < 630) addToBucket(marketOpen, t) // 9:30–10:30
    if (mins >= 900 && mins < 960) addToBucket(powerHour, t) // 15:00–16:00

    addToBucket(dow[p.dow], t)
    addToBucket(monthAgg[p.m - 1], t)
    const yb = yearMap.get(p.y) ?? emptyBucket(String(p.y))
    addToBucket(yb, t)
    yearMap.set(p.y, yb)

    if (sectorOf) {
      const sec = sectorOf[t.symbol] || 'Unclassified'
      const sb = sectorMap.get(sec) ?? emptyBucket(sec)
      addToBucket(sb, t)
      sectorMap.set(sec, sb)
    }
  }

  const totalPnl = onlyProfit + onlyLoss
  const tradingDays = dayPnl.size
  const tradingMonths = monthKeys.size
  const tradingYears = yearKeys.size
  const dayValues = [...dayPnl.values()]
  const bestDay = dayValues.length ? Math.max(...dayValues) : 0
  const worstDay = dayValues.length ? Math.min(...dayValues) : 0

  // by-period rolling windows anchored at the latest close
  const latest = closed.reduce((m, t) => Math.max(m, t.closedAt as number), 0)
  const windowSum = (ms: number): number =>
    closed.reduce((n, t) => ((latest - (t.closedAt as number)) <= ms ? n + t.realizedPnl : n), 0)
  const DAY = 86400_000
  const lastDayAnchor = latest ? etParts(latest).ymd : ''
  const lastDay = closed.reduce((n, t) => (etParts(t.closedAt as number).ymd === lastDayAnchor ? n + t.realizedPnl : n), 0)

  // averages
  const totalCost = closed.reduce((n, t) => n + t.costBasis, 0)
  const avgPct = (pnl: number, cost: number): number => (cost > 0 ? (pnl / cost) * 100 : 0)
  const nClosed = closed.length
  const winTotals = onlyProfit
  const lossTotals = onlyLoss
  const winDays = new Set([...dayPnl].filter(([, v]) => v > 0).map(([k]) => k)).size
  const lossDays = new Set([...dayPnl].filter(([, v]) => v < 0).map(([k]) => k)).size

  const bucketList = (m: Map<number, MetricBucket>): MetricBucket[] =>
    [...m.values()].sort((a, b) => Number(a.label) - Number(b.label))

  const byTimeOfDay = [...timeBuckets.values()].sort((a, b) => a.label.localeCompare(b.label))
  const byPriceRange = bucketByRange(closed, PRICE_RANGES, (t) => t.avgEntry)
  const byVolumeRange = bucketByRange(closed, VOLUME_RANGES, (t) => t.qty)
  const byDurationRange = bucketByRange(closed, DURATION_RANGES, (t) => t.holdSeconds)

  const posLong = emptyBucket('Long')
  const posShort = emptyBucket('Short')
  const assetStock = emptyBucket('Stock')
  for (const t of closed) {
    addToBucket(t.direction === 'long' ? posLong : posShort, t)
    addToBucket(assetStock, t) // Webull equity export = stock
  }

  // drawdown from daily cumulative equity (+ scalar max drawdown / underwater run)
  const orderedDays = [...dayPnl.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  let cum = 0
  let peak = 0
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  let underwater = 0
  let longestDrawdownDays = 0
  const drawdown = orderedDays.map(([date, v]) => {
    cum += v
    peak = Math.max(peak, cum)
    const dd = cum - peak
    if (dd < maxDrawdown) maxDrawdown = dd
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, (dd / peak) * 100)
    if (dd < -1e-9) {
      underwater += 1
      longestDrawdownDays = Math.max(longestDrawdownDays, underwater)
    } else underwater = 0
    return { date, value: dd }
  })

  // per-day P&L (calendar), P&L histogram, and daily-P&L std-dev (consistency)
  const daily = [...dayMap.values()]
    .sort((a, b) => (a.label < b.label ? -1 : 1))
    .map((b) => ({ date: b.label, pnl: b.pnl, trades: b.trades, wins: b.wins, losses: b.losses }))
  const pnlDistribution = bucketByRange(closed, PNL_RANGES, (t) => t.realizedPnl)
  const dayVals = [...dayPnl.values()]
  const dayMean = dayVals.length ? dayVals.reduce((n, v) => n + v, 0) / dayVals.length : 0
  const dailyStdev = dayVals.length
    ? Math.sqrt(dayVals.reduce((n, v) => n + (v - dayMean) ** 2, 0) / dayVals.length)
    : 0

  return {
    totalPnl,
    onlyProfit,
    onlyLoss,
    bestTrade,
    worstTrade,
    bestDay,
    worstDay,
    lastDay,
    lastWeek: windowSum(7 * DAY),
    lastMonth: windowSum(30 * DAY),
    lastYear: windowSum(365 * DAY),
    avgPerTrade: { pnl: nClosed ? totalPnl / nClosed : 0, pct: nClosed ? allPctSum / nClosed : 0 },
    avgPerDay: { pnl: tradingDays ? totalPnl / tradingDays : 0, pct: avgPct(totalPnl, totalCost) },
    avgPerMonth: { pnl: tradingMonths ? totalPnl / tradingMonths : 0, pct: avgPct(totalPnl, totalCost) },
    avgPerYear: { pnl: tradingYears ? totalPnl / tradingYears : 0, pct: avgPct(totalPnl, totalCost) },
    winAvgPerTrade: winning ? winTotals / winning : 0,
    winAvgPerDay: winDays ? winTotals / winDays : 0,
    winAvgPerMonth: tradingMonths ? winTotals / tradingMonths : 0,
    winAvgPerYear: tradingYears ? winTotals / tradingYears : 0,
    lossAvgPerTrade: lossPctCount ? lossTotals / lossPctCount : 0,
    lossAvgPerDay: lossDays ? lossTotals / lossDays : 0,
    lossAvgPerMonth: tradingMonths ? lossTotals / tradingMonths : 0,
    lossAvgPerYear: tradingYears ? lossTotals / tradingYears : 0,
    winningTradesPct: nClosed ? (winning / nClosed) * 100 : 0,
    breakevenTradesPct: nClosed ? (breakeven / nClosed) * 100 : 0,
    avgWinningPct: winPctCount ? winPctSum / winPctCount : 0,
    avgLosingPct: lossPctCount ? lossPctSum / lossPctCount : 0,
    tradingDays,
    tradingMonths,
    tradingYears,
    closedTrades: nClosed,
    byPriceRange,
    byVolumeRange,
    byTimeOfDay,
    byDayOfWeek: dow,
    byMonth: monthAgg,
    byYear: bucketList(yearMap),
    byDurationRange,
    byPosition: [posShort, posLong],
    byAssetType: [assetStock],
    priceHi: highlightsOf(byPriceRange),
    volumeHi: highlightsOf(byVolumeRange),
    timeHi: highlightsOf(byTimeOfDay),
    durationHi: highlightsOf(byDurationRange),
    marketOpen,
    powerHour,
    drawdown,
    maxDrawdown,
    maxDrawdownPct,
    longestDrawdownDays,
    dailyStdev,
    daily,
    pnlDistribution,
    weekdayHourPnl,
    weekdayHourN,
    bySector: [...sectorMap.values()].sort((a, b) => b.pnl - a.pnl)
  }
}

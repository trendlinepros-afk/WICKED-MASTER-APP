import { getAggregates, getFullSnapshot } from './massive'

/**
 * MARKET REGIME — the tape context every signal lives in. A 90-score breakout
 * means something different when SPY is under its 50-day and 70% of the market
 * is red. Classified from SPY trend + 5-day drift + market breadth (advancers
 * share of the live snapshot). classifyRegime is pure/unit-tested; getRegime
 * fetches (cached ~10 min) and fails soft to 'neutral'.
 */

export type RegimeLabel = 'risk-on' | 'neutral' | 'risk-off'

export interface Regime {
  label: RegimeLabel
  spyAbove20: boolean
  spyAbove50: boolean
  /** SPY 5-trading-day return, % */
  spyR5: number | null
  /** % of snapshot tickers up on the day */
  breadthPct: number | null
  asOf: number
}

const meanTail = (a: number[], n: number): number | null => {
  if (a.length < n) return null
  let s = 0
  for (let i = a.length - n; i < a.length; i++) s += a[i]
  return s / n
}

/** Pure classification from SPY daily closes (asc) + breadth %. */
export function classifyRegime(spyCloses: number[], breadthPct: number | null, asOf = 0): Regime {
  const last = spyCloses.length ? spyCloses[spyCloses.length - 1] : null
  const sma20 = meanTail(spyCloses, 20)
  const sma50 = meanTail(spyCloses, 50)
  const prev5 = spyCloses.length >= 6 ? spyCloses[spyCloses.length - 6] : null
  const spyAbove20 = last != null && sma20 != null && last > sma20
  const spyAbove50 = last != null && sma50 != null && last > sma50
  const spyR5 = last != null && prev5 != null && prev5 > 0 ? Math.round((last / prev5 - 1) * 10000) / 100 : null

  if (last == null || sma50 == null) return { label: 'neutral', spyAbove20, spyAbove50, spyR5, breadthPct, asOf }

  let pts = 0
  if (spyAbove20) pts += 1
  if (spyAbove50) pts += 1
  if (spyR5 != null && spyR5 > 0) pts += 0.5
  if (breadthPct != null) pts += breadthPct >= 55 ? 1 : breadthPct >= 45 ? 0.5 : 0

  const label: RegimeLabel = pts >= 2.5 ? 'risk-on' : pts <= 1 ? 'risk-off' : 'neutral'
  return { label, spyAbove20, spyAbove50, spyR5, breadthPct, asOf }
}

let cache: { at: number; regime: Regime } | null = null
const TTL_MS = 10 * 60 * 1000
const DAY_MS = 86_400_000

export async function getRegime(massiveKey: string): Promise<Regime> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.regime
  let closes: number[] = []
  let breadth: number | null = null
  try {
    const bars = await getAggregates(massiveKey, 'SPY', 1, 'day', Date.now() - 180 * DAY_MS, Date.now())
    closes = bars.map((b) => b.c)
  } catch {
    /* neutral fallback */
  }
  try {
    const snap = await getFullSnapshot(massiveKey)
    let up = 0
    let n = 0
    for (const r of snap) {
      const chg = r.todaysChangePerc
      if (typeof chg === 'number' && Number.isFinite(chg)) {
        n++
        if (chg > 0) up++
      }
    }
    if (n > 100) breadth = Math.round((up / n) * 100)
  } catch {
    /* breadth unknown */
  }
  const regime = classifyRegime(closes, breadth, Date.now())
  cache = { at: Date.now(), regime }
  return regime
}

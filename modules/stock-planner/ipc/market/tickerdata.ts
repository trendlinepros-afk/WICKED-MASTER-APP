/**
 * getTickerData — one call fans out to concurrent Massive/Finnhub requests and
 * assembles the full research picture for a ticker. Ported rules:
 *  - quote resolution via resolveQuote (0/negative = missing)
 *  - P/E = marketCap / netIncome ONLY when netIncome > 0
 *  - next-earnings cascade: Finnhub -> Massive/Benzinga -> Yahoo, with
 *    {date, isEstimate, source} or null — callers must never guess.
 */

import {
  getBenzingaEarnings,
  getFinancials,
  getMassiveNews,
  getPrevClose,
  getSnapshot,
  getTickerDetails,
  type NewsItem,
  type TickerDetails
} from './massive'
import {
  getCompanyNews,
  getFinnhubEarnings,
  getFinnhubMetrics,
  getFinnhubRecommendation,
  type AnalystConsensus,
  type EarningsDate
} from './finnhub'
import { computePE, resolveQuote, type ResolvedQuote } from './quotes'
import { etTodayYmd } from './sessions'
import { yahooEarnings, yahooFundamentals, yahooQuoteFallback, type RatingAction } from './yahoo'

export interface TickerData {
  symbol: string
  details: TickerDetails | null
  quote: ResolvedQuote
  pe: number | null
  revenue: number | null
  netIncome: number | null
  /** Sector: Polygon SIC first, Yahoo assetProfile fallback (covers foreign ADRs). */
  sector: string | null
  earnings: EarningsDate | null
  news: NewsItem[]
  /** 52-week price range (Finnhub, Yahoo fallback) */
  week52High: number | null
  week52Low: number | null
  /** analyst Buy/Hold/Sell consensus (Finnhub) */
  analyst: AnalystConsensus | null
  /** analyst price target + recent per-firm rating actions (Yahoo, free) */
  priceTarget: { mean: number | null; high: number | null; low: number | null; num: number | null } | null
  ratingActions: RatingAction[]
  /** TTM net margin as a fraction (Yahoo, free) — more current than annual filings */
  netMarginTTM: number | null
  /** forward dividend yield as a fraction (Yahoo, free); null = non-payer/unknown */
  dividendYield: number | null
}

export interface MarketKeys {
  massive: string | null
  finnhub: string | null
}

async function earningsCascade(keys: MarketKeys, sym: string): Promise<EarningsDate | null> {
  if (keys.finnhub) {
    const f = await getFinnhubEarnings(keys.finnhub, sym)
    if (f) return f
  }
  if (keys.massive) {
    const b = await getBenzingaEarnings(keys.massive, sym, etTodayYmd())
    if (b) return { date: b.date, isEstimate: false, source: 'massive' }
  }
  const y = await yahooEarnings(sym)
  if (y) return { date: y.date, isEstimate: y.isEstimate, source: 'yahoo' }
  return null
}

export async function getTickerData(
  keys: MarketKeys,
  symRaw: string,
  extras = false
): Promise<TickerData> {
  const sym = symRaw.trim().toUpperCase()
  const m = keys.massive

  const [details, snapshot, prev, financials, news, earnings, finnhubMetrics, analyst, yahoo] = await Promise.all([
    m ? getTickerDetails(m, sym) : null,
    m ? getSnapshot(m, sym) : null,
    m ? getPrevClose(m, sym) : null,
    m ? getFinancials(m, sym) : { revenue: null, netIncome: null },
    extras
      ? keys.finnhub
        ? getCompanyNews(keys.finnhub, sym)
        : m
          ? getMassiveNews(m, sym)
          : []
      : [],
    extras ? earningsCascade(keys, sym) : null,
    // Finnhub-only data: a P/E fallback + the 52-week range, and the analyst
    // Buy/Hold/Sell consensus. Polygon/Massive provides none of these.
    extras && keys.finnhub ? getFinnhubMetrics(keys.finnhub, sym) : null,
    extras && keys.finnhub ? getFinnhubRecommendation(keys.finnhub, sym) : null,
    // Yahoo (free, keyless): analyst price target + per-firm upgrade/downgrade
    // history + TTM margin — none of which Finnhub's free tier exposes.
    extras ? yahooFundamentals(sym) : null
  ])

  let quote = resolveQuote(snapshot, prev)
  if (quote.price === null) {
    // Yahoo last resort so the panel isn't blank on a Massive gap
    const y = await yahooQuoteFallback(sym)
    if (y !== null) quote = { ...quote, price: y }
  }

  return {
    symbol: sym,
    details,
    quote,
    pe: computePE(details?.marketCap, financials.netIncome) ?? finnhubMetrics?.pe ?? yahoo?.trailingPE ?? null,
    // Polygon annual revenue first; Yahoo TTM revenue fills the gap for foreign
    // filers (e.g. CX) that never appear in Polygon's SEC-XBRL financials feed.
    revenue: financials.revenue ?? yahoo?.revenueTTM ?? null,
    netIncome: financials.netIncome,
    sector: (details?.sector && details.sector.trim()) || yahoo?.sector || null,
    earnings,
    news,
    week52High: finnhubMetrics?.week52High ?? yahoo?.week52High ?? null,
    week52Low: finnhubMetrics?.week52Low ?? yahoo?.week52Low ?? null,
    analyst,
    priceTarget: yahoo && (yahoo.targetMean != null || yahoo.numAnalysts != null)
      ? { mean: yahoo.targetMean, high: yahoo.targetHigh, low: yahoo.targetLow, num: yahoo.numAnalysts }
      : null,
    ratingActions: yahoo?.ratingActions ?? [],
    netMarginTTM: yahoo?.netMarginTTM ?? null,
    dividendYield: yahoo?.dividendYield ?? null
  }
}

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
import { getCompanyNews, getFinnhubEarnings, getFinnhubPE, type EarningsDate } from './finnhub'
import { computePE, resolveQuote, type ResolvedQuote } from './quotes'
import { etTodayYmd } from './sessions'
import { yahooEarnings, yahooQuoteFallback } from './yahoo'

export interface TickerData {
  symbol: string
  details: TickerDetails | null
  quote: ResolvedQuote
  pe: number | null
  revenue: number | null
  netIncome: number | null
  earnings: EarningsDate | null
  news: NewsItem[]
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

  const [details, snapshot, prev, financials, news, earnings, finnhubPe] = await Promise.all([
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
    // Robust P/E: prefer marketCap/net-income (gives a negative on a net loss);
    // fall back to Finnhub's reported trailing P/E when our fundamentals are thin.
    extras && keys.finnhub ? getFinnhubPE(keys.finnhub, sym) : null
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
    pe: computePE(details?.marketCap, financials.netIncome) ?? finnhubPe,
    revenue: financials.revenue,
    netIncome: financials.netIncome,
    earnings,
    news
  }
}

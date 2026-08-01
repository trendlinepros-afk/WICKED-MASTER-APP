/**
 * Finnhub client — news + earnings dates. ?token= query auth, 12s timeout,
 * fail-soft like the Massive client.
 */

import { etTodayYmd, etYmdDaysAgo, etParts } from './sessions'
import type { NewsItem } from './massive'

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const BASE = 'https://finnhub.io/api/v1'
const TIMEOUT_MS = 12_000

async function finnhubFetch(key: string, path: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?'
  try {
    const resp = await fetch(`${BASE}${path}${sep}token=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface SymbolHit {
  ticker: string
  name: string
}

/**
 * Symbol search for the search-box typeahead (`/search?q=`). Finnhub's free tier
 * allows ~60 req/min — comfortable for as-you-type — and matches on both symbol
 * and company name, so "Jet" surfaces JBLU and "JB" surfaces JBLU. We keep clean
 * US listings (plain A–Z symbols, dropping foreign venue suffixes like JBLU.MX)
 * and cap the list. Fail-soft: any error yields an empty list, never a throw.
 */
export async function searchSymbols(key: string, q: string, limit = 8): Promise<SymbolHit[]> {
  const j = await finnhubFetch(key, `/search?q=${encodeURIComponent(q)}`)
  const out: SymbolHit[] = []
  const seen = new Set<string>()
  for (const r of arr(rec(j).result).map(rec)) {
    const ticker = String(r.symbol ?? '').trim().toUpperCase()
    const name = String(r.description ?? '').trim()
    // Primary US listings only — plain letter symbols (AAPL, JBLU, SOXX);
    // skips foreign venue suffixes (JBLU.MX, VOD.L) and odd class notations.
    if (!ticker || !name || !/^[A-Z]{1,6}$/.test(ticker) || seen.has(ticker)) continue
    seen.add(ticker)
    out.push({ ticker, name })
    if (out.length >= limit) break
  }
  return out
}

export interface EarningsDate {
  date: string
  isEstimate: boolean
  source: 'finnhub' | 'massive' | 'yahoo'
  /** bmo (before open) / amc (after close) when known */
  hour?: string
}

/** Next earnings date — FIRST choice in the cascade. */
export async function getFinnhubEarnings(key: string, sym: string): Promise<EarningsDate | null> {
  const from = etTodayYmd()
  const to = etYmdDaysAgo(-400) // 400 days ahead
  const j = await finnhubFetch(key, `/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(sym)}`)
  const rows = arr(rec(j).earningsCalendar)
    .map(rec)
    .filter((r) => String(r.date ?? '') >= from)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const next = rows[0]
  if (!next) return null
  return {
    date: String(next.date),
    // "estimate" when epsActual is null (the report hasn't happened yet)
    isEstimate: next.epsActual == null,
    source: 'finnhub',
    hour: typeof next.hour === 'string' && next.hour ? next.hour : undefined
  }
}

export interface FinnhubMetrics {
  /** trailing P/E (negative on a net loss); Finnhub, one call */
  pe: number | null
  week52High: number | null
  week52Low: number | null
  /** dividend yield as a FRACTION (Finnhub reports a %, normalized here); null/0 = non-payer */
  dividendYield: number | null
}

/**
 * Basic-financials metrics from Finnhub (`/stock/metric`): a trailing P/E fallback
 * (negative for a net loss — never nulled), the 52-week price range, and the
 * dividend yield — none of which Polygon/Massive provides. One request, and it's
 * the reliable free source for the dividend (Yahoo's cookie/crumb path is flaky).
 */
export async function getFinnhubMetrics(key: string, sym: string): Promise<FinnhubMetrics> {
  const j = await finnhubFetch(key, `/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`)
  const m = rec(rec(j).metric)
  let pe: number | null = null
  for (const k of ['peTTM', 'peBasicExclExtraTTM', 'peExclExtraTTM', 'peNormalizedAnnual', 'peAnnual']) {
    const v = numOrNull(m[k])
    if (v != null && v !== 0) {
      pe = v
      break
    }
  }
  // Finnhub gives dividend yields as PERCENTAGES (e.g. 2.4 = 2.4%). Prefer the
  // forward/indicated figure, then trailing. Store as a fraction so the UI's
  // ×100 renders it correctly.
  let divPct: number | null = null
  for (const k of ['dividendYieldIndicatedAnnual', 'currentDividendYieldTTM', 'dividendYieldTTM', 'dividendYield']) {
    const v = numOrNull(m[k])
    if (v != null && v > 0) {
      divPct = v
      break
    }
  }
  return {
    pe,
    week52High: numOrNull(m['52WeekHigh']) ?? numOrNull(m['52WeekPriceHigh']),
    week52Low: numOrNull(m['52WeekLow']) ?? numOrNull(m['52WeekPriceLow']),
    dividendYield: divPct != null ? divPct / 100 : null
  }
}

/** Analyst rating consensus (Buy / Hold / Sell) — the "what Wall Street thinks" card. */
export interface AnalystConsensus {
  /** Strong Buy | Buy | Hold | Sell */
  label: string
  strongBuy: number
  buy: number
  hold: number
  sell: number
  strongSell: number
  total: number
}

/** Latest analyst recommendation trend from Finnhub (`/stock/recommendation`). */
export async function getFinnhubRecommendation(key: string, sym: string): Promise<AnalystConsensus | null> {
  const j = await finnhubFetch(key, `/stock/recommendation?symbol=${encodeURIComponent(sym)}`)
  const rows = arr(j).map(rec)
  if (rows.length === 0) return null
  const r = rows.sort((a, b) => String(b.period ?? '').localeCompare(String(a.period ?? '')))[0]
  const strongBuy = numOrNull(r.strongBuy) ?? 0
  const buy = numOrNull(r.buy) ?? 0
  const hold = numOrNull(r.hold) ?? 0
  const sell = numOrNull(r.sell) ?? 0
  const strongSell = numOrNull(r.strongSell) ?? 0
  const total = strongBuy + buy + hold + sell + strongSell
  if (total === 0) return null
  const bull = (strongBuy + buy) / total
  const bear = (sell + strongSell) / total
  const label = bull >= 0.75 ? 'Strong Buy' : bull >= 0.5 ? 'Buy' : bear >= 0.5 ? 'Sell' : 'Hold'
  return { label, strongBuy, buy, hold, sell, strongSell, total }
}

/** One past earnings report: the quarter end date + expected vs reported EPS. */
export interface EarningsHistoryRow {
  period: string
  estimate: number | null
  actual: number | null
}

/** The last `limit` reported quarters (most-recent first) — real numbers, never guessed. */
export async function getEarningsHistory(key: string, sym: string, limit = 4): Promise<EarningsHistoryRow[]> {
  const j = await finnhubFetch(key, `/stock/earnings?symbol=${encodeURIComponent(sym)}&limit=${limit}`)
  return arr(j)
    .map(rec)
    .map((r) => ({ period: String(r.period ?? ''), estimate: numOrNull(r.estimate), actual: numOrNull(r.actual) }))
    .filter((r) => r.period)
    .slice(0, limit)
}

/** Per-ticker headlines for the last 30 days (preferred over Massive news). */
export async function getCompanyNews(key: string, sym: string): Promise<NewsItem[]> {
  const from = etYmdDaysAgo(30)
  const to = etYmdDaysAgo(-1)
  const j = await finnhubFetch(key, `/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}`)
  return arr(j)
    .map((r) => {
      const n = rec(r)
      return {
        title: String(n.headline ?? ''),
        url: String(n.url ?? ''),
        source: String(n.source ?? ''),
        publishedAt: typeof n.datetime === 'number' ? new Date(n.datetime * 1000).toISOString() : ''
      }
    })
    .filter((n) => n.title)
    .slice(0, 12)
}

/* --------------------------- smart-money extras -------------------------- *
 *  Tier 3: analyst consensus, insider activity, and short/float where the plan
 *  provides them. All fail-soft — a missing/premium field is simply null.
 * ------------------------------------------------------------------------ */

export interface FinnhubExtras {
  /** % bullish analysts (strongBuy+buy of total) */
  analystBull: number | null
  analystLabel: string | null
  analystTotal: number | null
  /** net insider shares bought(+)/sold(−) over ~90 days */
  insiderNet: number | null
  insiderBuying: boolean
  /** short interest as % of float (only when the plan exposes it) */
  shortPctFloat: number | null
  floatShares: number | null
  beta: number | null
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = numOrNull(obj[k])
    if (v != null) return v
  }
  return null
}

/** Analyst trend + insider flow + (plan-permitting) short/float + beta. */
export async function getFinnhubExtras(key: string, sym: string): Promise<FinnhubExtras> {
  const out: FinnhubExtras = {
    analystBull: null,
    analystLabel: null,
    analystTotal: null,
    insiderNet: null,
    insiderBuying: false,
    shortPctFloat: null,
    floatShares: null,
    beta: null
  }

  // Analyst recommendation trend (latest period)
  const recJson = await finnhubFetch(key, `/stock/recommendation?symbol=${encodeURIComponent(sym)}`)
  const recRows = arr(recJson).map(rec)
  if (recRows.length > 0) {
    const r = recRows.sort((a, b) => String(b.period ?? '').localeCompare(String(a.period ?? '')))[0]
    const sb = numOrNull(r.strongBuy) ?? 0
    const b = numOrNull(r.buy) ?? 0
    const h = numOrNull(r.hold) ?? 0
    const s = numOrNull(r.sell) ?? 0
    const ss = numOrNull(r.strongSell) ?? 0
    const total = sb + b + h + s + ss
    if (total > 0) {
      const bull = (sb + b) / total
      const bear = (s + ss) / total
      out.analystTotal = total
      out.analystBull = Math.round(bull * 100)
      out.analystLabel = bull >= 0.75 ? 'Strong Buy' : bull >= 0.5 ? 'Buy' : bear >= 0.5 ? 'Sell' : 'Hold'
    }
  }

  // Insider transactions — net share change over ~90 days (Form 4)
  const insJson = await finnhubFetch(key, `/stock/insider-transactions?symbol=${encodeURIComponent(sym)}`)
  const insData = arr(rec(insJson).data).map(rec)
  if (insData.length > 0) {
    const since = etYmdDaysAgo(90)
    let net = 0
    let counted = 0
    for (const t of insData) {
      if (String(t.transactionDate ?? '') < since) continue
      const change = numOrNull(t.change)
      if (change != null) {
        net += change
        counted++
      }
    }
    if (counted > 0) {
      out.insiderNet = net
      out.insiderBuying = net > 0
    }
  }

  // Basic financials — beta always; short/float only if the plan includes them
  const metricJson = await finnhubFetch(key, `/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all`)
  const metric = rec(rec(metricJson).metric)
  if (Object.keys(metric).length > 0) {
    out.beta = pickNum(metric, ['beta'])
    out.shortPctFloat = pickNum(metric, ['shortInterestSharePercentOfFloat', 'shortPercentFloat', 'shortInterestPercentFloat'])
    out.floatShares = pickNum(metric, ['floatShares', 'shareFloat', 'freeFloat'])
  }

  return out
}

/* Market-wide headlines, cached until the 6:00 AM ET rollover. */
let generalNewsCache: { key: string; rows: NewsItem[] } | null = null

/** Cache key: the current "news day" — rolls over at 6:00 AM ET. */
function newsDayKey(now = new Date()): string {
  const p = etParts(now)
  return p.hour < 6 ? `${p.ymd}-early` : p.ymd
}

export async function getGeneralNews(key: string): Promise<NewsItem[]> {
  const day = newsDayKey()
  if (generalNewsCache && generalNewsCache.key === day) return generalNewsCache.rows
  const j = await finnhubFetch(key, `/news?category=general`)
  const rows = arr(j)
    .map((r) => {
      const n = rec(r)
      return {
        title: String(n.headline ?? ''),
        url: String(n.url ?? ''),
        source: String(n.source ?? ''),
        publishedAt: typeof n.datetime === 'number' ? new Date(n.datetime * 1000).toISOString() : '',
        summary: String(n.summary ?? ''),
        image: String(n.image ?? '')
      } as NewsItem & { summary: string; image: string }
    })
    .filter((n) => n.title)
    .slice(0, 40)
  if (rows.length > 0) generalNewsCache = { key: day, rows }
  return rows
}

/**
 * Yahoo Finance (unofficial, no key) — LAST-RESORT fallbacks only. Uses a
 * spoofed Chrome UA; brittle by nature, so every failure degrades to null and
 * nothing load-bearing is built on it.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const TIMEOUT_MS = 12_000

/** Quote fallback when Massive returns no usable price. */
export async function yahooQuoteFallback(sym: string): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!resp.ok) return null
    const j = (await resp.json()) as {
      chart?: { result?: { meta?: { regularMarketPrice?: number } }[] }
    }
    const p = j.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/* Cookie + crumb dance for the earnings fallback; creds cached 30 min. */
let creds: { at: number; cookie: string; crumb: string } | null = null

async function yahooCreds(): Promise<{ cookie: string; crumb: string } | null> {
  if (creds && Date.now() - creds.at < 30 * 60_000) return creds
  try {
    const home = await fetch('https://finance.yahoo.com', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow'
    })
    const setCookies = home.headers.getSetCookie?.() ?? []
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
    if (!cookie) return null
    const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!crumbResp.ok) return null
    const crumb = (await crumbResp.text()).trim()
    if (!crumb || crumb.includes('<')) return null
    creds = { at: Date.now(), cookie, crumb }
    return creds
  } catch {
    return null
  }
}

/** Pull a number out of Yahoo's `{raw,fmt}` (or bare number) fields. */
const yNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v && typeof v === 'object' && 'raw' in (v as Record<string, unknown>)) {
    const r = (v as { raw?: unknown }).raw
    return typeof r === 'number' && Number.isFinite(r) ? r : null
  }
  return null
}

export interface RatingAction {
  firm: string
  action: string // up | down | init | main | reit
  toGrade: string
  fromGrade: string
  date: string
}

/**
 * Rich fundamentals from Yahoo's unofficial quoteSummary (no key) — the FREE
 * source for the things Finnhub's free tier and Polygon don't give: analyst
 * PRICE TARGETS, per-firm UPGRADE/DOWNGRADE history, TTM margins, and cross-check
 * values for P/E, P/S, market cap and the 52-week range. Brittle → all fail-soft.
 */
export interface YahooFundamentals {
  marketCap: number | null
  trailingPE: number | null
  priceToSales: number | null
  week52High: number | null
  week52Low: number | null
  revenueTTM: number | null
  /** net profit margin as a fraction (e.g. -0.498) */
  netMarginTTM: number | null
  targetMean: number | null
  targetHigh: number | null
  targetLow: number | null
  /** e.g. 'buy' | 'hold' | 'strong_buy' | 'underperform' */
  recommendationKey: string | null
  numAnalysts: number | null
  ratingActions: RatingAction[]
}

export async function yahooFundamentals(sym: string): Promise<YahooFundamentals | null> {
  const c = await yahooCreds()
  if (!c) return null
  try {
    const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,upgradeDowngradeHistory'
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}&crumb=${encodeURIComponent(c.crumb)}`,
      { headers: { 'User-Agent': UA, Cookie: c.cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!resp.ok) return null
    const j = (await resp.json()) as { quoteSummary?: { result?: Record<string, Record<string, unknown>>[] } }
    const r = j.quoteSummary?.result?.[0]
    if (!r) return null
    const sd = (r.summaryDetail ?? {}) as Record<string, unknown>
    const fd = (r.financialData ?? {}) as Record<string, unknown>
    const pr = (r.price ?? {}) as Record<string, unknown>
    const hist = Array.isArray((r.upgradeDowngradeHistory as { history?: unknown[] })?.history)
      ? ((r.upgradeDowngradeHistory as { history: Record<string, unknown>[] }).history)
      : []
    const ratingActions: RatingAction[] = hist
      .slice(0, 8)
      .map((h) => ({
        firm: String(h.firm ?? ''),
        action: String(h.action ?? ''),
        toGrade: String(h.toGrade ?? ''),
        fromGrade: String(h.fromGrade ?? ''),
        date: typeof h.epochGradeDate === 'number' ? new Date(h.epochGradeDate * 1000).toISOString().slice(0, 10) : ''
      }))
      .filter((a) => a.firm && a.toGrade)
    return {
      marketCap: yNum(pr.marketCap) ?? yNum(sd.marketCap),
      trailingPE: yNum(sd.trailingPE),
      priceToSales: yNum(sd.priceToSalesTrailing12Months),
      week52High: yNum(sd.fiftyTwoWeekHigh),
      week52Low: yNum(sd.fiftyTwoWeekLow),
      revenueTTM: yNum(fd.totalRevenue),
      netMarginTTM: yNum(fd.profitMargins),
      targetMean: yNum(fd.targetMeanPrice),
      targetHigh: yNum(fd.targetHighPrice),
      targetLow: yNum(fd.targetLowPrice),
      recommendationKey: typeof fd.recommendationKey === 'string' ? fd.recommendationKey : null,
      numAnalysts: yNum(fd.numberOfAnalystOpinions),
      ratingActions
    }
  } catch {
    return null
  }
}

/** Earnings-date fallback (3rd in the cascade). Two dates = a range = estimate. */
export async function yahooEarnings(sym: string): Promise<{ date: string; isEstimate: boolean } | null> {
  const c = await yahooCreds()
  if (!c) return null
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents&crumb=${encodeURIComponent(c.crumb)}`,
      { headers: { 'User-Agent': UA, Cookie: c.cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    )
    if (!resp.ok) return null
    const j = (await resp.json()) as {
      quoteSummary?: {
        result?: { calendarEvents?: { earnings?: { earningsDate?: { fmt?: string }[] } } }[]
      }
    }
    const dates = j.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? []
    const first = dates[0]?.fmt
    if (!first) return null
    return { date: first, isEstimate: dates.length > 1 }
  } catch {
    return null
  }
}

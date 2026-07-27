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

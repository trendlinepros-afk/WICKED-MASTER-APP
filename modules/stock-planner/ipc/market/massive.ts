/**
 * MASSIVE (Polygon-compatible) client — the core market-data source.
 * Auth is "Authorization: Bearer <key>" (NOT Polygon's ?apiKey= param).
 * 15s timeout per request; every failure is swallowed to null/[] (fail-soft),
 * exactly like the web app.
 */

import { etTodayYmd, etYmdDaysAgo } from './sessions'

const DEFAULT_BASE = 'https://api.polygon.io'
const TIMEOUT_MS = 15_000

export type KeyFn = () => string | null

async function massiveFetchUrl(key: string, url: string): Promise<unknown> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

async function massiveFetch(key: string, path: string): Promise<unknown> {
  return massiveFetchUrl(key, `${DEFAULT_BASE}${path}`)
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/* ------------------------------- aggregates ------------------------------ */

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

function toBars(v: unknown): Bar[] {
  return arr(rec(v).results)
    .map((r) => {
      const b = rec(r)
      return { t: Number(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) }
    })
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c))
}

export async function getAggregates(
  key: string,
  sym: string,
  mult: number,
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month',
  fromMs: number,
  toMs: number
): Promise<Bar[]> {
  // Polygon's `limit` caps the BASE (minute) aggregates used to BUILD the
  // requested bars, not the rows returned. A months-long hourly query on a
  // liquid ticker exceeds 50k base bars, and with sort=asc the truncation
  // silently drops the NEWEST data — charts froze weeks in the past while
  // thinly-traded tickers (fewer base bars) stayed complete. Follow the
  // response's next_url pages until the window is covered.
  let url: string | null =
    `${DEFAULT_BASE}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${timespan}/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=50000`
  const out: Bar[] = []
  for (let page = 0; page < 10 && url; page++) {
    const j = await massiveFetchUrl(key, url)
    if (!j) break
    out.push(...toBars(j))
    const next = rec(j).next_url
    url = typeof next === 'string' && next.startsWith(DEFAULT_BASE) ? next : null
  }
  return out
}

/** Single-day 1-minute bars (Trade Review's execution chart). */
export async function getDayMinuteBars(key: string, sym: string, ymd: string): Promise<Bar[]> {
  const j = await massiveFetch(
    key,
    `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${ymd}/${ymd}?adjusted=true&sort=asc&limit=5000`
  )
  return toBars(j)
}

export async function getPrevClose(key: string, sym: string): Promise<{ c?: number; v?: number } | null> {
  const j = await massiveFetch(key, `/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true`)
  const r = rec(arr(rec(j).results)[0])
  const c = Number(r.c)
  const v = Number(r.v)
  if (!Number.isFinite(c)) return null
  return { c, v: Number.isFinite(v) ? v : undefined }
}

/**
 * Whole-market OHLCV for one date — UNCACHED lean fetch for the backtester,
 * which walks ~140 days and must not fill the grouped cache with millions of
 * rows. Returns [] on holidays.
 */
export interface GroupedOHLC {
  T: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export async function getGroupedOHLC(key: string, ymd: string): Promise<GroupedOHLC[]> {
  const j = await massiveFetch(key, `/v2/aggs/grouped/locale/us/market/stocks/${ymd}?adjusted=true&include_otc=false`)
  return arr(rec(j).results)
    .map((r) => {
      const b = rec(r)
      return { T: String(b.T ?? ''), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v) }
    })
    .filter((r) => r.T && Number.isFinite(r.c) && r.c > 0 && Number.isFinite(r.v))
}

/** Whole-market daily closes for one date (period gainers). 5-min cache/date. */
const groupedCache = new Map<string, { at: number; rows: { T: string; c: number; v: number }[] }>()

export async function getGroupedDaily(key: string, ymd: string): Promise<{ T: string; c: number; v: number }[]> {
  const hit = groupedCache.get(ymd)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows
  const j = await massiveFetch(key, `/v2/aggs/grouped/locale/us/market/stocks/${ymd}?adjusted=true&include_otc=false`)
  const rows = arr(rec(j).results)
    .map((r) => {
      const b = rec(r)
      return { T: String(b.T ?? ''), c: Number(b.c), v: Number(b.v) }
    })
    .filter((r) => r.T && Number.isFinite(r.c) && r.c > 0)
  if (rows.length > 0) groupedCache.set(ymd, { at: Date.now(), rows })
  return rows
}

/* ------------------------------- reference ------------------------------- */

export interface TickerHit {
  ticker: string
  name: string
}

export async function searchTickers(key: string, q: string): Promise<TickerHit[]> {
  const j = await massiveFetch(
    key,
    `/v3/reference/tickers?search=${encodeURIComponent(q)}&active=true&market=stocks&limit=20`
  )
  return arr(rec(j).results).map((r) => {
    const t = rec(r)
    return { ticker: String(t.ticker ?? ''), name: String(t.name ?? '') }
  })
}

export interface TickerDetails {
  name: string
  description: string
  homepage: string
  sector: string
  listDate: string
  marketCap: number | null
  employees: number | null
  /** Polygon security type code: CS (common stock), ETF, ETN, ADRC, FUND… */
  type: string
}

export async function getTickerDetails(key: string, sym: string): Promise<TickerDetails | null> {
  const j = await massiveFetch(key, `/v3/reference/tickers/${encodeURIComponent(sym)}`)
  const r = rec(rec(j).results)
  if (Object.keys(r).length === 0) return null
  const branding = rec(r.branding)
  void branding
  const cap = Number(r.market_cap)
  const emp = Number(r.total_employees)
  return {
    name: String(r.name ?? sym),
    description: String(r.description ?? ''),
    homepage: String(r.homepage_url ?? ''),
    sector: String(r.sic_description ?? ''),
    listDate: String(r.list_date ?? ''),
    marketCap: Number.isFinite(cap) && cap > 0 ? cap : null,
    employees: Number.isFinite(emp) && emp > 0 ? emp : null,
    type: String(r.type ?? '')
  }
}

export interface Financials {
  revenue: number | null
  netIncome: number | null
}

export async function getFinancials(key: string, sym: string): Promise<Financials> {
  const j = await massiveFetch(
    key,
    `/vX/reference/financials?ticker=${encodeURIComponent(sym)}&limit=1&timeframe=annual&order=desc`
  )
  const fin = rec(rec(arr(rec(j).results)[0]).financials)
  const income = rec(fin.income_statement)
  const rev = Number(rec(income.revenues).value)
  const ni = Number(rec(income.net_income_loss).value)
  return {
    revenue: Number.isFinite(rev) ? rev : null,
    netIncome: Number.isFinite(ni) ? ni : null
  }
}

/** IPO calendar: upcoming + recently listed. 5-min cache. */
export interface IpoRow {
  ticker: string
  name: string
  listingDate: string
  status: string
}

let ipoCache: { at: number; rows: IpoRow[] } | null = null

export async function getIpos(key: string): Promise<IpoRow[]> {
  if (ipoCache && Date.now() - ipoCache.at < 5 * 60_000) return ipoCache.rows
  const j = await massiveFetch(key, `/vX/reference/ipos?limit=200&order=desc&sort=listing_date`)
  const rows = arr(rec(j).results).map((r) => {
    const t = rec(r)
    return {
      ticker: String(t.ticker ?? ''),
      name: String(t.issuer_name ?? t.name ?? ''),
      listingDate: String(t.listing_date ?? ''),
      status: String(t.ipo_status ?? '')
    }
  })
  if (rows.length > 0) ipoCache = { at: Date.now(), rows }
  return rows
}

/* -------------------------------- snapshots ------------------------------ */

import type { SnapshotTicker } from './quotes'

export async function getSnapshot(key: string, sym: string): Promise<SnapshotTicker | null> {
  const j = await massiveFetch(key, `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}`)
  const t = rec(rec(j).ticker)
  if (Object.keys(t).length === 0) return null
  return t as SnapshotTicker
}

export interface FullSnapshotRow extends SnapshotTicker {
  ticker: string
}

/**
 * Whole-market rows synthesized from grouped end-of-day aggregates — the fallback
 * when the real-time snapshot endpoint is unavailable (basic plans / off hours),
 * so screeners and the Find Trades universe still have a market to scan. Uses the
 * latest trading day's OHLCV vs the prior trading day's close for the % change.
 */
async function groupedSnapshotFallback(key: string): Promise<FullSnapshotRow[]> {
  let latest: GroupedOHLC[] | null = null
  let latestBack = 0
  for (let back = 0; back <= 6; back++) {
    const ymd = back === 0 ? etTodayYmd() : etYmdDaysAgo(back)
    const rows = await getGroupedOHLC(key, ymd)
    if (rows.length > 0) {
      latest = rows
      latestBack = back
      break
    }
  }
  if (!latest) return []
  const prior = new Map<string, number>()
  for (let back = latestBack + 1; back <= latestBack + 7; back++) {
    const rows = await getGroupedDaily(key, etYmdDaysAgo(back))
    if (rows.length > 0) {
      for (const r of rows) prior.set(r.T, r.c)
      break
    }
  }
  return latest.map((r) => {
    const pc = prior.get(r.T)
    const row: FullSnapshotRow = {
      ticker: r.T,
      day: { o: r.o, h: r.h, l: r.l, c: r.c, v: r.v },
      lastTrade: { p: r.c },
      ...(pc != null && pc > 0
        ? { prevDay: { c: pc }, todaysChange: r.c - pc, todaysChangePerc: ((r.c - pc) / pc) * 100 }
        : {})
    }
    return row
  })
}

/** FULL market snapshot (pre/after/daily gainers). 20s cache. */
let fullSnapCache: { at: number; rows: FullSnapshotRow[] } | null = null

export async function getFullSnapshot(key: string): Promise<FullSnapshotRow[]> {
  if (fullSnapCache && Date.now() - fullSnapCache.at < 20_000) return fullSnapCache.rows
  const j = await massiveFetch(key, `/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=false`)
  let rows = arr(rec(j).tickers).map((r) => rec(r) as unknown as FullSnapshotRow).filter((r) => r.ticker)
  // Snapshot endpoint empty (plan-gated / off-hours) → synthesize from grouped EOD.
  if (rows.length === 0) rows = await groupedSnapshotFallback(key)
  if (rows.length > 0) fullSnapCache = { at: Date.now(), rows }
  return rows
}

/* ----------------------------- earnings / news --------------------------- */

/** Benzinga earnings via Massive (2nd choice in the cascade). */
export async function getBenzingaEarnings(
  key: string,
  sym: string,
  todayEt: string
): Promise<{ date: string } | null> {
  const j = await massiveFetch(
    key,
    `/benzinga/v1/earnings?ticker=${encodeURIComponent(sym)}&date.gte=${todayEt}&order=asc&sort=date&limit=10`
  )
  const r = rec(arr(rec(j).results)[0])
  const date = String(r.date ?? '')
  return date ? { date } : null
}

export interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: string
}

/** Massive news — fallback only; Finnhub is preferred. */
export async function getMassiveNews(key: string, sym: string): Promise<NewsItem[]> {
  const j = await massiveFetch(key, `/v2/reference/news?ticker=${encodeURIComponent(sym)}&limit=6&order=desc`)
  return arr(rec(j).results).map((r) => {
    const n = rec(r)
    return {
      title: String(n.title ?? ''),
      url: String(n.article_url ?? ''),
      source: String(rec(n.publisher).name ?? ''),
      publishedAt: String(n.published_utc ?? '')
    }
  })
}

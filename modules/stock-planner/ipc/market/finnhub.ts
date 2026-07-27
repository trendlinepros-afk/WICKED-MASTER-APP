/**
 * Finnhub client — news + earnings dates. ?token= query auth, 12s timeout,
 * fail-soft like the Massive client.
 */

import { etTodayYmd, etYmdDaysAgo, etParts } from './sessions'
import type { NewsItem } from './massive'

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

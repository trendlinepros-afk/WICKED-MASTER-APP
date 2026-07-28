/**
 * SEC EDGAR client (free, no key) — recent filings for a ticker, used to catch a
 * dilution/offering straight from the source (S-1/S-3/424B/F-1) even before the
 * news picks it up, plus recent 8-K (material event) and Form 4 (insider). SEC
 * requires a descriptive User-Agent and allows ~10 req/s.
 *
 * The classify function is pure/unit-tested; the two fetches are cached.
 */

const UA = 'WICKED-Suite/1.0 (stock research; contact: support@wickedrc.app)'
const TIMEOUT_MS = 12_000

async function secFetch(url: string): Promise<unknown> {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  }
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/* ------------------------------ ticker → CIK ----------------------------- */

let cikMap: Map<string, string> | null = null
let cikAt = 0
const CIK_TTL_MS = 12 * 60 * 60 * 1000

async function loadCikMap(): Promise<Map<string, string>> {
  if (cikMap && Date.now() - cikAt < CIK_TTL_MS) return cikMap
  const j = await secFetch('https://www.sec.gov/files/company_tickers.json')
  const map = new Map<string, string>()
  for (const v of Object.values(rec(j))) {
    const r = rec(v)
    const t = String(r.ticker ?? '').toUpperCase()
    const cik = String(r.cik_str ?? '').padStart(10, '0')
    if (t && r.cik_str != null) map.set(t, cik)
  }
  if (map.size > 0) {
    cikMap = map
    cikAt = Date.now()
  }
  return cikMap ?? map
}

export async function getCik(ticker: string): Promise<string | null> {
  const map = await loadCikMap()
  return map.get(ticker.toUpperCase()) ?? null
}

/* ------------------------------- filings --------------------------------- */

export interface Filing {
  form: string
  date: string
}

export interface EdgarSummary {
  /** S-1 / S-3 / 424B / F-1 / F-3 in the last ~30 days = offering/dilution risk */
  recentOffering: boolean
  recent8K: boolean
  insiderForm4: boolean
  /** SC 13D/13G in the last ~30 days = a 5%+ stake was disclosed (smart money) */
  stakeBuilding: boolean
  latest: Filing | null
}

const OFFERING_RE = /^(S-1|S-3|424B|F-1|F-3)/i
const STAKE_RE = /^SC ?13[DG]/i

function ymdDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

/** Classify a recent-filing list (pure). Windows: offering/8-K/13D 30d, Form 4 14d. */
export function classifyFilings(filings: Filing[], since30 = ymdDaysAgo(30), since14 = ymdDaysAgo(14)): EdgarSummary {
  let recentOffering = false
  let recent8K = false
  let insiderForm4 = false
  let stakeBuilding = false
  let latest: Filing | null = null
  for (const f of filings) {
    if (!latest || f.date > latest.date) latest = f
    if (f.date >= since30 && OFFERING_RE.test(f.form)) recentOffering = true
    if (f.date >= since30 && f.form === '8-K') recent8K = true
    if (f.date >= since30 && STAKE_RE.test(f.form)) stakeBuilding = true
    if (f.date >= since14 && (f.form === '4' || f.form === '4/A')) insiderForm4 = true
  }
  return { recentOffering, recent8K, insiderForm4, stakeBuilding, latest }
}

/** Recent filings for a ticker (last ~40), newest first. Cached per ticker. */
const filingsCache = new Map<string, { at: number; summary: EdgarSummary }>()
const FILINGS_TTL_MS = 30 * 60 * 1000

export async function getEdgarSummary(ticker: string): Promise<EdgarSummary | null> {
  const hit = filingsCache.get(ticker)
  if (hit && Date.now() - hit.at < FILINGS_TTL_MS) return hit.summary
  const cik = await getCik(ticker)
  if (!cik) return null
  const j = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`)
  const recentBlock = rec(rec(rec(j).filings).recent)
  const forms = arr(recentBlock.form).map(String)
  const dates = arr(recentBlock.filingDate).map(String)
  const filings: Filing[] = forms.slice(0, 60).map((form, i) => ({ form, date: dates[i] ?? '' })).filter((f) => f.date)
  const summary = classifyFilings(filings)
  filingsCache.set(ticker, { at: Date.now(), summary })
  return summary
}

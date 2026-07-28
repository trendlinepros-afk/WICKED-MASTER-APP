import { z } from 'zod'
import type { ScoreResult, Signals, TradePlan } from '../../stock-planner/ipc/market/signals'
import type { Catalyst } from '../../stock-planner/ipc/market/catalyst'
import type { FinnhubExtras } from '../../stock-planner/ipc/market/finnhub'
import type { EdgarSummary } from '../../stock-planner/ipc/market/edgar'
import type { StockTwitsRead } from '../../stock-planner/ipc/market/stocktwits'

/**
 * FIND TRADES — the AI turns a plain-English request ("low-priced stocks up big
 * premarket with news", "large caps down 3%+ on heavy volume") into a
 * ScreenPlan: a structured, machine-runnable screen the module executes against
 * the live market/news APIs. Everything here is pure + unit-tested; the network
 * fetch + AI calls live in ipc.ts.
 */

// Every field falls back INDEPENDENTLY via .catch() so one bad value from the
// AI (out-of-range limit, unknown enum, oversized array) can never sink the
// whole plan back to a bland default — the good criteria survive.
const numOrNull = z.number().nullable().catch(null)
const strArr = z.array(z.string().max(40)).catch([]).transform((a) => a.slice(0, 12))

export const ScreenPlanSchema = z.object({
  /** where the candidate universe comes from */
  source: z.enum(['movers', 'premarket', 'afterhours', 'ipos', 'tickers']).catch('movers'),
  /** explicit symbols when source = 'tickers' */
  tickers: z
    .array(z.string().max(8))
    .catch([])
    .transform((a) => a.slice(0, 50).map((s) => s.toUpperCase())),
  /** movers direction filter/sort */
  direction: z.enum(['up', 'down', 'any']).catch('any'),
  minPrice: numOrNull,
  maxPrice: numOrNull,
  minChangePct: numOrNull,
  maxChangePct: numOrNull,
  minVolume: numOrNull,
  maxVolume: numOrNull,
  /** market cap in DOLLARS */
  minMarketCap: numOrNull,
  maxMarketCap: numOrNull,
  /** broad sectors to keep (matched against our classifier output) */
  sectors: strArr,
  /** require recent company news */
  needsNews: z.boolean().catch(false),
  /** name/news keywords to match (e.g. "FDA", "earnings", "AI") */
  keywords: strArr,
  /* ---- technical (Tier 1) signal criteria ---- */
  /** minimum relative volume (2 = twice the 20-day average) */
  minRvol: numOrNull,
  /** minimum / maximum open-vs-prev-close gap % */
  minGapPct: numOrNull,
  maxGapPct: numOrNull,
  /** within ~5% of the 52-week high */
  nearHigh: z.boolean().catch(false),
  /** minimum ATR as % of price (a "mover") */
  minAtrPct: numOrNull,
  /** require a short-term uptrend (above 20-day, 20 > 50) */
  requireUptrend: z.boolean().catch(false),
  /** minimum unified Trade Score (0-100) */
  minScore: numOrNull,
  /* ---- Tier 3 smart-money criteria ---- */
  /** require net insider buying (last ~90 days) */
  insiderBuying: z.boolean().catch(false),
  /** minimum % bullish analysts */
  minAnalystBull: numOrNull,
  /** minimum short interest as % of float (squeeze candidates) */
  minShortPctFloat: numOrNull,
  /** only stocks with earnings within N days (earnings-runup plays) */
  maxDaysToEarnings: numOrNull,
  /** exclude stocks with earnings within ~2 days (don't hold through) */
  avoidEarnings: z.boolean().catch(false),
  /** bypass the default tradability gate (sub-$1 / thin dollar-volume names) */
  allowIlliquid: z.boolean().catch(false),
  /** how many final picks to return (clamped 1..30) */
  limit: z
    .number()
    .catch(12)
    .transform((v) => Math.max(1, Math.min(30, Math.round(v)))),
  /** what the AI understood the user to be asking for */
  rationale: z.string().catch('').transform((s) => s.slice(0, 400))
})

export type ScreenPlan = z.infer<typeof ScreenPlanSchema>

/** A candidate with the numbers the numeric filters need. */
export interface Candidate {
  ticker: string
  name?: string
  price: number | null
  changePct: number | null
  volume: number | null
  /** today's open + prior close, for the gap % signal */
  dayOpen?: number | null
  prevClose?: number | null
  sector?: string
  marketCap?: number | null
  news?: { title: string; url: string; source: string; publishedAt: string }[]
  /** news velocity — headline counts in 24h/72h (catalyst intensity) */
  newsCount24h?: number
  newsCount72h?: number
  newsHot?: boolean
  /** Tier 1 technical signals + unified Trade Score (attached at enrichment) */
  signals?: Signals
  score?: ScoreResult
  /** setup archetype, ATR trade plan, and catalyst classification */
  setup?: string
  plan?: TradePlan | null
  catalyst?: Catalyst | null
  /** Tier 3 smart-money extras (analyst / insider / short) */
  extras?: FinnhubExtras
  /** SEC EDGAR recent-filing summary (offering/8-K/Form 4) */
  edgar?: EdgarSummary | null
  /** StockTwits social read (second social source) */
  stocktwits?: StockTwitsRead | null
  /** tradability annotation from the liquidity gate */
  liquidity?: 'ok' | 'thin'
  /** FINRA short-sale volume as % of the day's tape */
  shortVolRatio?: number | null
  /** next earnings date + days away (negative/undefined = unknown) */
  earningsDate?: string | null
  daysToEarnings?: number | null
  earningsHour?: string
}

/* ------------------------------ plan parsing ----------------------------- */

function stripFences(raw: string): string {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return s
}

/** Tolerant parse: fences → strict → return a safe default plan on failure. */
export function parseScreenPlan(raw: string): ScreenPlan {
  try {
    const obj = JSON.parse(stripFences(raw))
    const wrapped = obj && typeof obj === 'object' && 'plan' in obj ? (obj as { plan: unknown }).plan : obj
    const res = ScreenPlanSchema.safeParse(wrapped)
    if (res.success) return res.data
  } catch {
    /* fall through to default */
  }
  return ScreenPlanSchema.parse({ source: 'movers', direction: 'any', rationale: '' })
}

/* --------------------------- numeric screening --------------------------- */

const inRange = (v: number | null, min: number | null, max: number | null): boolean => {
  if (v == null) return min == null && max == null ? true : false
  if (min != null && v < min) return false
  if (max != null && v > max) return false
  return true
}

/** Apply price / change% / volume / direction filters (pure). */
export function applyNumericFilters(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  return rows.filter((r) => {
    if (plan.direction === 'up' && !(r.changePct != null && r.changePct > 0)) return false
    if (plan.direction === 'down' && !(r.changePct != null && r.changePct < 0)) return false
    if (!inRange(r.price, plan.minPrice, plan.maxPrice)) return false
    if (!inRange(r.changePct, plan.minChangePct, plan.maxChangePct)) return false
    if (!inRange(r.volume, plan.minVolume, plan.maxVolume)) return false
    return true
  })
}

/** Sort by the plan's intent (direction, then volume as a tiebreak). */
export function rankRows(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  const chg = (r: Candidate): number => r.changePct ?? 0
  const vol = (r: Candidate): number => r.volume ?? 0
  const sorted = [...rows].sort((a, b) => {
    if (plan.direction === 'up') return chg(b) - chg(a) || vol(b) - vol(a)
    if (plan.direction === 'down') return chg(a) - chg(b) || vol(b) - vol(a)
    return Math.abs(chg(b)) - Math.abs(chg(a)) || vol(b) - vol(a)
  })
  return sorted
}

/** Post-enrichment filters that need sector / market-cap / news / keywords. */
export function applyEnrichedFilters(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  const wantSectors = plan.sectors.map((s) => s.toLowerCase())
  const kw = plan.keywords.map((k) => k.toLowerCase()).filter(Boolean)
  return rows.filter((r) => {
    if (!inRange(r.marketCap ?? null, plan.minMarketCap, plan.maxMarketCap)) return false
    if (wantSectors.length > 0) {
      const sec = (r.sector ?? '').toLowerCase()
      if (!wantSectors.some((w) => sec.includes(w) || w.includes(sec))) return false
    }
    if (plan.needsNews && (r.news?.length ?? 0) === 0) return false
    if (kw.length > 0) {
      const hay = `${r.name ?? ''} ${(r.news ?? []).map((n) => n.title).join(' ')}`.toLowerCase()
      if (!kw.some((k) => hay.includes(k))) return false
    }
    return true
  })
}

/** Filters that need the Tier 1 technical signals (attached at enrichment). */
export function applySignalFilters(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  return rows.filter((r) => {
    const s = r.signals
    if (plan.minRvol != null && !(s && s.rvol != null && s.rvol >= plan.minRvol)) return false
    if (plan.minGapPct != null && !(s && s.gapPct != null && s.gapPct >= plan.minGapPct)) return false
    if (plan.maxGapPct != null && !(s && s.gapPct != null && s.gapPct <= plan.maxGapPct)) return false
    if (plan.minAtrPct != null && !(s && s.atrPct != null && s.atrPct >= plan.minAtrPct)) return false
    if (plan.nearHigh && !(s && s.pctFrom52High != null && s.pctFrom52High >= -5)) return false
    if (plan.requireUptrend && !(s && s.trendUp && s.aboveSma20)) return false
    if (plan.minScore != null && !(r.score && r.score.score >= plan.minScore)) return false
    return true
  })
}

/**
 * TRADABILITY GATE — where retail bleeds. Drops names you can't realistically
 * trade (sub-$1 or < $500k traded today) unless the user explicitly asked for
 * them (allowIlliquid, or a maxPrice below $1 = a deliberate penny screen), and
 * annotates the survivors: < $2M/day = 'thin'. Rows with unknown price/volume
 * (e.g. IPO listings) pass through un-gated rather than being silently killed.
 */
export function applyLiquidityGate(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  const pennyScreen = plan.maxPrice != null && plan.maxPrice < 1
  return rows.filter((r) => {
    if (r.price == null || r.volume == null) return true
    const dollarVol = r.price * r.volume
    if (!plan.allowIlliquid && !pennyScreen && r.price < 1) return false
    if (!plan.allowIlliquid && dollarVol < 500_000) return false
    r.liquidity = dollarVol < 2_000_000 ? 'thin' : 'ok'
    return true
  })
}

/** Filters that need the Tier 3 smart-money extras (analyst / insider / short). */
export function applyExtrasFilters(rows: Candidate[], plan: ScreenPlan): Candidate[] {
  return rows.filter((r) => {
    const e = r.extras
    if (plan.insiderBuying && !(e && e.insiderBuying)) return false
    if (plan.minAnalystBull != null && !(e && e.analystBull != null && e.analystBull >= plan.minAnalystBull)) return false
    if (plan.minShortPctFloat != null && !(e && e.shortPctFloat != null && e.shortPctFloat >= plan.minShortPctFloat)) return false
    if (plan.maxDaysToEarnings != null && !(r.daysToEarnings != null && r.daysToEarnings >= 0 && r.daysToEarnings <= plan.maxDaysToEarnings)) return false
    if (plan.avoidEarnings && r.daysToEarnings != null && r.daysToEarnings >= 0 && r.daysToEarnings <= 2) return false
    return true
  })
}

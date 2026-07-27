import { z } from 'zod'

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
  sector?: string
  marketCap?: number | null
  news?: { title: string; url: string; source: string; publishedAt: string }[]
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

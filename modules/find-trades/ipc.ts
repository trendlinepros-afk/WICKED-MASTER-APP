import { Notification } from 'electron'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import { callAi, type AiKeys, type AiMessage } from '../stock-planner/ipc/ai'
import { marketSession } from '../stock-planner/ipc/market/sessions'
import { resolveQuote } from '../stock-planner/ipc/market/quotes'
import {
  getAggregates,
  getBenzingaEarnings,
  getFullSnapshot,
  getTickerDetails,
  getIpos,
  getMassiveNews,
  type Bar,
  type FullSnapshotRow
} from '../stock-planner/ipc/market/massive'
import { preMarketGainers, afterHoursGainers } from '../stock-planner/ipc/market/screeners'
import { getCompanyNews, getFinnhubEarnings, getFinnhubExtras, type FinnhubExtras } from '../stock-planner/ipc/market/finnhub'
import { etTodayYmd } from '../stock-planner/ipc/market/sessions'
import { classifySetup, computeSignals, tradePlan, tradeScore } from '../stock-planner/ipc/market/signals'
import { classifyCatalyst, newsVelocity } from '../stock-planner/ipc/market/catalyst'
import { getEdgarSummary } from '../stock-planner/ipc/market/edgar'
import { getStockTwits } from '../stock-planner/ipc/market/stocktwits'
import { classifySector } from '../trade-analytics/lib/sector'
import {
  applyEnrichedFilters,
  applyExtrasFilters,
  applyNumericFilters,
  applySignalFilters,
  parseScreenPlan,
  rankRows,
  type Candidate,
  type ScreenPlan
} from './lib/plan'
import { buildTonePrompt, fetchMentionCounts, fetchTrending, gradeGrowth, parseTones, rateTicker, tallyMentions, validTicker, type Tone } from './ipc/x'
import {
  emptyAlerts,
  evalAlerts,
  hasAnyAlert,
  normalizeItem,
  pickNewlyFired,
  type WatchItem
} from './lib/watch'

/* ------------------------------------------------------------------------ *
 *  FIND TRADES — an AI screener agent. A plain-English request is turned into
 *  a ScreenPlan (AI, JSON), executed against the live market snapshot + news
 *  (deterministic filtering), then the surviving candidates are ranked and
 *  explained by the AI. Market keys (massive/finnhub) and AI keys come from
 *  the shell vault; nothing is auto-used on the MCP path (see mcp.ts).
 * ------------------------------------------------------------------------ */

const ID = 'find-trades'
const PRE_ENRICH_CAP = 60 // numeric survivors carried into (rate-limited) enrichment
const ENRICH_CAP = 18 // how many we fetch sector/news/signals for
const EXTRAS_CAP = 12 // how many we fetch Finnhub smart-money extras for (rate-limit friendly)
const EDGAR_CAP = 8 // how many we check SEC EDGAR filings for

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
}

export interface Pick {
  ticker: string
  name: string
  price: number | null
  changePct: number | null
  volume: number | null
  sector: string
  marketCap: number | null
  thesis: string
  flags: string[]
  news: { title: string; url: string; source: string; publishedAt: string }[]
  /** Tier 1 Trade Score + key technical signals */
  score: number | null
  scoreLabel: string
  reasons: string[]
  rvol: number | null
  gapPct: number | null
  atrPct: number | null
  pctFrom52High: number | null
  rsi: number | null
  /** setup archetype, catalyst classification, ATR trade plan */
  setup: string
  catalyst: { type: string; avoid: boolean; label: string } | null
  plan: { entry: number; stop: number; target: number; rr: number } | null
  /** Tier 3 smart-money: analyst consensus, insider flow, short interest */
  analystBull: number | null
  analystLabel: string | null
  insiderBuying: boolean
  insiderNet: number | null
  shortPctFloat: number | null
  /** next earnings date + days away */
  daysToEarnings: number | null
  earningsHour: string | null
  /** SEC EDGAR recent-filing flags */
  secOffering: boolean
  sec8K: boolean
  /** StockTwits social read */
  stMessages: number | null
  stBullPct: number | null
  /** news velocity — headlines in 24h + hot flag */
  newsCount24h: number | null
  newsHot: boolean
}

/** One row of the "Trending on X" panel — a most-mentioned ticker + rating. */
export interface TrendRow {
  ticker: string
  name: string
  mentions: number
  engagement: number
  /** tone breakdown of the posts mentioning this ticker */
  positive: number
  hopeful: number
  negative: number
  neutral: number
  sentiment: number
  /** mention acceleration within the sampled window */
  velocity: string
  accel: number
  /** PROPOSED GROWTH — a sentiment lean from post tone (not a forecast) */
  growthScore: number
  growthPct: number
  growthGrade: string
  growthLabel: string
  growthConfidence: string
  price: number | null
  changePct: number | null
  volume: number | null
  /** heat rating (buzz + momentum + sentiment) */
  score: number
  label: string
}

/** A saved trending scan, kept in history for later viewing (no re-charge). */
export interface ScanRecord {
  id: string
  window: string
  scanSize: number
  generatedAt: number
  sampled: number
  endpoint: string
  marketValidated: boolean
  note: string
  /** how post tone was read: 'keywords' or 'AI (provider)' */
  toneBy?: string
  rows: TrendRow[]
}

const fmtCap = (v: number | null): string =>
  v == null ? 'n/a' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v.toFixed(0)}`

/** Project an enriched candidate to the UI Pick shape (thesis/flags optional). */
function toPick(c: Candidate, thesis = '', flags: string[] = []): Pick {
  return {
    ticker: c.ticker,
    name: c.name ?? '',
    price: c.price,
    changePct: c.changePct,
    volume: c.volume,
    sector: c.sector ?? '—',
    marketCap: c.marketCap ?? null,
    thesis,
    flags,
    news: c.news ?? [],
    score: c.score?.score ?? null,
    scoreLabel: c.score?.label ?? '',
    reasons: c.score?.reasons ?? [],
    rvol: c.signals?.rvol ?? null,
    gapPct: c.signals?.gapPct ?? null,
    atrPct: c.signals?.atrPct ?? null,
    pctFrom52High: c.signals?.pctFrom52High ?? null,
    rsi: c.signals?.rsi14 ?? null,
    setup: c.setup ?? 'Mover',
    catalyst: c.catalyst ?? null,
    plan: c.plan ?? null,
    analystBull: c.extras?.analystBull ?? null,
    analystLabel: c.extras?.analystLabel ?? null,
    insiderBuying: c.extras?.insiderBuying ?? false,
    insiderNet: c.extras?.insiderNet ?? null,
    shortPctFloat: c.extras?.shortPctFloat ?? null,
    daysToEarnings: c.daysToEarnings ?? null,
    earningsHour: c.earningsHour ?? null,
    secOffering: c.edgar?.recentOffering ?? false,
    sec8K: c.edgar?.recent8K ?? false,
    stMessages: c.stocktwits?.messages ?? null,
    stBullPct:
      c.stocktwits && c.stocktwits.bullish + c.stocktwits.bearish > 0
        ? Math.round((c.stocktwits.bullish / (c.stocktwits.bullish + c.stocktwits.bearish)) * 100)
        : null,
    newsCount24h: c.newsCount24h ?? null,
    newsHot: c.newsHot ?? false
  }
}

/* --------------------------- candidate universe -------------------------- */

/** Resolve a snapshot row to the numbers the screen needs. */
function rowToCandidate(r: FullSnapshotRow): Candidate {
  const q = resolveQuote(r, r.prevDay ?? null)
  return {
    ticker: r.ticker,
    price: q.price,
    changePct: q.changePct,
    volume: q.volume,
    dayOpen: typeof r.day?.o === 'number' ? r.day.o : null,
    prevClose: typeof r.prevDay?.c === 'number' ? r.prevDay.c : null
  }
}

async function buildUniverse(
  massiveKey: string,
  plan: ScreenPlan
): Promise<{ rows: Candidate[]; note: string }> {
  if (plan.source === 'ipos') {
    const ipos = await getIpos(massiveKey)
    return { rows: ipos.map((i) => ({ ticker: i.ticker, name: i.name, price: null, changePct: null, volume: null })), note: `${ipos.length} recent/upcoming IPOs` }
  }
  if (plan.source === 'tickers') {
    const want = new Set(plan.tickers.map((t) => t.toUpperCase()))
    const snap = await getFullSnapshot(massiveKey)
    return { rows: snap.filter((r) => want.has(r.ticker)).map(rowToCandidate), note: `${want.size} named ticker(s)` }
  }
  if (plan.source === 'premarket' || plan.source === 'afterhours') {
    const res = plan.source === 'premarket' ? await preMarketGainers(massiveKey) : await afterHoursGainers(massiveKey)
    if (!res.ok) return { rows: [], note: res.reason ?? 'session not active' }
    return {
      rows: res.rows.map((r) => ({ ticker: r.symbol, price: r.price, changePct: r.changePct, volume: r.volume })),
      note: `${res.rows.length} ${plan.source} movers`
    }
  }
  // default: the full market snapshot
  const snap = await getFullSnapshot(massiveKey)
  return { rows: snap.map(rowToCandidate), note: `${snap.length} US equities scanned` }
}

/* ------------------------------ enrichment ------------------------------- */

// Daily bars are stable within a session, so cache them per ticker to keep
// re-scans cheap on the Massive/Polygon quota.
const barsCache = new Map<string, { at: number; bars: Bar[] }>()
const BARS_TTL_MS = 30 * 60 * 1000
const DAY_MS = 86_400_000

async function dailyBars(massiveKey: string, ticker: string): Promise<Bar[]> {
  const hit = barsCache.get(ticker)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.bars
  const now = Date.now()
  const bars = await getAggregates(massiveKey, ticker, 1, 'day', now - 400 * DAY_MS, now)
  if (bars.length > 0) barsCache.set(ticker, { at: now, bars })
  return bars
}

/** Build the Trade Score for a candidate (hasSocial adds the small social bonus). */
function scoreFor(c: Candidate, hasSocial: boolean): ReturnType<typeof tradeScore> {
  return tradeScore({
    changePct: c.changePct,
    rvol: c.signals?.rvol ?? null,
    gapPct: c.signals?.gapPct ?? null,
    atrPct: c.signals?.atrPct ?? null,
    pctFrom52High: c.signals?.pctFrom52High ?? null,
    rsi14: c.signals?.rsi14 ?? null,
    aboveSma20: c.signals?.aboveSma20 ?? false,
    aboveSma50: c.signals?.aboveSma50 ?? false,
    trendUp: c.signals?.trendUp ?? false,
    hasNews: (c.news?.length ?? 0) > 0,
    hasSocial
  })
}

const extrasCache = new Map<string, { at: number; extras: FinnhubExtras }>()

async function tickerExtras(finnhubKey: string, ticker: string): Promise<FinnhubExtras> {
  const hit = extrasCache.get(ticker)
  if (hit && Date.now() - hit.at < BARS_TTL_MS) return hit.extras
  const extras = await getFinnhubExtras(finnhubKey, ticker)
  extrasCache.set(ticker, { at: Date.now(), extras })
  return extras
}

/** Attach news-velocity counts (24h/72h + hot) from a candidate's headlines. */
function attachNewsVel(c: Candidate): void {
  if (!c.news) return
  const v = newsVelocity(c.news, Date.now())
  c.newsCount24h = v.count24h
  c.newsCount72h = v.count72h
  c.newsHot = v.hot
}

/** Days from ET-today to a YYYY-MM-DD earnings date (null if unparseable). */
function daysToYmd(dateStr: string): number | null {
  const a = Date.parse(etTodayYmd() + 'T00:00:00Z')
  const b = Date.parse(dateStr + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / DAY_MS)
}

/**
 * Tier 3: attach analyst/insider/short extras + next earnings date to the top
 * candidates (bounded, cached). Earnings come from Finnhub, else Massive/Benzinga.
 */
async function enrichExtras(finnhubKey: string | null, massiveKey: string, rows: Candidate[]): Promise<void> {
  const queue = rows.slice(0, EXTRAS_CAP)
  const edgarSet = new Set(queue.slice(0, EDGAR_CAP).map((c) => c.ticker))
  const today = etTodayYmd()
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift()
      if (!c) return
      if (finnhubKey) {
        try {
          c.extras = await tickerExtras(finnhubKey, c.ticker)
        } catch {
          /* leave without extras */
        }
      }
      try {
        const earn = finnhubKey ? await getFinnhubEarnings(finnhubKey, c.ticker) : await getBenzingaEarnings(massiveKey, c.ticker, today)
        if (earn?.date) {
          c.earningsDate = earn.date
          c.daysToEarnings = daysToYmd(earn.date)
          c.earningsHour = 'hour' in earn ? (earn as { hour?: string }).hour : undefined
        }
      } catch {
        /* no earnings date */
      }
      // SEC EDGAR + StockTwits + news velocity (top few only).
      if (edgarSet.has(c.ticker)) {
        if (!c.news || c.news.length === 0) {
          try {
            c.news = finnhubKey ? await getCompanyNews(finnhubKey, c.ticker) : await getMassiveNews(massiveKey, c.ticker)
          } catch {
            c.news = []
          }
        }
        attachNewsVel(c)
        try {
          c.edgar = await getEdgarSummary(c.ticker)
          // A recent registration/offering filing is a strong AVOID — it beats
          // whatever the news-based catalyst said.
          if (c.edgar?.recentOffering) c.catalyst = { type: 'Offering', avoid: true, label: 'Recent SEC offering filing' }
        } catch {
          /* no filings */
        }
        try {
          c.stocktwits = await getStockTwits(c.ticker)
          // Meaningful bullish StockTwits chatter lights the social bonus.
          if (c.stocktwits && c.stocktwits.messages >= 5 && c.stocktwits.sentiment > 0.2) c.score = scoreFor(c, true)
        } catch {
          /* no StockTwits */
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
}

async function enrich(
  massiveKey: string,
  finnhubKey: string | null,
  rows: Candidate[],
  plan: ScreenPlan
): Promise<Candidate[]> {
  const need = rows.slice(0, ENRICH_CAP)
  const queue = [...need]
  const wantNews = plan.needsNews || plan.keywords.length > 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift()
      if (!c) return
      try {
        const details = await getTickerDetails(massiveKey, c.ticker)
        if (details) {
          c.name = details.name
          c.sector = details.sector ? classifySector(details.sector) : 'Unclassified'
          c.marketCap = details.marketCap
        }
      } catch {
        /* leave undecorated */
      }
      if (wantNews) {
        try {
          c.news = finnhubKey ? await getCompanyNews(finnhubKey, c.ticker) : await getMassiveNews(massiveKey, c.ticker)
        } catch {
          c.news = []
        }
        attachNewsVel(c)
      }
      // Tier 1: technical signals + unified Trade Score.
      try {
        const bars = await dailyBars(massiveKey, c.ticker)
        c.signals = computeSignals(bars, {
          price: c.price,
          todayVolume: c.volume,
          dayOpen: c.dayOpen ?? null,
          prevClose: c.prevClose ?? null
        })
      } catch {
        /* no signals — score falls back to what we have */
      }
      c.score = scoreFor(c, false)
      c.setup = classifySetup(c.signals, c.changePct)
      c.plan = tradePlan(c.price, c.signals)
      c.catalyst = classifyCatalyst((c.news ?? []).map((n) => n.title))
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker))
  return need
}

/* ------------------------------- AI stages ------------------------------- */

const PLAN_RULES =
  'You convert a trader\'s request into a JSON stock-screen plan. Return ONLY JSON (no prose) with this shape: ' +
  '{"source":"movers|premarket|afterhours|ipos|tickers","tickers":[],"direction":"up|down|any",' +
  '"minPrice":n|null,"maxPrice":n|null,"minChangePct":n|null,"maxChangePct":n|null,"minVolume":n|null,"maxVolume":n|null,' +
  '"minMarketCap":n|null,"maxMarketCap":n|null,"sectors":[],"needsNews":bool,"keywords":[],"limit":n,"rationale":"..."}. ' +
  'Rules: percentages are whole numbers (up 5% => minChangePct 5; down 3% => direction "down", maxChangePct -3). ' +
  'Market caps in DOLLARS (small-cap under $2B => maxMarketCap 2000000000; large-cap => minMarketCap 10000000000). ' +
  'Use source "premarket"/"afterhours" only if the user says so; otherwise "movers". Use sectors from this set when relevant: ' +
  'Technology, Healthcare, Financials, Energy, Utilities, Real Estate, Communication Services, Consumer Staples, ' +
  'Consumer Discretionary, Materials, Industrials. Set needsNews true when the user wants a catalyst/news. ' +
  'Put news/theme words (FDA, earnings, AI, buyout, guidance) in keywords. ' +
  'You may ALSO set technical fields: minRvol (relative volume, e.g. "high/unusual/heavy volume"=>2, "3x volume"=>3), ' +
  'minGapPct/maxGapPct ("gapping up 5%"=>minGapPct 5), nearHigh (true for "near/at 52-week highs, breakout"), ' +
  'minAtrPct (true movers/"volatile"=>3-5), requireUptrend (true for "uptrend, above moving averages, strong trend"), ' +
  'minScore (0-100, use 60+ only for "best/highest-quality/strongest setups"). ' +
  'Smart-money fields: insiderBuying (true for "insider buying"), minAnalystBull (0-100 for "analyst favorite/rated buy"), ' +
  'minShortPctFloat (for "high short interest/squeeze", e.g. 20). ' +
  'Earnings: maxDaysToEarnings (for "earnings coming up/this week/soon", e.g. 7), avoidEarnings (true for "no earnings/avoid earnings risk"). ' +
  'Leave any unused field null/false. Keep limit <= 20. rationale = one sentence.'

function rankPrompt(plan: ScreenPlan, cands: Candidate[]): string {
  const lines = cands.map((c) => {
    const s = c.signals
    const tech =
      ` | score ${c.score?.score ?? 'n/a'}${c.score?.label ? `(${c.score.label})` : ''}` +
      (s?.rvol != null ? ` | RVOL ${s.rvol}x` : '') +
      (s?.gapPct != null ? ` | gap ${s.gapPct}%` : '') +
      (s?.atrPct != null ? ` | ATR ${s.atrPct}%` : '') +
      (s?.pctFrom52High != null ? ` | ${s.pctFrom52High}% from 52w-high` : '') +
      (s?.rsi14 != null ? ` | RSI ${s.rsi14}` : '') +
      (s ? ` | ${s.trendUp && s.aboveSma20 ? 'uptrend' : s.aboveSma50 ? 'above 50d' : 'below MAs'}` : '') +
      (c.setup ? ` | setup ${c.setup}` : '') +
      (c.catalyst ? ` | catalyst ${c.catalyst.label}${c.catalyst.avoid ? ' (⚠CAUTION)' : ''}` : '') +
      (c.extras?.analystLabel ? ` | analysts ${c.extras.analystLabel} (${c.extras.analystBull}%)` : '') +
      (c.extras?.insiderBuying ? ' | insider buying' : '') +
      (c.extras?.shortPctFloat != null ? ` | short ${c.extras.shortPctFloat}% float` : '') +
      (c.daysToEarnings != null && c.daysToEarnings >= 0 && c.daysToEarnings <= 21 ? ` | earnings in ${c.daysToEarnings}d` : '') +
      (c.edgar?.recentOffering ? ' | ⚠RECENT SEC OFFERING FILING (dilution risk)' : '') +
      (c.stocktwits && c.stocktwits.bullish + c.stocktwits.bearish >= 3
        ? ` | StockTwits ${Math.round((c.stocktwits.bullish / (c.stocktwits.bullish + c.stocktwits.bearish)) * 100)}% bull`
        : '') +
      (c.newsCount24h != null && c.newsCount24h > 0 ? ` | ${c.newsCount24h} headline(s)/24h${c.newsHot ? ' (heavy news flow)' : ''}` : '')
    return (
      `${c.ticker} | ${c.name ?? ''} | price ${c.price ?? 'n/a'} | chg ${c.changePct?.toFixed(2) ?? 'n/a'}% | vol ${c.volume ?? 'n/a'} | ${c.sector ?? '?'} | cap ${fmtCap(c.marketCap ?? null)}` +
      tech +
      (c.news && c.news.length ? ` | news: ${c.news.slice(0, 2).map((n) => n.title).join(' /// ')}` : '')
    )
  })
  return (
    `The trader asked for: "${plan.rationale}". Here are the pre-filtered candidates with live data + technical signals ` +
    `(RVOL = relative volume, higher = a more real move; score = a 0-100 momentum Trade Score):\n\n${lines.join('\n')}\n\n` +
    'Pick the best matches — prefer higher Trade Score, higher relative volume, a real catalyst, and a clean trend; ' +
    'fewer higher-quality picks beat a long list. If a candidate\'s catalyst is a dilution/offering (marked CAUTION), ' +
    'either skip it or clearly warn in its flags. Return ONLY JSON: ' +
    '{"summary":"1-2 sentences on what you found","picks":[{"ticker":"","thesis":"one line why it fits (mention RVOL/catalyst/trend)","flags":["short risk/quality notes"]}]}. ' +
    'Base every claim on the data shown — do not invent prices or news. Educational only, not financial advice.'
  )
}

/* ------------------------------- presets --------------------------------- */

/** One-click deterministic scanners (no AI cost) — map to ScreenPlan fields. */
export interface Preset {
  id: string
  name: string
  desc: string
  plan: Record<string, unknown>
}

export const PRESETS: Preset[] = [
  { id: 'runners', name: 'Small-cap runners', desc: 'Up 5%+ on 2×+ volume, under $2B', plan: { source: 'movers', direction: 'up', minChangePct: 5, maxMarketCap: 2_000_000_000, minPrice: 1, minRvol: 2, limit: 15, rationale: 'Small-cap runners' } },
  { id: 'gap-news', name: 'Gap-ups with news', desc: 'Gapped up 3%+ with a fresh catalyst', plan: { source: 'movers', direction: 'up', minGapPct: 3, minRvol: 1.5, needsNews: true, limit: 15, rationale: 'Gap-ups with news' } },
  { id: 'near-highs', name: 'Near 52-week highs', desc: 'Breakout candidates in an uptrend', plan: { source: 'movers', direction: 'up', nearHigh: true, requireUptrend: true, minRvol: 1.2, limit: 15, rationale: 'Near 52-week highs' } },
  { id: 'high-rvol', name: 'Unusual volume', desc: 'Trading at 3×+ its normal volume', plan: { source: 'movers', direction: 'any', minRvol: 3, limit: 15, rationale: 'Unusual volume' } },
  { id: 'large-momentum', name: 'Large-cap momentum', desc: 'Big caps trending up on volume', plan: { source: 'movers', direction: 'up', minMarketCap: 10_000_000_000, minChangePct: 2, requireUptrend: true, minRvol: 1.2, limit: 15, rationale: 'Large-cap momentum' } },
  { id: 'oversold', name: 'Oversold bounce', desc: 'Down hard, may be due for a bounce', plan: { source: 'movers', direction: 'down', maxChangePct: -5, minRvol: 1.5, limit: 15, rationale: 'Oversold pullbacks' } },
  { id: 'squeeze', name: 'Squeeze candidates', desc: 'High short interest + moving up (needs Finnhub short data)', plan: { source: 'movers', direction: 'up', minShortPctFloat: 20, minRvol: 1.5, limit: 15, rationale: 'Short-squeeze candidates' } },
  { id: 'smart-money', name: 'Smart-money picks', desc: 'Analyst-loved + insider buying', plan: { source: 'movers', direction: 'up', minAnalystBull: 70, insiderBuying: true, minRvol: 1, limit: 15, rationale: 'Analyst + insider favorites' } },
  { id: 'earnings-soon', name: 'Earnings this week', desc: 'Movers reporting within 7 days (runup plays)', plan: { source: 'movers', direction: 'up', maxDaysToEarnings: 7, minRvol: 1.2, limit: 15, rationale: 'Earnings within a week' } }
]

interface RankOut {
  summary: string
  picks: { ticker: string; thesis: string; flags: string[] }[]
}

function parseRank(raw: string): RankOut {
  try {
    let s = raw.trim()
    const f = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (f) s = f[1]
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    const o = JSON.parse(s) as Partial<RankOut>
    return {
      summary: typeof o.summary === 'string' ? o.summary : '',
      picks: Array.isArray(o.picks)
        ? o.picks
            .filter((p) => p && typeof p.ticker === 'string')
            .map((p) => ({ ticker: String(p.ticker).toUpperCase(), thesis: String(p.thesis ?? ''), flags: Array.isArray(p.flags) ? p.flags.map(String).slice(0, 4) : [] }))
        : []
    }
  } catch {
    return { summary: '', picks: [] }
  }
}

/* -------------------------------- register ------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  const aiKeys = (): AiKeys => ({
    anthropic: ctx.getApiKey('anthropic'),
    gemini: ctx.getApiKey('gemini'),
    deepseek: ctx.getApiKey('deepseek'),
    openai: ctx.getApiKey('openai')
  })

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    hasMassive: !!ctx.getApiKey('massive'),
    hasFinnhub: !!ctx.getApiKey('finnhub'),
    hasAi: !!(ctx.getApiKey('anthropic') || ctx.getApiKey('gemini') || ctx.getApiKey('deepseek') || ctx.getApiKey('openai')),
    hasX: !!ctx.getApiKey('x'),
    session: marketSession()
  }))

  /* ---------------------------- X (social) trends ----------------------- */

  // Scans are USER-TRIGGERED (each costs X read credits), so nothing runs on
  // load. A short cache still guards against an accidental double-click charging
  // twice for the same window+size. Every fresh scan is saved to history so past
  // pulls can be re-viewed for free.
  const SCAN_KEY = `${ID}.xScanSize`
  const HISTORY_KEY = `${ID}.xScanHistory`
  const AITONE_KEY = `${ID}.xAiTone`
  const HISTORY_CAP = 20
  const xCache = new Map<string, { at: number; payload: Record<string, unknown> }>()
  const X_TTL_MS = 30 * 60 * 1000

  const clampScanSize = (n: number): number => (n === 200 ? 200 : n === 300 ? 300 : 100)
  const getScanSize = (): number => clampScanSize(Number(ctx.storeGet<number>(SCAN_KEY, 100)))
  const hasAiKey = (): boolean => !!(ctx.getApiKey('anthropic') || ctx.getApiKey('gemini') || ctx.getApiKey('deepseek') || ctx.getApiKey('openai'))
  // AI tone read defaults ON (a single cheap batched call per scan).
  const getAiTone = (): boolean => ctx.storeGet<boolean>(AITONE_KEY, true) !== false
  const readHistory = (): ScanRecord[] => {
    const v = ctx.storeGet<ScanRecord[]>(HISTORY_KEY, [])
    return Array.isArray(v) ? v : []
  }

  ctx.ipcMain.handle(`${ID}:x-status`, () => ({
    ok: true,
    hasX: !!ctx.getApiKey('x'),
    hasMassive: !!ctx.getApiKey('massive'),
    hasAi: hasAiKey(),
    scanSize: getScanSize(),
    aiTone: getAiTone()
  }))

  ctx.ipcMain.handle(`${ID}:x-set-scan-size`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const size = clampScanSize(Number(r.size))
    ctx.storeSet(SCAN_KEY, size)
    return { ok: true, scanSize: size }
  })

  ctx.ipcMain.handle(`${ID}:x-set-ai-tone`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof r.on === 'boolean') ctx.storeSet(AITONE_KEY, r.on)
    return { ok: true, aiTone: getAiTone() }
  })

  ctx.ipcMain.handle(`${ID}:x-history`, () => ({ ok: true, history: readHistory() }))

  ctx.ipcMain.handle(`${ID}:x-trending`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const windowId = typeof r.window === 'string' ? r.window : '24h'
    const force = r.force === true
    const bearer = ctx.getApiKey('x')
    if (!bearer) return { ok: false, error: 'Add your X (Twitter) Bearer Token in Settings → API Keys to see trending tickers.' }

    const scanSize = getScanSize()
    const maxPages = Math.max(1, Math.min(5, Math.round(scanSize / 100)))
    const cacheKey = `${windowId}|${scanSize}`
    const cached = xCache.get(cacheKey)
    if (!force && cached && Date.now() - cached.at < X_TTL_MS) return { ...cached.payload, history: readHistory() }

    try {
      const now = Date.now()
      const res = await fetchTrending(bearer, windowId, now, maxPages)
      if (!res.ok && res.tweets.length === 0)
        return { ok: false, error: res.error ?? 'X request failed.', archiveNeeded: res.archiveNeeded === true }

      // AI tone read (default on): ONE cheap batched call classifies every post's
      // tone; falls back to the keyword lexicon on any failure or when off.
      let tones: Tone[] | undefined
      let toneBy = 'keywords'
      if (getAiTone() && hasAiKey() && res.tweets.length > 0) {
        try {
          const toneRes = await callAi(
            aiKeys(),
            [{ role: 'user', text: buildTonePrompt(res.tweets.map((t) => t.text)) }],
            { json: true, tier: 'lite' }
          )
          if (toneRes.ok) {
            tones = parseTones(toneRes.text, res.tweets.length)
            toneBy = `AI (${toneRes.provider})`
          }
        } catch {
          /* fall back to lexicon */
        }
      }
      const tallies = tallyMentions(res.tweets, tones)

      // Validate + enrich against the live market snapshot: drops junk cashtags
      // ($ROPE, $$$) and attaches price/change/volume for the rating.
      const massiveKey = ctx.getApiKey('massive')
      const quoteByTicker = new Map<string, { price: number | null; changePct: number | null; volume: number | null }>()
      if (massiveKey) {
        try {
          const snap = await getFullSnapshot(massiveKey)
          for (const row of snap) {
            const q = resolveQuote(row, row.prevDay ?? null)
            quoteByTicker.set(row.ticker, { price: q.price, changePct: q.changePct, volume: q.volume })
          }
        } catch {
          /* leave market data empty; rating falls back to buzz + sentiment */
        }
      }
      const haveMarket = quoteByTicker.size > 0
      const validated = haveMarket ? tallies.filter((t) => quoteByTicker.has(t.ticker)) : tallies
      const top = validated.slice(0, 20)
      const maxMentions = top.length > 0 ? top[0].mentions : 0

      const rows: TrendRow[] = top.map((t) => {
        const q = quoteByTicker.get(t.ticker)
        const rating = rateTicker({ mentions: t.mentions, maxMentions, changePct: q?.changePct ?? null, sentiment: t.sentiment })
        const growth = gradeGrowth(t.growthScore, t.mentions)
        return {
          ticker: t.ticker,
          name: '',
          mentions: t.mentions,
          engagement: t.engagement,
          positive: t.positive,
          hopeful: t.hopeful,
          negative: t.negative,
          neutral: t.neutral,
          sentiment: t.sentiment,
          velocity: t.velocity,
          accel: t.accel,
          growthScore: t.growthScore,
          growthPct: growth.pct,
          growthGrade: growth.grade,
          growthLabel: growth.label,
          growthConfidence: growth.confidence,
          price: q?.price ?? null,
          changePct: q?.changePct ?? null,
          volume: q?.volume ?? null,
          score: rating.score,
          label: rating.label
        }
      })

      const record: ScanRecord = {
        id: `${now}-${windowId}-${scanSize}`,
        window: windowId,
        scanSize,
        generatedAt: now,
        sampled: res.tweets.length,
        endpoint: res.endpoint,
        marketValidated: haveMarket,
        note: res.error ?? '',
        toneBy,
        rows
      }
      const history = [record, ...readHistory().filter((h) => h.id !== record.id)].slice(0, HISTORY_CAP)
      ctx.storeSet(HISTORY_KEY, history)

      const payload: Record<string, unknown> = {
        ok: true,
        id: record.id,
        window: windowId,
        scanSize,
        rows,
        sampled: res.tweets.length,
        endpoint: res.endpoint,
        marketValidated: haveMarket,
        generatedAt: now,
        note: res.error ?? '',
        toneBy,
        cached: false
      }
      xCache.set(cacheKey, { at: now, payload: { ...payload, cached: true } })
      return { ...payload, history }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // Exact per-bucket mention history for ONE ticker (counts endpoint — cheap,
  // separate quota). Cached per ticker+window.
  const xCountsCache = new Map<string, { at: number; payload: Record<string, unknown> }>()

  ctx.ipcMain.handle(`${ID}:x-mentions`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ticker = String(r.ticker ?? '').trim().toUpperCase().replace(/^\$/, '')
    const windowId = typeof r.window === 'string' ? r.window : '24h'
    const force = r.force === true
    if (!validTicker(ticker)) return { ok: false, error: 'Enter a valid ticker symbol (1–6 letters).' }
    const bearer = ctx.getApiKey('x')
    if (!bearer) return { ok: false, error: 'Add your X (Twitter) Bearer Token in Settings → API Keys.' }

    const cacheKey = `${ticker}|${windowId}`
    const cached = xCountsCache.get(cacheKey)
    if (!force && cached && Date.now() - cached.at < X_TTL_MS) return cached.payload

    try {
      const now = Date.now()
      const res = await fetchMentionCounts(bearer, ticker, windowId, now)
      if (!res.ok && res.buckets.length === 0)
        return { ok: false, error: res.error ?? 'X request failed.', archiveNeeded: res.archiveNeeded === true }
      const payload: Record<string, unknown> = {
        ok: true,
        ticker,
        window: windowId,
        buckets: res.buckets.map((b) => ({ start: b.start, count: b.count })),
        total: res.total,
        granularity: res.granularity,
        endpoint: res.endpoint,
        generatedAt: now,
        note: res.error ?? '',
        cached: false
      }
      xCountsCache.set(cacheKey, { at: now, payload: { ...payload, cached: true } })
      return payload
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /**
   * Deterministic screen (no AI) — the primitive the agent and the MCP tool
   * both use. Given an explicit ScreenPlan-ish object, returns ranked matches.
   */
  const runScreen = async (plan: ScreenPlan): Promise<{ candidates: Candidate[]; note: string }> => {
    const massiveKey = ctx.getApiKey('massive')
    if (!massiveKey) throw new Error('Add your Massive / Polygon key in Settings → API Keys for market data.')
    const finnhubKey = ctx.getApiKey('finnhub')
    const { rows, note } = await buildUniverse(massiveKey, plan)
    const numeric = rankRows(applyNumericFilters(rows, plan), plan).slice(0, PRE_ENRICH_CAP)
    // Always enrich the top survivors with details + Tier 1 technical signals +
    // a Trade Score (the accuracy layer); news is fetched only when the plan
    // needs it. Then attach Tier 3 smart-money extras (top-N, Finnhub), apply
    // all filters, and rank by score.
    const enriched = await enrich(massiveKey, finnhubKey, numeric, plan)
    await enrichExtras(finnhubKey, massiveKey, enriched)
    const filtered = applyExtrasFilters(applySignalFilters(applyEnrichedFilters(enriched, plan), plan), plan)
    const final = [...filtered].sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0)).slice(0, plan.limit)
    return { candidates: final, note }
  }

  // The AI agent: chat history in → plan → screen → rank/explain → picks out.
  ctx.ipcMain.handle(`${ID}:search`, async (_e, raw: unknown) => {
    const req = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const history = (Array.isArray(req.history) ? req.history : []).filter(
      (m): m is ChatMsg => !!m && typeof (m as ChatMsg).text === 'string'
    )
    const last = history[history.length - 1]
    if (!last || last.role !== 'user' || !last.text.trim()) return { ok: false, error: 'Ask what you want to find.' }
    if (!ctx.getApiKey('massive')) return { ok: false, error: 'Add your Massive / Polygon key in Settings → API Keys for market data.' }

    try {
      // 1) criteria → ScreenPlan
      const planMsgs: AiMessage[] = [
        { role: 'system', text: PLAN_RULES },
        ...history.slice(-6).map((m) => ({ role: m.role, text: m.text })),
        { role: 'user', text: 'Return the JSON screen plan for my latest request.' }
      ]
      // Plan parsing is mechanical structured extraction — cheap/fast tier.
      const planRes = await callAi(aiKeys(), planMsgs, { json: true, tier: 'lite' })
      if (!planRes.ok) return { ok: false, error: planRes.error }
      const plan = parseScreenPlan(planRes.text)

      // 2) run the deterministic screen
      const { candidates, note } = await runScreen(plan)
      if (candidates.length === 0) {
        return { ok: true, plan, provider: planRes.provider, summary: `No matches — ${note}. Try loosening the criteria.`, picks: [] as Pick[] }
      }

      // 3) rank + explain
      const rankRes = await callAi(
        aiKeys(),
        [
          { role: 'system', text: 'You are a sharp trading scout. Be concise, specific, honest; educational only, never financial advice.' },
          { role: 'user', text: rankPrompt(plan, candidates) }
        ],
        // The reasoning/thesis step is quality-critical — strong tier.
        { json: true, tier: 'pro' }
      )
      const ranked = rankRes.ok ? parseRank(rankRes.text) : { summary: '', picks: [] }

      // 4) join the AI's thesis back onto the real candidate data (data is the
      //    source of truth; the AI only annotates)
      const byTicker = new Map(candidates.map((c) => [c.ticker, c]))
      const ordered = ranked.picks.length > 0 ? ranked.picks.map((p) => p.ticker).filter((t) => byTicker.has(t)) : candidates.map((c) => c.ticker)
      const seen = new Set<string>()
      const picks: Pick[] = []
      for (const tk of ordered) {
        if (seen.has(tk)) continue
        seen.add(tk)
        const c = byTicker.get(tk)
        if (!c) continue
        const ai = ranked.picks.find((p) => p.ticker === tk)
        picks.push(toPick(c, ai?.thesis ?? '', ai?.flags ?? []))
      }

      return {
        ok: true,
        plan,
        provider: planRes.provider,
        summary: ranked.summary || `Found ${picks.length} match(es) — ${note}.`,
        picks
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // Read-only deterministic screen for the MCP tool (explicit numeric params).
  ctx.ipcMain.handle(`${ID}:screen`, async (_e, raw: unknown) => {
    try {
      const plan = parseScreenPlan(JSON.stringify(raw ?? {}))
      const { candidates, note } = await runScreen(plan)
      return {
        ok: true,
        note,
        rows: candidates.map((c) => ({
          ticker: c.ticker,
          name: c.name ?? '',
          price: c.price,
          changePct: c.changePct,
          volume: c.volume,
          sector: c.sector ?? '',
          marketCap: c.marketCap ?? null,
          score: c.score?.score ?? null,
          scoreLabel: c.score?.label ?? '',
          reasons: c.score?.reasons ?? [],
          rvol: c.signals?.rvol ?? null,
          gapPct: c.signals?.gapPct ?? null,
          atrPct: c.signals?.atrPct ?? null,
          pctFrom52High: c.signals?.pctFrom52High ?? null,
          rsi14: c.signals?.rsi14 ?? null,
          trendUp: c.signals?.trendUp ?? false,
          setup: c.setup ?? 'Mover',
          catalyst: c.catalyst ?? null,
          plan: c.plan ?? null,
          analystBull: c.extras?.analystBull ?? null,
          analystLabel: c.extras?.analystLabel ?? null,
          insiderBuying: c.extras?.insiderBuying ?? false,
          shortPctFloat: c.extras?.shortPctFloat ?? null,
          daysToEarnings: c.daysToEarnings ?? null,
          secOffering: c.edgar?.recentOffering ?? false,
          stBullPct:
            c.stocktwits && c.stocktwits.bullish + c.stocktwits.bearish > 0
              ? Math.round((c.stocktwits.bullish / (c.stocktwits.bullish + c.stocktwits.bearish)) * 100)
              : null,
          newsCount24h: c.newsCount24h ?? null,
          newsHot: c.newsHot ?? false
        }))
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // One-click deterministic scanner presets (no AI cost).
  ctx.ipcMain.handle(`${ID}:presets`, () => ({ ok: true, presets: PRESETS.map((p) => ({ id: p.id, name: p.name, desc: p.desc })) }))

  ctx.ipcMain.handle(`${ID}:preset`, async (_e, rawId: unknown) => {
    const id = typeof rawId === 'string' ? rawId : ''
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return { ok: false, error: 'Unknown preset.' }
    if (!ctx.getApiKey('massive')) return { ok: false, error: 'Add your Massive / Polygon key in Settings → API Keys for market data.' }
    try {
      const plan = parseScreenPlan(JSON.stringify(preset.plan))
      const { candidates, note } = await runScreen(plan)
      return { ok: true, name: preset.name, note, picks: candidates.map((c) => toPick(c)) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ---------------------------- watchlist + alerts ---------------------- */

  const WATCH_KEY = `${ID}.watchlist`
  const MONITOR_KEY = `${ID}.monitorEnabled`
  const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000
  const MONITOR_INTERVAL_MS = 120_000
  const asObj = (raw: unknown): Record<string, unknown> => (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const readWatch = (): WatchItem[] =>
    (ctx.storeGet<unknown[]>(WATCH_KEY, []) || []).map(normalizeItem).filter((x): x is WatchItem => x !== null)
  const writeWatch = (items: WatchItem[]): void => ctx.storeSet(WATCH_KEY, items)
  const getMonitor = (): boolean => ctx.storeGet<boolean>(MONITOR_KEY, true) !== false

  ctx.ipcMain.handle(`${ID}:watch-list`, () => ({ ok: true, items: readWatch(), monitor: getMonitor() }))

  ctx.ipcMain.handle(`${ID}:watch-add`, (_e, raw) => {
    const r = asObj(raw)
    const ticker = String(r.ticker ?? '').trim().toUpperCase().replace(/^\$/, '')
    if (!validTicker(ticker)) return { ok: false, error: 'Enter a valid ticker (1–6 letters).' }
    const items = readWatch()
    const existing = items.find((i) => i.ticker === ticker)
    if (existing) {
      if (r.alerts) existing.alerts = normalizeItem({ ticker, alerts: r.alerts })?.alerts ?? existing.alerts
    } else {
      items.unshift({ ticker, addedAt: Date.now(), alerts: r.alerts ? normalizeItem({ ticker, alerts: r.alerts })?.alerts ?? emptyAlerts() : emptyAlerts(), lastFired: {} })
    }
    writeWatch(items)
    return { ok: true, items }
  })

  ctx.ipcMain.handle(`${ID}:watch-remove`, (_e, raw) => {
    const ticker = String(asObj(raw).ticker ?? '').trim().toUpperCase()
    const items = readWatch().filter((i) => i.ticker !== ticker)
    writeWatch(items)
    return { ok: true, items }
  })

  ctx.ipcMain.handle(`${ID}:watch-update`, (_e, raw) => {
    const r = asObj(raw)
    const ticker = String(r.ticker ?? '').trim().toUpperCase()
    const items = readWatch()
    const it = items.find((i) => i.ticker === ticker)
    if (!it) return { ok: false, error: 'Not on the watchlist.' }
    it.alerts = normalizeItem({ ticker, alerts: r.alerts })?.alerts ?? it.alerts
    it.lastFired = {} // new thresholds should be free to fire
    writeWatch(items)
    return { ok: true, items }
  })

  ctx.ipcMain.handle(`${ID}:watch-clear`, () => {
    writeWatch([])
    return { ok: true, items: [] }
  })

  ctx.ipcMain.handle(`${ID}:monitor-set`, (_e, raw) => {
    const on = asObj(raw).on
    if (typeof on === 'boolean') ctx.storeSet(MONITOR_KEY, on)
    return { ok: true, monitor: getMonitor() }
  })

  // Background monitor: every 2 min while enabled + market not fully closed,
  // fetch quotes for watched tickers, fire NEW alerts (edge-triggered, 4h
  // anti-flap cooldown) as a system notification + an in-app event.
  let checking = false
  const checkAlerts = async (): Promise<void> => {
    if (checking || !getMonitor()) return
    const withAlerts = readWatch().filter((i) => hasAnyAlert(i.alerts))
    if (withAlerts.length === 0) return
    const massiveKey = ctx.getApiKey('massive')
    if (!massiveKey || marketSession() === 'closed') return
    checking = true
    try {
      const snap = await getFullSnapshot(massiveKey)
      const byT = new Map(snap.map((r) => [r.ticker, r]))
      const now = Date.now()
      const all = readWatch()
      let changed = false
      const fired: { ticker: string; condition: string; message: string; at: number }[] = []
      for (const item of all) {
        if (!hasAnyAlert(item.alerts)) continue
        const row = byT.get(item.ticker)
        if (!row) continue
        const q = resolveQuote(row, row.prevDay ?? null)
        let rvol: number | null = null
        let pct52: number | null = null
        if (item.alerts.rvolAbove != null || item.alerts.nearHigh) {
          try {
            const bars = await dailyBars(massiveKey, item.ticker)
            const sig = computeSignals(bars, {
              price: q.price,
              todayVolume: q.volume,
              dayOpen: typeof row.day?.o === 'number' ? row.day.o : null,
              prevClose: typeof row.prevDay?.c === 'number' ? row.prevDay.c : null
            })
            rvol = sig.rvol
            pct52 = sig.pctFrom52High
          } catch {
            /* signal-based conditions just won't fire this tick */
          }
        }
        const current = evalAlerts(item, { price: q.price, changePct: q.changePct, rvol, pctFrom52High: pct52 })
        for (const c of pickNewlyFired(current, item.lastFired, now, ALERT_COOLDOWN_MS)) {
          item.lastFired[c.condition] = now
          fired.push({ ticker: item.ticker, condition: c.condition, message: c.message, at: now })
          changed = true
        }
        const trueKeys = new Set(current.map((c) => c.condition))
        for (const k of Object.keys(item.lastFired)) {
          if (!trueKeys.has(k)) {
            delete item.lastFired[k]
            changed = true
          }
        }
      }
      if (changed) writeWatch(all)
      if (fired.length > 0) {
        try {
          if (Notification.isSupported()) {
            const title = fired.length === 1 ? `📈 ${fired[0].ticker} alert` : `📈 ${fired.length} watchlist alerts`
            const n = new Notification({ title, body: fired.slice(0, 5).map((f) => f.message).join('\n') })
            n.on('click', () => {
              const w = ctx.getMainWindow()
              if (w) {
                if (w.isMinimized()) w.restore()
                w.focus()
              }
            })
            n.show()
          }
        } catch {
          /* notifications not available */
        }
        ctx.getMainWindow()?.webContents.send(`${ID}:alerts`, fired)
      }
    } catch {
      /* transient — try again next tick */
    } finally {
      checking = false
    }
  }
  setInterval(() => void checkAlerts(), MONITOR_INTERVAL_MS)
}

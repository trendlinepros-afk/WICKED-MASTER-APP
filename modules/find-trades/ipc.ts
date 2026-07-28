import type { ModuleIpcContext } from '../../src/main/module-ipc'
import { callAi, type AiKeys, type AiMessage } from '../stock-planner/ipc/ai'
import { marketSession } from '../stock-planner/ipc/market/sessions'
import { resolveQuote } from '../stock-planner/ipc/market/quotes'
import {
  getFullSnapshot,
  getTickerDetails,
  getIpos,
  getMassiveNews,
  type FullSnapshotRow
} from '../stock-planner/ipc/market/massive'
import { preMarketGainers, afterHoursGainers } from '../stock-planner/ipc/market/screeners'
import { getCompanyNews } from '../stock-planner/ipc/market/finnhub'
import { classifySector } from '../trade-analytics/lib/sector'
import {
  applyEnrichedFilters,
  applyNumericFilters,
  parseScreenPlan,
  rankRows,
  type Candidate,
  type ScreenPlan
} from './lib/plan'
import { fetchMentionCounts, fetchTrending, gradeGrowth, rateTicker, tallyMentions, validTicker } from './ipc/x'

/* ------------------------------------------------------------------------ *
 *  FIND TRADES — an AI screener agent. A plain-English request is turned into
 *  a ScreenPlan (AI, JSON), executed against the live market snapshot + news
 *  (deterministic filtering), then the surviving candidates are ranked and
 *  explained by the AI. Market keys (massive/finnhub) and AI keys come from
 *  the shell vault; nothing is auto-used on the MCP path (see mcp.ts).
 * ------------------------------------------------------------------------ */

const ID = 'find-trades'
const PRE_ENRICH_CAP = 60 // numeric survivors carried into (rate-limited) enrichment
const ENRICH_CAP = 18 // how many we fetch sector/news for

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
  rows: TrendRow[]
}

const fmtCap = (v: number | null): string =>
  v == null ? 'n/a' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v.toFixed(0)}`

/* --------------------------- candidate universe -------------------------- */

/** Resolve a snapshot row to the numbers the screen needs. */
function rowToCandidate(r: FullSnapshotRow): Candidate {
  const q = resolveQuote(r, r.prevDay ?? null)
  return { ticker: r.ticker, price: q.price, changePct: q.changePct, volume: q.volume }
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
      }
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
  'Put news/theme words (FDA, earnings, AI, buyout, guidance) in keywords. Keep limit <= 20. rationale = one sentence.'

function rankPrompt(plan: ScreenPlan, cands: Candidate[]): string {
  const lines = cands.map(
    (c) =>
      `${c.ticker} | ${c.name ?? ''} | price ${c.price ?? 'n/a'} | chg ${c.changePct?.toFixed(2) ?? 'n/a'}% | vol ${c.volume ?? 'n/a'} | ${c.sector ?? '?'} | cap ${fmtCap(c.marketCap ?? null)}` +
      (c.news && c.news.length ? ` | news: ${c.news.slice(0, 2).map((n) => n.title).join(' /// ')}` : '')
  )
  return (
    `The trader asked for: "${plan.rationale}". Here are the pre-filtered candidates (live data):\n\n${lines.join('\n')}\n\n` +
    'Pick the best matches (fewer, higher-quality is better) and return ONLY JSON: ' +
    '{"summary":"1-2 sentences on what you found","picks":[{"ticker":"","thesis":"one line why it fits","flags":["short risk/quality notes"]}]}. ' +
    'Base every claim on the data shown — do not invent prices or news. Educational only, not financial advice.'
  )
}

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
  const HISTORY_CAP = 20
  const xCache = new Map<string, { at: number; payload: Record<string, unknown> }>()
  const X_TTL_MS = 30 * 60 * 1000

  const clampScanSize = (n: number): number => (n === 200 ? 200 : n === 300 ? 300 : 100)
  const getScanSize = (): number => clampScanSize(Number(ctx.storeGet<number>(SCAN_KEY, 100)))
  const readHistory = (): ScanRecord[] => {
    const v = ctx.storeGet<ScanRecord[]>(HISTORY_KEY, [])
    return Array.isArray(v) ? v : []
  }

  ctx.ipcMain.handle(`${ID}:x-status`, () => ({
    ok: true,
    hasX: !!ctx.getApiKey('x'),
    hasMassive: !!ctx.getApiKey('massive'),
    scanSize: getScanSize()
  }))

  ctx.ipcMain.handle(`${ID}:x-set-scan-size`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const size = clampScanSize(Number(r.size))
    ctx.storeSet(SCAN_KEY, size)
    return { ok: true, scanSize: size }
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

      const tallies = tallyMentions(res.tweets)

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
    const needsEnrich =
      plan.sectors.length > 0 || plan.needsNews || plan.keywords.length > 0 || plan.minMarketCap != null || plan.maxMarketCap != null
    const enriched = needsEnrich ? await enrich(massiveKey, finnhubKey, numeric, plan) : numeric.slice(0, ENRICH_CAP)
    const final = (needsEnrich ? applyEnrichedFilters(enriched, plan) : enriched).slice(0, plan.limit)
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
        picks.push({
          ticker: c.ticker,
          name: c.name ?? '',
          price: c.price,
          changePct: c.changePct,
          volume: c.volume,
          sector: c.sector ?? '—',
          marketCap: c.marketCap ?? null,
          thesis: ai?.thesis ?? '',
          flags: ai?.flags ?? [],
          news: c.news ?? []
        })
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
          marketCap: c.marketCap ?? null
        }))
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })
}

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
    session: marketSession()
  }))

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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { clipboard } from 'electron'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { callAi, type AiKeys, type AiMessage } from './ipc/ai'
import { extractTickersWithFallback, mentionsIpos } from './ipc/chatContext'
import { DocStore, type StockDoc } from './ipc/docs'
import { parseReportSpec, type ReportSpec } from './ipc/report'
import { getAggregates, getIpos, searchTickers } from './ipc/market/massive'
import { getEarningsHistory } from './ipc/market/finnhub'
import { computeTechnicals, type Technicals } from './ipc/market/technicals'
import { marketSession } from './ipc/market/sessions'
import { getTickerData, type MarketKeys, type TickerData } from './ipc/market/tickerdata'
import { afterHoursGainers, dailyGainers, periodGainers, preMarketGainers } from './ipc/market/screeners'

/* ------------------------------------------------------------------------ *
 *  STOCK PLANNER — main process. Ported from wickeddash: guided research
 *  flow (find -> AI report -> trendline screenshots -> summary/PDF),
 *  screeners, IPO finder, compare, and the context-injected AI assistant.
 *  Market keys come from the shell vault (massive / finnhub); AI keys from
 *  the vault via the shared AUTO cascade. Everything fails soft.
 * ------------------------------------------------------------------------ */

const ID = 'stock-planner'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const fmtMoney = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return 'n/a'
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  return a >= 1e12
    ? `${sign}$${(a / 1e12).toFixed(2)}T`
    : a >= 1e9
      ? `${sign}$${(a / 1e9).toFixed(2)}B`
      : a >= 1e6
        ? `${sign}$${(a / 1e6).toFixed(1)}M`
        : `${sign}$${a.toFixed(2)}`
}

/** App-computed stat cards for the report — deterministic real data, so P/E
 *  (negative on a loss), net margin and price/sales are always correct rather
 *  than left to the model to (mis)compute. */
function buildStats(td: TickerData): { label: string; value: string }[] {
  const q = td.quote
  const cap = td.details?.marketCap ?? null
  const a = td.analyst
  const pt = td.priceTarget
  const ptStr = pt && pt.mean != null ? ` · PT $${pt.mean.toFixed(2)}` : ''
  const analystValue = a
    ? `${a.label} · ${a.strongBuy + a.buy}B / ${a.hold}H / ${a.sell + a.strongSell}S${ptStr}`
    : pt && pt.mean != null
      ? `PT $${pt.mean.toFixed(2)}${pt.num ? ` (${pt.num} analysts)` : ''}`
      : 'n/a'
  const range =
    td.week52Low !== null && td.week52High !== null ? `$${td.week52Low.toFixed(2)} – $${td.week52High.toFixed(2)}` : 'n/a'
  return [
    {
      label: 'Price',
      value:
        q.price !== null
          ? `$${q.price.toFixed(2)}${q.changePct !== null ? ` (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today)` : ''}`
          : 'n/a'
    },
    { label: 'Market cap', value: fmtMoney(cap) },
    { label: 'P/E', value: td.pe !== null ? td.pe.toFixed(1) : 'n/a' },
    { label: 'Annual revenue', value: fmtMoney(td.revenue) },
    { label: 'Dividend yield', value: td.dividendYield != null && td.dividendYield > 0 ? `${(td.dividendYield * 100).toFixed(2)}%` : 'None' },
    { label: 'Analyst research', value: analystValue },
    { label: '52-week range', value: range },
    { label: 'Sector', value: td.sector ? td.sector.split(' (')[0].trim().slice(0, 42) : 'n/a' },
    {
      label: 'Next earnings',
      value: td.earnings ? `${td.earnings.date} (${td.earnings.isEstimate ? 'est.' : 'confirmed'})` : 'n/a'
    }
  ].slice(0, 12)
}

/** Full technical picture (MAs, RSI, trend, 52-wk position, volume, ATR, S/R)
 *  from ~2 years of daily bars — one Polygon call. null when history is thin. */
async function fetchTechnicals(key: string, sym: string): Promise<Technicals | null> {
  try {
    const to = Date.now()
    const bars = await getAggregates(key, sym, 1, 'day', to - 740 * 86_400_000, to)
    return computeTechnicals(bars)
  } catch {
    return null
  }
}

const pctStr = (v: number | null): string => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(v <= -1 || v >= 1 ? 1 : 2)}%`)
const usd = (v: number | null): string => (v == null ? 'n/a' : `$${v.toFixed(2)}`)

/** The TECHNICALS block injected into the report prompt. */
function technicalsBlock(t: Technicals): string {
  const lines: string[] = ['TECHNICALS (computed from ~2y of daily bars — USE THESE; do NOT say technicals were not provided):']
  lines.push(`  Trend: ${t.trend}.${t.maRegime ? ` ${t.maRegime}.` : ''}`)
  const mas: string[] = []
  if (t.sma20 != null) mas.push(`20-DMA ${usd(t.sma20)}`)
  if (t.sma50 != null) mas.push(`50-DMA ${usd(t.sma50)}`)
  if (t.sma200 != null) mas.push(`200-DMA ${usd(t.sma200)}`)
  if (mas.length) {
    const rel: string[] = []
    if (t.priceVsSma50Pct != null) rel.push(`${pctStr(t.priceVsSma50Pct)} vs its 50-DMA`)
    if (t.priceVsSma200Pct != null) rel.push(`${pctStr(t.priceVsSma200Pct)} vs its 200-DMA`)
    lines.push(`  Moving averages: ${mas.join(', ')}${rel.length ? ` — price is ${rel.join(' and ')}` : ''}.`)
  }
  if (t.rsi14 != null)
    lines.push(`  RSI(14): ${t.rsi14} (${t.rsi14 >= 70 ? 'overbought' : t.rsi14 <= 30 ? 'oversold' : 'neutral'}).`)
  lines.push(
    `  Returns: 1W ${pctStr(t.weeklyChange)}, 1M ${pctStr(t.ret1m)}, 3M ${pctStr(t.ret3m)}, 6M ${pctStr(t.ret6m)}, 1Y ${pctStr(t.ret1y)}.`
  )
  if (t.high52 != null && t.low52 != null)
    lines.push(
      `  52-week range ${usd(t.low52)}–${usd(t.high52)}; price sits at ${t.pctOfRange ?? 'n/a'}% of the range${t.pctFromHigh != null ? ` (${pctStr(t.pctFromHigh)} from the 52-wk high)` : ''}.`
    )
  if (t.recentLow != null && t.recentHigh != null)
    lines.push(`  Recent ~1-month support ≈ ${usd(t.recentLow)}, resistance ≈ ${usd(t.recentHigh)}.`)
  if (t.volTrendPct != null)
    lines.push(
      `  Volume trend: recent 10-day average is ${pctStr(t.volTrendPct)} vs its ~50-day average${t.avgVol20 != null ? ` (20-day avg ${t.avgVol20.toLocaleString('en-US')} sh)` : ''}.`
    )
  if (t.atrPct != null) lines.push(`  Volatility: ATR(14) ≈ ${t.atrPct}% of price.`)
  return lines.join('\n')
}

/** Live-data summary block injected into report + chat prompts. */
function summaryBlock(td: TickerData, tech?: Technicals | null): string {
  const weeklyPct = tech?.weeklyChange ?? null
  const q = td.quote
  const cap = td.details?.marketCap ?? null
  // Prefer Yahoo's TTM net margin; fall back to (annual net income / annual revenue).
  const margin =
    td.netMarginTTM != null
      ? td.netMarginTTM * 100
      : td.revenue && td.revenue !== 0 && td.netIncome !== null
        ? (td.netIncome / td.revenue) * 100
        : null
  const ps = cap && cap > 0 && td.revenue && td.revenue > 0 ? cap / td.revenue : null
  const action = (a: string): string =>
    a === 'up' ? 'upgraded to' : a === 'down' ? 'downgraded to' : a === 'init' ? 'initiated at' : 'rated'
  const lines = [
    `${td.symbol} — ${td.details?.name ?? 'Unknown company'}`,
    `Price: ${q.price !== null ? `$${q.price.toFixed(2)}` : 'not available'}` +
      (q.changePct !== null ? ` (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today)` : ''),
    weeklyPct != null
      ? `Weekly price change (last ~5 trading days): ${weeklyPct >= 0 ? '+' : ''}${weeklyPct.toFixed(2)}%`
      : 'Weekly price change: not available',
    `Market cap: ${fmtMoney(cap)}`,
    td.pe !== null
      ? `P/E: ${td.pe.toFixed(1)}${td.pe < 0 ? ' (negative — reflects a net loss)' : ''}`
      : 'P/E: not available',
    `Sector: ${td.sector || 'n/a'}`,
    `52-week range: ${td.week52Low !== null && td.week52High !== null ? `$${td.week52Low.toFixed(2)} – $${td.week52High.toFixed(2)}` : 'not available'}`,
    td.analyst
      ? `Analyst consensus: ${td.analyst.label} (${td.analyst.strongBuy + td.analyst.buy} buy / ${td.analyst.hold} hold / ${td.analyst.sell + td.analyst.strongSell} sell, ${td.analyst.total} analysts)`
      : 'Analyst consensus: not available',
    td.priceTarget && td.priceTarget.mean != null
      ? `Analyst price target: $${td.priceTarget.mean.toFixed(2)}${td.priceTarget.low != null && td.priceTarget.high != null ? ` (range $${td.priceTarget.low.toFixed(2)}–$${td.priceTarget.high.toFixed(2)})` : ''}${td.priceTarget.num ? `, ${td.priceTarget.num} analysts` : ''}`
      : 'Analyst price target: not available',
    td.ratingActions.length > 0
      ? 'Recent analyst actions:\n' +
        td.ratingActions.slice(0, 4).map((a) => `  - ${a.date}: ${a.firm} ${action(a.action)} ${a.toGrade}`).join('\n')
      : 'Recent analyst actions: none available',
    `Annual revenue: ${fmtMoney(td.revenue)} · Net income: ${fmtMoney(td.netIncome)}`,
    `Net margin: ${margin !== null ? `${margin.toFixed(1)}%` : 'n/a'} · Price/Sales: ${ps !== null ? `${ps.toFixed(2)}x` : 'n/a'}`,
    `Dividend yield: ${td.dividendYield != null && td.dividendYield > 0 ? `${(td.dividendYield * 100).toFixed(2)}%` : 'none (non-dividend-payer)'}`,
    td.earnings
      ? `Next earnings: ${td.earnings.date} (${td.earnings.isEstimate ? 'estimated' : 'confirmed'}, via ${td.earnings.source})`
      : 'Next earnings: not available — do NOT guess an earnings date.',
    td.news.length > 0
      ? 'Recent headlines:\n' + td.news.slice(0, 3).map((n) => `  - ${n.title} (${n.source})`).join('\n')
      : 'Recent headlines: none available'
  ]
  if (tech) lines.push(technicalsBlock(tech))
  return lines.join('\n')
}

const REPORT_RULES =
  'Return ONLY a JSON object (no markdown fences, no prose) with this shape: ' +
  '{"title","subtitle","ticker","company","asOf","stats":[{"label","value"} up to 12],' +
  '"sections":[{"heading","body","bullets":[..up to 6]} 1..20],"disclaimer"}. ' +
  'Mandated sections in order: Overview, Financials, Technical setup, Pros, Cons. ' +
  'The live data includes a full TECHNICALS block (moving averages, RSI, trend, 52-week position, multi-period returns, recent support/resistance, volume trend, ATR volatility). ' +
  '"Technical setup" MUST use it: state the trend and moving-average structure, RSI (overbought/oversold/neutral), where price sits in its 52-week range, the recent support/resistance levels, and the volume/volatility read — and cite the WEEKLY change, not the daily. Do NOT claim technical data was unavailable. ' +
  'The live data also includes the analyst Buy/Hold/Sell consensus, the analyst price target, and recent per-firm rating actions — use them (consensus vs price target, notable upgrades/downgrades). ' +
  'Ground every claim in the provided live data; where data is missing say so — never invent numbers, ' +
  'prices or earnings dates. A net loss produces a NEGATIVE P/E — report the negative value, do not call it N/A. ' +
  'The app fills the stat cards itself, so focus your effort on the section prose. ' +
  'End with a short educational disclaimer (not financial advice).'

export default function register(ctx: ModuleIpcContext): void {
  const docs = new DocStore(join(ctx.app.getPath('userData'), 'modules', ID, 'docs'))
  let aiBusy = false

  const marketKeys = (): MarketKeys => ({
    massive: ctx.getApiKey('massive'),
    finnhub: ctx.getApiKey('finnhub')
  })
  const aiKeys = (): AiKeys => ({
    anthropic: ctx.getApiKey('anthropic'),
    gemini: ctx.getApiKey('gemini'),
    deepseek: ctx.getApiKey('deepseek'),
    openai: ctx.getApiKey('openai')
  })
  const geminiModel = (): string | undefined => {
    const v = ctx.storeGet<string>(`${ID}.reportModel`, '')
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }

  /* ------------------------------ market data ---------------------------- */

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    hasMassive: !!ctx.getApiKey('massive'),
    hasFinnhub: !!ctx.getApiKey('finnhub'),
    hasAi: !!(ctx.getApiKey('anthropic') || ctx.getApiKey('gemini') || ctx.getApiKey('deepseek') || ctx.getApiKey('openai')),
    session: marketSession()
  }))

  ctx.ipcMain.handle(`${ID}:search`, async (_e, rawQ: unknown) => {
    const q = typeof rawQ === 'string' ? rawQ.trim() : ''
    if (!q) return { ok: true, hits: [] }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys first.' }
    return { ok: true, hits: await searchTickers(key, q) }
  })

  ctx.ipcMain.handle(`${ID}:ticker-data`, async (_e, rawSym: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker symbol is required.' }
    try {
      return { ok: true, data: await getTickerData(marketKeys(), sym, true) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:screener`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys first.' }
    const kind = String(r.kind ?? 'daily')
    try {
      // ScreenerResult already carries ok + reason; a session-gated screener
      // returns ok:false with the human-readable reason.
      if (kind === 'premarket') return await preMarketGainers(key)
      if (kind === 'afterhours') return await afterHoursGainers(key)
      if (kind === 'period') {
        const days = Number(r.days)
        const valid = days === 7 || days === 30 || days === 182 || days === 365
        return await periodGainers(key, valid ? (days as 7) : 7)
      }
      return await dailyGainers(key)
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:ipos`, async () => {
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys first.' }
    return { ok: true, rows: await getIpos(key) }
  })

  // Compare up to 6 tickers side by side. The web app fired all requests at
  // once; keep a small sequential batch instead so rate-limited plans survive.
  ctx.ipcMain.handle(`${ID}:compare`, async (_e, rawSyms: unknown) => {
    const syms = (Array.isArray(rawSyms) ? rawSyms : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => /^[A-Z.]{1,6}$/.test(s))
      .slice(0, 6)
    if (syms.length === 0) return { ok: false, error: 'Give me 1–6 ticker symbols.' }
    const rows: TickerData[] = []
    for (const s of syms) rows.push(await getTickerData(marketKeys(), s, false))
    return { ok: true, rows }
  })

  /* ------------------------------ docs / report --------------------------- */

  ctx.ipcMain.handle(`${ID}:doc-get`, (_e, rawSym: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker is required.' }
    return { ok: true, doc: docs.get(sym) }
  })

  ctx.ipcMain.handle(`${ID}:doc-list`, () => ({ ok: true, docs: docs.list() }))

  ctx.ipcMain.handle(`${ID}:add-images`, (_e, rawSym: unknown, rawImages: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker is required.' }
    const images = (Array.isArray(rawImages) ? rawImages : []).filter((i): i is string => typeof i === 'string')
    return { ok: true, doc: docs.addImages(sym, images) }
  })

  ctx.ipcMain.handle(`${ID}:remove-image`, (_e, rawSym: unknown, rawIndex: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker is required.' }
    return { ok: true, doc: docs.removeImage(sym, Number(rawIndex) || 0) }
  })

  /** Generate (or regenerate) the AI report card; trendlines=true adds vision. */
  async function generateReport(sym: string, withTrendlines: boolean): Promise<{ ok: boolean; doc?: StockDoc; error?: string }> {
    if (aiBusy) return { ok: false, error: 'An AI request is already running.' }
    aiBusy = true
    try {
      const mk = marketKeys()
      const [td, tech] = await Promise.all([
        getTickerData(mk, sym, true),
        mk.massive ? fetchTechnicals(mk.massive, sym) : Promise.resolve(null)
      ])
      const doc = docs.get(sym)
      if (td.details?.name) doc.company = td.details.name
      const images = withTrendlines ? doc.images : []
      if (withTrendlines && images.length === 0)
        return { ok: false, error: 'Add at least one chart screenshot first (Trendlines step).' }

      const messages: AiMessage[] = [
        { role: 'system', text: 'You are an equity research analyst writing a concise, data-grounded stock report card. ' + REPORT_RULES },
        {
          role: 'user',
          text:
            `Write the report for ${sym}.\n\nLIVE DATA (authoritative — use it, do not contradict it):\n${summaryBlock(td, tech)}\n\n` +
            (td.details?.description ? `Company description: ${td.details.description.slice(0, 1200)}\n\n` : '') +
            (withTrendlines
              ? 'The attached chart screenshots show the user\'s drawn trendlines. Add a "Trendline read" section analyzing support/resistance, the trend direction, and what price zones matter — referring to what is actually visible.'
              : ''),
          images
        }
      ]
      const res = await callAi(aiKeys(), messages, { json: true, tier: 'pro', geminiModel: geminiModel() })
      if (!res.ok) return { ok: false, error: res.error }
      const report: ReportSpec | null = parseReportSpec(res.text)
      if (!report) return { ok: false, error: 'The AI returned an unreadable report — try again.' }
      report.ticker = report.ticker || sym
      report.company = report.company || doc.company
      // App-computed stat cards (real data) override the model's — so P/E,
      // net margin and price/sales are correct, not hallucinated.
      report.stats = buildStats(td)

      // Real "Past Earnings" section — last 4 reported quarters, expected vs
      // reported EPS. Pulled from live data (never AI-guessed) and injected so it
      // shows in both the on-screen report and the exported PDF.
      try {
        const fk = marketKeys().finnhub
        if (fk && report.sections.length < 20) {
          const hist = (await getEarningsHistory(fk, sym, 4)).filter((h) => h.estimate != null || h.actual != null)
          if (hist.length > 0) {
            const eps = (v: number | null): string => (v == null ? 'n/a' : `$${v.toFixed(2)}`)
            const bullets = hist.map((h) => {
              const beat =
                h.estimate != null && h.actual != null
                  ? h.actual >= h.estimate
                    ? ` — beat by $${(h.actual - h.estimate).toFixed(2)}`
                    : ` — missed by $${(h.estimate - h.actual).toFixed(2)}`
                  : ''
              return `${h.period}: expected ${eps(h.estimate)} · reported ${eps(h.actual)}${beat}`
            })
            report.sections.push({
              heading: 'Past Earnings',
              body: 'Last reported quarters — analyst-expected vs actual EPS (live data, not AI-estimated):',
              bullets
            })
          }
        }
      } catch {
        /* earnings history is best-effort */
      }

      doc.report = report
      docs.save(doc)
      return { ok: true, doc }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    } finally {
      aiBusy = false
    }
  }

  ctx.ipcMain.handle(`${ID}:report`, async (_e, rawSym: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker is required.' }
    return generateReport(sym, false)
  })

  ctx.ipcMain.handle(`${ID}:trendlines`, async (_e, rawSym: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, error: 'A ticker is required.' }
    return generateReport(sym, true)
  })

  // Fresh, app-computed stat cards for a ticker (P/E, analyst, 52-week range, …).
  // The export refreshes these from live data so even an OLD cached report shows
  // the current cards, without re-running the (paid) AI generation.
  ctx.ipcMain.handle(`${ID}:report-stats`, async (_e, rawSym: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    if (!sym) return { ok: false, stats: [] }
    try {
      const td = await getTickerData(marketKeys(), sym, true)
      return { ok: true, stats: buildStats(td) }
    } catch (err) {
      return { ok: false, error: errMsg(err), stats: [] }
    }
  })

  // Daily closes for the report's fallback price chart (used when the user gave
  // no trendline screenshots). Defaults to ~2 years.
  ctx.ipcMain.handle(`${ID}:price-series`, async (_e, rawSym: unknown, rawDays: unknown) => {
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    const days = typeof rawDays === 'number' && rawDays > 0 ? Math.min(1500, Math.floor(rawDays)) : 730
    const key = marketKeys().massive
    if (!sym) return { ok: false, error: 'A ticker is required.', bars: [] }
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys.', bars: [] }
    try {
      const to = Date.now()
      const bars = await getAggregates(key, sym, 1, 'day', to - days * 86_400_000, to)
      return { ok: true, bars: bars.map((b) => ({ t: b.t, c: b.c })) }
    } catch (err) {
      return { ok: false, error: errMsg(err), bars: [] }
    }
  })

  /* --------------------------------- chat --------------------------------- */

  ctx.ipcMain.handle(`${ID}:chat`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = typeof r.ticker === 'string' ? r.ticker.trim().toUpperCase() : ''
    const message = typeof r.message === 'string' ? r.message.trim() : ''
    const images = (Array.isArray(r.images) ? r.images : []).filter(
      (i): i is string => typeof i === 'string' && i.startsWith('data:image/')
    ).slice(0, 4)
    if (!sym || !message) return { ok: false, error: 'A ticker and a message are required.' }
    if (aiBusy) return { ok: false, error: 'An AI request is already running.' }
    aiBusy = true
    try {
      const doc = images.length > 0 ? docs.addImages(sym, images) : docs.get(sym)

      // ---- context injection ----
      const context: string[] = []
      const docData = await getTickerData(marketKeys(), sym, true)
      context.push(`Current analysis ticker:\n${summaryBlock(docData)}`)
      const recent = doc.chat.slice(-6).map((c) => c.text)
      const mentioned = extractTickersWithFallback(message, `${sym} analysis`, recent).filter((t) => t !== sym)
      for (const t of mentioned.slice(0, 2)) {
        try {
          context.push(`Mentioned ticker:\n${summaryBlock(await getTickerData(marketKeys(), t, true))}`)
        } catch {
          /* fail-soft per ticker */
        }
      }
      if (mentionsIpos(message)) {
        const key = ctx.getApiKey('massive')
        if (key) {
          const ipos = (await getIpos(key)).slice(0, 15)
          context.push(
            'IPO calendar (authoritative — treat as the source of truth):\n' +
              ipos.map((i) => `  ${i.listingDate} ${i.ticker} ${i.name} [${i.status}]`).join('\n')
          )
        }
      }
      if (doc.report) {
        context.push(
          `Existing report for ${sym} (build on it, don't repeat it):\n` +
            doc.report.sections.map((s) => `${s.heading}: ${s.body.slice(0, 200)}`).join('\n')
        )
      }

      const history: AiMessage[] = doc.chat.slice(-24).map((c) => ({
        role: c.role,
        text: c.text
      }))
      const messages: AiMessage[] = [
        {
          role: 'system',
          text:
            'You are a sharp, honest stock-research assistant inside a trading workspace. Use ONLY the live data blocks provided for numbers — never invent prices, P/Es or earnings dates; say when something is not available. Be concise and practical. Educational only, not financial advice.\n\n' +
            context.join('\n\n')
        },
        ...history,
        { role: 'user', text: message, images }
      ]
      const res = await callAi(aiKeys(), messages, { tier: 'lite' })
      if (!res.ok) return { ok: false, error: res.error }
      doc.chat.push({ role: 'user', text: message, at: Date.now(), ...(images.length ? { images: images.length } : {}) })
      doc.chat.push({ role: 'assistant', text: res.text, at: Date.now() })
      docs.save(doc)
      return { ok: true, doc, provider: res.provider }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    } finally {
      aiBusy = false
    }
  })

  /* ------------------------------- PDF export ------------------------------ */

  // Export history: every saved PDF is remembered so the Find tab can list
  // previous analyses with "Go To File" / "Open PDF".
  interface HistoryEntry {
    ticker: string
    company: string
    file: string
    savedAt: number
  }
  const historyPath = join(ctx.app.getPath('userData'), 'modules', ID, 'history.json')
  const readHistory = (): HistoryEntry[] => {
    try {
      const arr = JSON.parse(readFileSync(historyPath, 'utf8')) as unknown
      return Array.isArray(arr)
        ? (arr.filter((e) => e && typeof (e as HistoryEntry).file === 'string') as HistoryEntry[])
        : []
    } catch {
      return []
    }
  }
  const writeHistory = (rows: HistoryEntry[]): void => {
    try {
      mkdirSync(dirname(historyPath), { recursive: true })
      writeFileSync(historyPath, JSON.stringify(rows.slice(0, 200), null, 2))
    } catch {
      /* history is best-effort — never fail the export over it */
    }
  }

  // The renderer builds the PDF (jsPDF) and sends bytes; we save into the
  // current user's Downloads folder (resolved per-machine via Electron's
  // 'downloads' path) so exports land somewhere that exists on every system —
  // not a machine-specific Documents path baked into synced data.
  ctx.ipcMain.handle(`${ID}:save-pdf`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = typeof r.ticker === 'string' ? r.ticker.trim().toUpperCase() : 'REPORT'
    const b64 = typeof r.data === 'string' ? r.data : ''
    if (!b64) return { ok: false, error: 'No PDF data.' }
    const company = docs.get(sym).company
    // A tidy sub-folder inside Downloads keeps reports grouped without ever
    // depending on a path from another machine. Downloads always exists.
    const folder = join(ctx.app.getPath('downloads'), 'Stock Research')
    try {
      mkdirSync(folder, { recursive: true })
      const stamp = new Date()
      const name = `${sym} report ${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}-${stamp.getFullYear()}.pdf`
      const file = join(folder, name)
      writeFileSync(file, Buffer.from(b64, 'base64'))
      writeHistory([
        { ticker: sym, company, file, savedAt: Date.now() },
        ...readHistory().filter((e) => e.file !== file)
      ])
      // Highlight the freshly-written file in the OS file browser.
      ctx.shell.showItemInFolder(file)
      return { ok: true, file }
    } catch (err) {
      return { ok: false, error: 'Could not save the PDF: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:history`, () => ({
    ok: true,
    rows: readHistory().map((e) => ({ ...e, exists: existsSync(e.file) }))
  }))

  ctx.ipcMain.handle(`${ID}:reveal`, (_e, raw: unknown) => {
    const file = typeof raw === 'string' ? raw : ''
    if (!file || !existsSync(file)) {
      return { ok: false, error: 'That PDF was not found — it may have been moved or deleted.' }
    }
    ctx.shell.showItemInFolder(file)
    return { ok: true }
  })

  // "Paste From Clipboard" on the Trendlines step — reads the OS clipboard in
  // main (reliable on Windows, no renderer permission prompts).
  ctx.ipcMain.handle(`${ID}:clipboard-image`, () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) {
      return { ok: false, error: 'No image on the clipboard — copy a screenshot first, then click Paste.' }
    }
    return { ok: true, dataUrl: img.toDataURL() }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const docsDir = join(ctx.app.getPath('userData'), 'modules', ID, 'docs')
    const exportDir = join(ctx.app.getPath('downloads'), 'Stock Research')
    return [
      { label: 'Analysis docs', path: existsSync(docsDir) ? docsDir : null, note: 'Per-ticker reports, chat and screenshots' },
      { label: 'Exports', path: existsSync(exportDir) ? exportDir : null, note: 'Saved PDFs in your Downloads folder' }
    ]
  })
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { clipboard } from 'electron'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { callAi, type AiKeys, type AiMessage } from './ipc/ai'
import { extractTickersWithFallback, mentionsIpos } from './ipc/chatContext'
import { DocStore, type StockDoc } from './ipc/docs'
import { parseReportSpec, type ReportSpec } from './ipc/report'
import { getIpos, searchTickers } from './ipc/market/massive'
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

const fmtMoney = (v: number | null): string =>
  v === null ? 'n/a' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${v.toFixed(2)}`

/** Live-data summary block injected into report + chat prompts. */
function summaryBlock(td: TickerData): string {
  const q = td.quote
  const lines = [
    `${td.symbol} — ${td.details?.name ?? 'Unknown company'}`,
    `Price: ${q.price !== null ? `$${q.price.toFixed(2)}` : 'not available'}` +
      (q.changePct !== null ? ` (${q.changePct >= 0 ? '+' : ''}${q.changePct.toFixed(2)}% today)` : ''),
    `Market cap: ${fmtMoney(td.details?.marketCap ?? null)}`,
    td.pe !== null
      ? `Trailing P/E: ${td.pe.toFixed(1)}`
      : td.netIncome !== null && td.netIncome <= 0
        ? 'Trailing P/E: not meaningful (net loss)'
        : 'Trailing P/E: not available',
    `Sector: ${td.details?.sector || 'n/a'}`,
    `Annual revenue: ${fmtMoney(td.revenue)} · Net income: ${fmtMoney(td.netIncome)}`,
    td.earnings
      ? `Next earnings: ${td.earnings.date} (${td.earnings.isEstimate ? 'estimated' : 'confirmed'}, via ${td.earnings.source})`
      : 'Next earnings: not available — do NOT guess an earnings date.',
    td.news.length > 0
      ? 'Recent headlines:\n' + td.news.slice(0, 3).map((n) => `  - ${n.title} (${n.source})`).join('\n')
      : 'Recent headlines: none available'
  ]
  return lines.join('\n')
}

const REPORT_RULES =
  'Return ONLY a JSON object (no markdown fences, no prose) with this shape: ' +
  '{"title","subtitle","ticker","company","asOf","stats":[{"label","value"} up to 12],' +
  '"sections":[{"heading","body","bullets":[..up to 6]} 1..20],"disclaimer"}. ' +
  'Mandated sections in order: Overview, Financials, Technical setup, Pros, Cons. ' +
  'Ground every claim in the provided live data; where data is missing say so — never invent numbers, ' +
  'prices or earnings dates. A trailing P/E is not meaningful for a company with a net loss. ' +
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
      const td = await getTickerData(marketKeys(), sym, true)
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
            `Write the report for ${sym}.\n\nLIVE DATA (authoritative — use it, do not contradict it):\n${summaryBlock(td)}\n\n` +
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

  // The renderer builds the PDF (jsPDF) and sends bytes; default save location
  // is Documents/Stock Trading/{TICKER — Company}/ per the ported convention.
  ctx.ipcMain.handle(`${ID}:save-pdf`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = typeof r.ticker === 'string' ? r.ticker.trim().toUpperCase() : 'REPORT'
    const b64 = typeof r.data === 'string' ? r.data : ''
    if (!b64) return { ok: false, error: 'No PDF data.' }
    const company = docs.get(sym).company
    const folder = join(
      ctx.app.getPath('documents'),
      'Stock Trading',
      company ? `${sym} — ${company}`.slice(0, 80) : sym
    )
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
      await ctx.shell.openPath(folder)
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
    const exportDir = join(ctx.app.getPath('documents'), 'Stock Trading')
    return [
      { label: 'Analysis docs', path: existsSync(docsDir) ? docsDir : null, note: 'Per-ticker reports, chat and screenshots' },
      { label: 'Exports', path: existsSync(exportDir) ? exportDir : null, note: 'Saved PDFs, one folder per ticker' }
    ]
  })
}

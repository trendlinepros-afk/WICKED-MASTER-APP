import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
// Shared engines: market data + AI from stock-planner, order parsing from the
// Trade Journal — one implementation each, imported rather than duplicated.
import { getDayMinuteBars } from '../stock-planner/ipc/market/massive'
import { getTickerData } from '../stock-planner/ipc/market/tickerdata'
import { callAi, type AiMessage } from '../stock-planner/ipc/ai'
import { parseReportSpec } from '../stock-planner/ipc/report'
import { execHash, parseWebullTime, type Execution, type Side } from '../trade-analytics/lib/parse'
import { matchStockFolder } from './ipc/folders'

/* ------------------------------------------------------------------------ *
 *  TRADE REVIEW — main process. Post-trade analysis: orders in (CSV parses
 *  in the renderer with the Trade Journal's parser; screenshots extract here
 *  via AI vision), fills mapped onto a 1-minute execution chart, and an AI
 *  "trading coach" review judged against the user's trendline/swing strategy.
 *  Session-state only (ported behavior) — just PDFs are written to disk.
 * ------------------------------------------------------------------------ */

const ID = 'trade-review'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const ExtractRow = z.object({
  symbol: z.string().min(1).max(8),
  side: z.string(),
  qty: z.number().positive(),
  price: z.number().positive(),
  time: z.string()
})

function normSide(raw: string): Side {
  const s = raw.trim().toLowerCase()
  if (s.includes('short')) return 'short'
  if (s.startsWith('sell')) return 'sell'
  return 'buy'
}

export default function register(ctx: ModuleIpcContext): void {
  let aiBusy = false

  const aiKeys = () => ({
    anthropic: ctx.getApiKey('anthropic'),
    gemini: ctx.getApiKey('gemini'),
    deepseek: ctx.getApiKey('deepseek'),
    openai: ctx.getApiKey('openai')
  })

  /* ------------------------------- candles ------------------------------- */

  ctx.ipcMain.handle(`${ID}:candles`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : ''
    const ymd = typeof r.ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.ymd) ? r.ymd : ''
    if (!symbol || !ymd) return { ok: false, error: 'symbol and ymd (YYYY-MM-DD) are required.' }
    const key = ctx.getApiKey('massive')
    if (!key)
      return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys to load candles.', bars: [] }
    try {
      const bars = await getDayMinuteBars(key, symbol, ymd)
      return {
        ok: true,
        bars,
        ...(bars.length === 0
          ? {
              note: `No intraday minute bars for ${symbol} on ${ymd}. Polygon may not have the current session yet, or your market-data plan may exclude intraday aggregates — try a prior trading day.`
            }
          : {})
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ------------------------- screenshot extraction ------------------------ */

  ctx.ipcMain.handle(`${ID}:extract`, async (_e, rawImages: unknown) => {
    const images = (Array.isArray(rawImages) ? rawImages : [])
      .filter((i): i is string => typeof i === 'string' && i.startsWith('data:image/'))
      .slice(0, 4)
    if (images.length === 0) return { ok: false, error: 'Attach 1–4 order screenshots.' }
    if (aiBusy) return { ok: false, error: 'An AI request is already running.' }
    aiBusy = true
    try {
      const messages: AiMessage[] = [
        {
          role: 'system',
          text:
            'You extract broker order executions from screenshots. Return ONLY JSON: ' +
            '{"rows":[{"symbol":"JBLU","side":"Buy|Sell|Short","qty":100,"price":5.81,"time":"06/12/2026 12:37:19 EDT"}]}. ' +
            'Include ONLY FILLED executions. Do NOT invent rows — omit anything unreadable. Times exactly as shown.'
        },
        { role: 'user', text: 'Extract the filled executions from these order screenshots.', images }
      ]
      const res = await callAi(aiKeys(), messages, { json: true, tier: 'pro' })
      if (!res.ok) return { ok: false, error: res.error }
      let parsed: unknown
      try {
        parsed = JSON.parse(res.text.replace(/```(?:json)?|```/g, '').trim())
      } catch {
        return { ok: false, error: 'The AI returned unreadable data — try clearer screenshots.' }
      }
      // JSON.parse can legally return null/primitives — .rows on null throws
      const rawRows =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
          ? ((parsed as { rows: unknown[] }).rows)
          : Array.isArray(parsed)
            ? (parsed as unknown[])
            : []
      const executions: Execution[] = []
      for (const rr of rawRows) {
        const v = ExtractRow.safeParse(rr)
        if (!v.success) continue
        const d = v.data
        const e: Execution = {
          hash: '',
          name: '',
          symbol: d.symbol.toUpperCase(),
          side: normSide(d.side),
          sideRaw: d.side,
          status: 'Filled',
          filled: true,
          qty: d.qty,
          totalQty: d.qty,
          price: d.price,
          avgPrice: d.price,
          limitPrice: d.price,
          timeInForce: '',
          placedText: d.time,
          filledText: d.time,
          filledAt: parseWebullTime(d.time),
          placedAt: parseWebullTime(d.time)
        }
        e.hash = execHash(e)
        executions.push(e)
      }
      if (executions.length === 0)
        return { ok: false, error: 'No usable filled executions were found in those screenshots.' }
      return { ok: true, executions }
    } finally {
      aiBusy = false
    }
  })

  /* ------------------------------ AI review ------------------------------- */

  const STRATEGY =
    'The trader\'s stated strategy is TRENDLINE / SWING TRADING: enter at trendline support or on a ' +
    'confirmed breakout, hold multi-hour to multi-day, exit at resistance or on a trendline break. ' +
    'Judge the executions against THAT strategy specifically: flag chasing entries, panic exits, ' +
    'cutting winners early, holding losers, and scalping behavior that contradicts a swing plan.'

  ctx.ipcMain.handle(`${ID}:analyze`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const digest = typeof r.digest === 'string' ? r.digest : ''
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : ''
    const images = (Array.isArray(r.images) ? r.images : [])
      .filter((i): i is string => typeof i === 'string' && i.startsWith('data:image/'))
      .slice(0, 4)
    if (!digest) return { ok: false, error: 'Nothing to analyze — import some orders first.' }
    if (aiBusy) return { ok: false, error: 'An AI request is already running.' }
    aiBusy = true
    try {
      // live ticker summary when Massive is configured (ported)
      let live = ''
      if (symbol && ctx.getApiKey('massive')) {
        try {
          const td = await getTickerData(
            { massive: ctx.getApiKey('massive'), finnhub: ctx.getApiKey('finnhub') },
            symbol,
            true
          )
          live = `\n\nLIVE ${symbol} DATA:\nPrice: ${td.quote.price ?? 'n/a'} · Change: ${td.quote.changePct?.toFixed(2) ?? 'n/a'}% · Next earnings: ${td.earnings ? `${td.earnings.date} (${td.earnings.isEstimate ? 'est.' : 'confirmed'})` : 'not available'}`
        } catch {
          /* fail-soft */
        }
      }
      const messages: AiMessage[] = [
        {
          role: 'system',
          text:
            'You are a professional trading coach reviewing a day\'s executions. ' +
            STRATEGY +
            ' Be direct and specific; cite the actual fills/times/prices. Return ONLY a JSON report: ' +
            '{"title","subtitle","ticker","company","asOf","stats":[{"label","value"}],"sections":[{"heading","body","bullets":[]}],"disclaimer"}. ' +
            'Educational process critique, not financial advice.'
        },
        { role: 'user', text: `Review this trading session.${live}\n\n${digest.slice(0, 12000)}`, images }
      ]
      const res = await callAi(aiKeys(), messages, { json: true, tier: 'pro' })
      if (!res.ok) return { ok: false, error: res.error }
      const report = parseReportSpec(res.text)
      if (!report) return { ok: false, error: 'The AI returned an unreadable review — try again.' }
      return { ok: true, report }
    } finally {
      aiBusy = false
    }
  })

  /* ------------------------------ coach chat ------------------------------ */

  ctx.ipcMain.handle(`${ID}:chat`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const context = typeof r.context === 'string' ? r.context : ''
    const turns = (Array.isArray(r.messages) ? r.messages : [])
      .map((m) => m as { role?: string; text?: string })
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .slice(-20)
    if (turns.length === 0) return { ok: false, error: 'Say something first.' }
    if (aiBusy) return { ok: false, error: 'An AI request is already running.' }
    aiBusy = true
    try {
      // stateless (ported): full context + last 20 turns every call
      const messages: AiMessage[] = [
        {
          role: 'system',
          text: 'You are a trading coach. ' + STRATEGY + '\n\nSESSION EXECUTIONS:\n' + context.slice(0, 8000)
        },
        ...turns.map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text as string }))
      ]
      const res = await callAi(aiKeys(), messages, { tier: 'lite' })
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, text: res.text }
    } finally {
      aiBusy = false
    }
  })

  /* -------------------------------- export -------------------------------- */

  ctx.ipcMain.handle(`${ID}:save-pdf`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const ticker = typeof r.ticker === 'string' && r.ticker.trim() ? r.ticker.trim().toUpperCase() : 'SESSION'
    const b64 = typeof r.data === 'string' ? r.data : ''
    if (!b64) return { ok: false, error: 'No PDF data.' }
    try {
      const root = join(ctx.app.getPath('documents'), 'Stock Trading')
      mkdirSync(root, { recursive: true })
      // co-locate with Stock Planner research: word-boundary prefix match so
      // an RPD review lands in "RPD — Rapid7"… but never in "RPDX — …".
      const existing = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
      const folder = join(root, matchStockFolder(existing, ticker) ?? ticker)
      mkdirSync(folder, { recursive: true })
      const now = new Date()
      const name = `${ticker} trade analysis — ${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}.pdf`
      const file = join(folder, name)
      writeFileSync(file, Buffer.from(b64, 'base64')) // replace-on-same-name
      await ctx.shell.openPath(folder)
      return { ok: true, file }
    } catch (err) {
      return { ok: false, error: 'Could not save the PDF: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const root = join(ctx.app.getPath('documents'), 'Stock Trading')
    return [
      {
        label: 'Exports',
        path: existsSync(root) ? root : null,
        note: 'Trade-review PDFs, co-located with Stock Planner research per ticker'
      }
    ]
  })
}

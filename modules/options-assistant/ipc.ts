import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { callAi, type AiKeys, type AiMessage } from '../stock-planner/ipc/ai'
import { getAggregates, getMassiveNews, type NewsItem } from '../stock-planner/ipc/market/massive'
import { getCompanyNews, getFinnhubEarnings } from '../stock-planner/ipc/market/finnhub'
import { yahooEarnings } from '../stock-planner/ipc/market/yahoo'
import {
  fnum,
  fstr,
  getWatchlists,
  getWatchlistSymbols,
  optionContracts,
  optionSnapshots,
  parseOcc,
  stockSnapshots,
  trimRow,
  webullGet,
  type WebullKeys
} from './webull'

/**
 * OPTIONS ASSISTANT — main process.
 *
 * Chat assistant that hunts the single best options contract on your watchlist
 * for a desired direction + expiration timeframe. Pipeline per scan:
 *
 *   watchlist → Webull stock snapshots → per-ticker option chains for every
 *   candidate expiry in the window (strikes clamped near the money) → live
 *   option quotes → per-ticker context (next earnings date, news headlines,
 *   recent trend from Massive) → one AI pass that ranks everything and picks
 *   the highest-probability contract (or honestly says nothing is worth it).
 *
 * Webull OpenAPI credentials come from the central vault (webull-app-key /
 * webull-app-secret) and never leave the main process.
 */
const ID = 'options-assistant'
const DAY_MS = 86_400_000
const MAX_WATCHLIST = 50
const MAX_EXPIRY_DATES = 6

/* ------------------------------ ET calendar ------------------------------- */

const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})
const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })

const etYmd = (d: Date): string => ET_DAY.format(d)
const isMarketDay = (d: Date): boolean => !['Sat', 'Sun'].includes(ET_WEEKDAY.format(d))

/** Next N market days in ET starting today (index 0 = today or next market day). */
function marketDays(count: number): string[] {
  const out: string[] = []
  let t = Date.now()
  while (out.length < count + 1) {
    const d = new Date(t)
    if (isMarketDay(d)) out.push(etYmd(d))
    t += DAY_MS
  }
  return out
}

export const HORIZONS: Record<string, { label: string; days: number }> = {
  '0d': { label: 'zero-day (0DTE)', days: 0 },
  '1d': { label: 'next market day', days: 1 },
  '2d': { label: 'within 2 market days', days: 2 },
  '3d': { label: 'within 3 market days', days: 3 },
  '5d': { label: 'within a week', days: 5 },
  '10d': { label: 'within two weeks', days: 10 },
  '21d': { label: 'within a month', days: 21 }
}

/** Candidate expiry dates for a horizon, capped: near days + Fridays + the last day. */
function expiryDates(days: number): string[] {
  const all = marketDays(days)
  if (all.length <= MAX_EXPIRY_DATES) return all
  const fridays = all.filter((ymd) => ET_WEEKDAY.format(new Date(`${ymd}T17:00:00Z`)) === 'Fri')
  const picked = [...all.slice(0, 3), ...fridays, all[all.length - 1]]
  return [...new Set(picked)].sort().slice(0, MAX_EXPIRY_DATES)
}

/* --------------------------------- misc ----------------------------------- */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cleanSymbol(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 6) : ''
}

interface ScanResult {
  summary: string
  best: {
    ticker: string
    option_symbol: string
    label: string
    why: string[]
    risks: string[]
    entry: string
    confidence: number
  } | null
  runners_up: { ticker: string; option_symbol: string; label: string; note: string }[]
  avoided: { ticker: string; reason: string }[]
}

function parseScanResult(raw: string): ScanResult | null {
  try {
    let s = raw.trim()
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) s = fence[1]
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    const o = JSON.parse(s) as Partial<ScanResult> & { best?: unknown }
    const strArr = (v: unknown, cap: number): string[] =>
      Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, cap) : []
    const bestRaw = (typeof o.best === 'object' && o.best !== null ? o.best : null) as Record<string, unknown> | null
    return {
      summary: typeof o.summary === 'string' ? o.summary : '',
      best:
        bestRaw && typeof bestRaw.ticker === 'string' && typeof bestRaw.option_symbol === 'string'
          ? {
              ticker: String(bestRaw.ticker).toUpperCase(),
              option_symbol: String(bestRaw.option_symbol).toUpperCase(),
              label: String(bestRaw.label ?? ''),
              why: strArr(bestRaw.why, 5),
              risks: strArr(bestRaw.risks, 4),
              entry: String(bestRaw.entry ?? ''),
              confidence: Math.max(0, Math.min(100, Number(bestRaw.confidence) || 0))
            }
          : null,
      runners_up: Array.isArray(o.runners_up)
        ? o.runners_up
            .map((r) => (typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {}))
            .filter((r) => r.ticker && r.option_symbol)
            .map((r) => ({
              ticker: String(r.ticker).toUpperCase(),
              option_symbol: String(r.option_symbol).toUpperCase(),
              label: String(r.label ?? ''),
              note: String(r.note ?? r.why_one_line ?? '')
            }))
            .slice(0, 2)
        : [],
      avoided: Array.isArray(o.avoided)
        ? o.avoided
            .map((r) => (typeof r === 'object' && r !== null ? (r as Record<string, unknown>) : {}))
            .filter((r) => r.ticker)
            .map((r) => ({ ticker: String(r.ticker).toUpperCase(), reason: String(r.reason ?? '') }))
            .slice(0, 4)
        : []
    }
  } catch {
    return null
  }
}

/* -------------------------------- register -------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  const WATCHLIST_KEY = `${ID}.watchlist`
  const HISTORY_KEY = `${ID}.history`
  const LASTSCAN_KEY = `${ID}.lastScan`

  let scanBusy = false
  let cancelRequested = false

  const send = (payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(`${ID}:progress`, payload)
  }
  const step = (text: string): void => send({ kind: 'step', text })

  const webullKeys = (): WebullKeys | null => {
    const appKey = ctx.getApiKey('webull-app-key')
    const appSecret = ctx.getApiKey('webull-app-secret')
    return appKey && appSecret ? { appKey, appSecret } : null
  }

  const aiKeys = (): AiKeys => ({
    anthropic: ctx.getApiKey('anthropic'),
    gemini: ctx.getApiKey('gemini'),
    deepseek: ctx.getApiKey('deepseek'),
    openai: ctx.getApiKey('openai')
  })
  const hasAi = (): boolean => Object.values(aiKeys()).some(Boolean)
  /** Which provider the shared AI cascade will try first (mirrors callAi's order). */
  const aiProviderName = (): string | null => {
    const k = aiKeys()
    return k.anthropic ? 'Claude' : k.gemini ? 'Gemini' : k.deepseek ? 'DeepSeek' : k.openai ? 'OpenAI' : null
  }

  const getWatchlist = (): string[] => {
    const raw = ctx.storeGet<unknown[]>(WATCHLIST_KEY, [])
    return (Array.isArray(raw) ? raw : []).map(cleanSymbol).filter(Boolean)
  }
  const setWatchlist = (syms: string[]): string[] => {
    const list = [...new Set(syms.map(cleanSymbol).filter(Boolean))].slice(0, MAX_WATCHLIST)
    ctx.storeSet(WATCHLIST_KEY, list)
    return list
  }

  /* -------------------------------- status -------------------------------- */

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    hasWebull: webullKeys() !== null,
    hasAi: hasAi(),
    aiProvider: aiProviderName(),
    hasMassive: !!ctx.getApiKey('massive'),
    hasFinnhub: !!ctx.getApiKey('finnhub'),
    watchlist: getWatchlist(),
    busy: scanBusy
  }))

  /** Quick round-trip so the user can verify their App Key/Secret instantly. */
  ctx.ipcMain.handle(`${ID}:test-connection`, async () => {
    const keys = webullKeys()
    if (!keys) return { ok: false, error: 'Add your Webull App Key AND App Secret in Settings → API Keys first.' }
    const res = await webullGet(keys, '/openapi/market-data/stock/snapshot', { symbols: 'AAPL', category: 'US_STOCK' })
    if (!res.ok) return { ok: false, error: res.error }
    return { ok: true, note: 'Webull OpenAPI is responding — credentials look good.' }
  })

  /* ------------------------------- watchlist ------------------------------- */

  ctx.ipcMain.handle(`${ID}:watchlist-get`, () => ({ ok: true, watchlist: getWatchlist() }))

  ctx.ipcMain.handle(`${ID}:watchlist-add`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = cleanSymbol(r.symbol)
    if (!sym) return { ok: false, error: 'Enter a ticker symbol.' }
    const list = getWatchlist()
    if (list.length >= MAX_WATCHLIST && !list.includes(sym))
      return { ok: false, error: `Watchlist is capped at ${MAX_WATCHLIST} tickers (keeps scans fast and focused).` }
    return { ok: true, watchlist: setWatchlist([...list, sym]) }
  })

  ctx.ipcMain.handle(`${ID}:watchlist-remove`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = cleanSymbol(r.symbol)
    return { ok: true, watchlist: setWatchlist(getWatchlist().filter((s) => s !== sym)) }
  })

  /** The user's Webull-side watchlists, for import. */
  ctx.ipcMain.handle(`${ID}:webull-watchlists`, async () => {
    const keys = webullKeys()
    if (!keys) return { ok: false, error: 'Add your Webull App Key/Secret in Settings → API Keys first.' }
    try {
      return { ok: true, watchlists: await getWatchlists(keys) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:webull-import`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const keys = webullKeys()
    if (!keys) return { ok: false, error: 'Add your Webull App Key/Secret in Settings → API Keys first.' }
    try {
      const syms = await getWatchlistSymbols(keys, String(r.watchlistId ?? ''))
      if (syms.length === 0) return { ok: false, error: 'That Webull watchlist came back empty.' }
      const merged = setWatchlist([...getWatchlist(), ...syms])
      return { ok: true, watchlist: merged, imported: syms.length }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ------------------------------ chain (read) ----------------------------- */

  /** Raw near-the-money chain for one ticker in a horizon window (also on MCP). */
  ctx.ipcMain.handle(`${ID}:chain`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const keys = webullKeys()
    if (!keys) return { ok: false, error: 'Add your Webull App Key/Secret in Settings → API Keys first.' }
    const sym = cleanSymbol(r.symbol)
    if (!sym) return { ok: false, error: 'Enter a ticker symbol.' }
    const horizon = HORIZONS[String(r.horizon ?? '2d')] ?? HORIZONS['2d']
    const optionType: 'CALL' | 'PUT' = r.direction === 'down' ? 'PUT' : 'CALL'
    try {
      const batch = await stockSnapshots(keys, [sym])
      if (batch.invalid.includes(sym)) return { ok: false, error: `Webull does not recognize the ticker ${sym}.` }
      const snap = batch.snaps.get(sym)
      const spot = snap ? fnum(snap, 'last', 'close', 'price', 'last_price', 'lastPrice') : null
      const band = 0.06 + 0.006 * horizon.days
      const contracts: Record<string, unknown>[] = []
      for (const ymd of expiryDates(horizon.days)) {
        const rows = await optionContracts(
          keys,
          sym,
          ymd,
          optionType,
          spot != null ? Math.floor(spot * (1 - band)) : null,
          spot != null ? Math.ceil(spot * (1 + band)) : null
        )
        contracts.push(...rows)
      }
      return { ok: true, symbol: sym, spot, contracts: contracts.slice(0, 200).map(trimRow) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* --------------------------------- scan ---------------------------------- */

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    cancelRequested = true
    return { ok: true }
  })

  const checkCancel = (): void => {
    if (cancelRequested) throw new Error('Scan cancelled.')
  }

  ctx.ipcMain.handle(`${ID}:scan`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (scanBusy) return { ok: false, error: 'A scan is already running.' }
    const keys = webullKeys()
    if (!keys) return { ok: false, error: 'Add your Webull App Key AND App Secret in Settings → API Keys first.' }
    if (!hasAi())
      return { ok: false, error: 'Add an AI key (Anthropic, Gemini, DeepSeek or OpenAI) in Settings → API Keys.' }
    const watchlist = getWatchlist()
    if (watchlist.length === 0) return { ok: false, error: 'Your watchlist is empty — add tickers first.' }

    const direction: 'up' | 'down' = r.direction === 'down' ? 'down' : 'up'
    const optionType: 'CALL' | 'PUT' = direction === 'down' ? 'PUT' : 'CALL'
    const horizonId = typeof r.horizon === 'string' && HORIZONS[r.horizon] ? r.horizon : '2d'
    const horizon = HORIZONS[horizonId]
    const budget = Number(r.budget) > 0 ? Number(r.budget) : null
    const dates = expiryDates(horizon.days)
    const massiveKey = ctx.getApiKey('massive')
    const finnhubKey = ctx.getApiKey('finnhub')

    scanBusy = true
    cancelRequested = false
    try {
      step(`Pulling live quotes for ${watchlist.length} ticker(s)…`)
      const { snaps, invalid } = await stockSnapshots(keys, watchlist)
      if (invalid.length > 0)
        step(`Webull doesn't recognize: ${invalid.join(', ')} — skipped (remove them from the watchlist).`)
      checkCancel()

      // per-ticker dossier build with a small worker pool. Big watchlists get a
      // leaner dossier (fewer contracts, no raw quote passthrough) so the AI
      // context stays within budget at 50 tickers.
      const dossiers: Record<string, unknown>[] = []
      const strikeBand = 0.06 + 0.006 * horizon.days // ±6% for 0DTE → ±~19% a month out
      const bigScan = watchlist.length > 25
      const contractsPerTicker = bigScan ? 10 : 14
      let idx = 0
      const worker = async (): Promise<void> => {
        while (idx < watchlist.length) {
          const sym = watchlist[idx++]
          checkCancel()
          const snap = snaps.get(sym)
          const spot = snap ? fnum(snap, 'last', 'close', 'price', 'last_price', 'lastPrice') : null
          if (spot == null) {
            step(`${sym}: no quote from Webull — skipped.`)
            continue
          }
          step(`${sym}: scanning ${optionType} chain (${dates.length} expiry date(s))…`)
          const byExpiry = new Map<string, { occ: string; strike: number; row: Record<string, unknown> }[]>()
          for (const ymd of dates) {
            checkCancel()
            try {
              const rows = await optionContracts(
                keys,
                sym,
                ymd,
                optionType,
                Math.floor(spot * (1 - strikeBand)),
                Math.ceil(spot * (1 + strikeBand))
              )
              for (const row of rows) {
                const occ = fstr(row, 'symbol', 'option_symbol', 'optionSymbol').toUpperCase()
                const parsed = parseOcc(occ)
                if (!parsed) continue
                const list = byExpiry.get(parsed.expiry) ?? []
                list.push({ occ, strike: parsed.strike, row })
                byExpiry.set(parsed.expiry, list)
              }
            } catch (err) {
              step(`${sym} ${ymd}: chain failed (${errMsg(err).slice(0, 120)})`)
            }
          }
          // nearest-the-money first within each expiry, then round-robin across expiries
          for (const list of byExpiry.values()) list.sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          const picked: { occ: string; strike: number; expiry: string }[] = []
          const expiries = [...byExpiry.keys()].sort()
          for (let round = 0; picked.length < contractsPerTicker; round++) {
            let took = false
            for (const exp of expiries) {
              const list = byExpiry.get(exp) ?? []
              if (round < list.length && picked.length < contractsPerTicker) {
                picked.push({ occ: list[round].occ, strike: list[round].strike, expiry: exp })
                took = true
              }
            }
            if (!took) break
          }
          if (picked.length === 0) {
            step(`${sym}: no listed ${optionType}s in this window — skipped.`)
            continue
          }

          // live option quotes
          const quotes = await optionSnapshots(keys, picked.map((p) => p.occ))
          const contracts = picked
            .map((p) => {
              const q = quotes.get(p.occ)
              const bid = q ? fnum(q, 'bid', 'bid_price', 'bidPrice') : null
              const ask = q ? fnum(q, 'ask', 'ask_price', 'askPrice') : null
              const last = q ? fnum(q, 'last', 'close', 'price', 'last_price') : null
              const mid = bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : last
              return {
                option_symbol: p.occ,
                expiry: p.expiry,
                strike: p.strike,
                type: optionType,
                moneyness_pct: Number((((p.strike - spot) / spot) * 100).toFixed(2)),
                bid,
                ask,
                mid: mid != null ? Number(mid.toFixed(3)) : null,
                spread_pct:
                  bid != null && ask != null && mid ? Number((((ask - bid) / mid) * 100).toFixed(1)) : null,
                est_cost_per_contract: mid != null ? Number((mid * 100).toFixed(0)) : null,
                volume: q ? fnum(q, 'volume', 'total_volume', 'totalVolume') : null,
                open_interest: q ? fnum(q, 'open_interest', 'openInterest', 'open_int') : null,
                iv: q ? fnum(q, 'implied_volatility', 'impliedVolatility', 'iv') : null,
                delta: q ? fnum(q, 'delta') : null,
                theta: q ? fnum(q, 'theta') : null,
                // big scans skip the raw quote passthrough to keep AI context lean
                quote: q && !bigScan ? trimRow(q) : null
              }
            })
            // budget cap: drop contracts the user can't afford (keep unknown-cost rows)
            .filter((c) => budget == null || c.est_cost_per_contract == null || c.est_cost_per_contract <= budget)
          if (contracts.length === 0) {
            step(`${sym}: nothing under your $${budget} budget — skipped.`)
            continue
          }

          // context: earnings + news + recent trend (all fail-soft)
          checkCancel()
          step(`${sym}: earnings, news and trend context…`)
          let earnings: { date: string; isEstimate: boolean } | null = null
          try {
            earnings = finnhubKey ? await getFinnhubEarnings(finnhubKey, sym) : await yahooEarnings(sym)
          } catch {
            /* no earnings info */
          }
          const lastDate = dates[dates.length - 1]
          const earningsInWindow = !!earnings && earnings.date <= lastDate
          let news: NewsItem[] = []
          try {
            if (finnhubKey) news = await getCompanyNews(finnhubKey, sym)
            else if (massiveKey) news = await getMassiveNews(massiveKey, sym)
          } catch {
            /* no news */
          }
          let trend: Record<string, number> | null = null
          if (massiveKey) {
            try {
              const now = Date.now()
              const bars = await getAggregates(massiveKey, sym, 1, 'day', now - 45 * DAY_MS, now)
              if (bars.length >= 6) {
                const closes = bars.map((b) => b.c)
                const lastC = closes[closes.length - 1]
                const back = (n: number): number => closes[Math.max(0, closes.length - 1 - n)]
                const win = closes.slice(-20)
                const hi = Math.max(...win)
                const lo = Math.min(...win)
                trend = {
                  pct_5d: Number((((lastC - back(5)) / back(5)) * 100).toFixed(2)),
                  pct_20d: Number((((lastC - back(Math.min(20, closes.length - 1))) / back(Math.min(20, closes.length - 1))) * 100).toFixed(2)),
                  range_pos_20d: hi > lo ? Number((((lastC - lo) / (hi - lo)) * 100).toFixed(0)) : 50
                }
              }
            } catch {
              /* no trend */
            }
          }

          dossiers.push({
            symbol: sym,
            spot,
            snapshot: snap ? trimRow(snap) : null,
            next_earnings: earnings ? { ...earnings, inside_window: earningsInWindow } : null,
            news: news.slice(0, 6).map((n) => ({ title: n.title.slice(0, 140), at: n.publishedAt.slice(0, 10) })),
            trend,
            contracts
          })
        }
      }
      await Promise.all([worker(), worker(), worker()])
      checkCancel()

      if (dossiers.length === 0)
        return {
          ok: false,
          error: 'No usable option chains came back for your watchlist in that window. Check tickers / expiration timeframe.'
        }

      step(`Analyzing ${dossiers.reduce((n, d) => n + (d.contracts as unknown[]).length, 0)} contract(s) across ${dossiers.length} ticker(s) with AI…`)
      const dossierJson = JSON.stringify(dossiers)
      const system: AiMessage = {
        role: 'system',
        text: [
          'You are an elite options analyst inside WICKED, advising a fast, self-directed trader.',
          `Goal: the user wants to BUY ${optionType}S to profit from a ${direction === 'up' ? 'RISE' : 'FALL'} ${horizon.label}. Candidate expiries: ${dates.join(', ')}.`,
          budget ? `Hard budget: at most $${budget} premium per contract.` : '',
          'You are given, per ticker: live spot + snapshot, the near-the-money chain with live bid/ask, next earnings date (inside_window flag), recent news headlines, and short-term trend.',
          'Judge ONLY from the provided data. Weigh: (1) direction alignment — momentum, news catalysts, snapshot day action; (2) liquidity — tight spread_pct, real bid/ask; a wide/no-bid contract is DISQUALIFIED however good the story; (3) event risk — earnings inside_window means violent IV crush risk unless the event IS the thesis (say so); (4) time — for 0-2 day expiries prefer strikes with realistic reach (small |moneyness_pct|), theta is brutal; (5) premium vs realistic move.',
          'Reply with STRICT JSON only, no prose outside JSON:',
          '{"summary":"2-4 sentence market read of the watchlist for this play","best":{"ticker":"","option_symbol":"","label":"e.g. AAPL $232.5 CALL exp 2026-08-12","why":["3-5 specific reasons citing the data"],"risks":["2-4 real risks"],"entry":"one line on entry/price to pay","confidence":0-100}|null,"runners_up":[{"ticker":"","option_symbol":"","label":"","note":"one line"}],"avoided":[{"ticker":"","reason":"one line"}]}',
          'If NOTHING has a credible edge or acceptable liquidity, set best to null and say why in summary — do not force a pick.'
        ]
          .filter(Boolean)
          .join('\n')
      }
      const user: AiMessage = { role: 'user', text: `WATCHLIST DOSSIER:\n${dossierJson}` }
      const ai = await callAi(aiKeys(), [system, user], { json: true, tier: 'pro' })
      if (!ai.ok) return { ok: false, error: `AI analysis failed: ${ai.error}` }
      const result = parseScanResult(ai.text)
      if (!result) return { ok: false, error: 'The AI returned an unreadable answer — try the scan again.' }

      // attach live contract details for the UI cards
      const findContract = (occ: string): Record<string, unknown> | null => {
        for (const d of dossiers) {
          const hit = (d.contracts as Record<string, unknown>[]).find((c) => c.option_symbol === occ)
          if (hit) return hit
        }
        return null
      }
      const enriched = {
        ...result,
        best: result.best ? { ...result.best, contract: findContract(result.best.option_symbol) } : null,
        runners_up: result.runners_up.map((ru) => ({ ...ru, contract: findContract(ru.option_symbol) })),
        direction,
        horizon: horizonId,
        horizonLabel: horizon.label,
        expiries: dates,
        at: Date.now(),
        provider: ai.provider
      }

      // history (cap 15) + last-scan context for chat follow-ups
      const hist = ctx.storeGet<unknown[]>(HISTORY_KEY, [])
      const list = Array.isArray(hist) ? hist : []
      list.unshift({
        at: enriched.at,
        direction,
        horizon: horizonId,
        summary: enriched.summary.slice(0, 400),
        best: enriched.best
          ? { ticker: enriched.best.ticker, label: enriched.best.label, option_symbol: enriched.best.option_symbol, confidence: enriched.best.confidence }
          : null
      })
      ctx.storeSet(HISTORY_KEY, list.slice(0, 15))
      ctx.storeSet(LASTSCAN_KEY, {
        at: enriched.at,
        direction,
        horizon: horizonId,
        dossier: dossierJson.slice(0, 160_000),
        result: JSON.stringify(result).slice(0, 20_000)
      })

      send({ kind: 'done' })
      return { ok: true, result: enriched }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    } finally {
      scanBusy = false
      cancelRequested = false
    }
  })

  /* --------------------------------- chat ---------------------------------- */

  ctx.ipcMain.handle(`${ID}:chat`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (!hasAi())
      return { ok: false, error: 'Add an AI key (Anthropic, Gemini, DeepSeek or OpenAI) in Settings → API Keys.' }
    const question = typeof r.question === 'string' ? r.question.slice(0, 4000) : ''
    // pasted screenshots: data URLs, validated + capped (vision goes to
    // Claude/Gemini/OpenAI via the shared cascade; DeepSeek is skipped)
    const images = (Array.isArray(r.images) ? r.images : [])
      .filter((s): s is string => typeof s === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(s))
      .slice(0, 3)
    if (images.reduce((n, s) => n + s.length, 0) > 15_000_000)
      return { ok: false, error: 'Screenshot(s) too large — paste smaller crops.' }
    if (!question.trim() && images.length === 0) return { ok: false, error: 'Ask something first.' }
    const last = ctx.storeGet<Record<string, unknown> | null>(LASTSCAN_KEY, null)
    const history = Array.isArray(r.history)
      ? (r.history as { role?: string; text?: string }[])
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
          .slice(-12)
          .map((m): AiMessage => ({ role: m.role as 'user' | 'assistant', text: String(m.text).slice(0, 4000) }))
      : []
    const system: AiMessage = {
      role: 'system',
      text: [
        'You are the Options Assistant inside WICKED — a sharp, plain-spoken options analyst chatting with a self-directed trader.',
        'Answer from the latest scan context below when relevant; be concrete about strikes, expiries, liquidity and risk. If you lack the data to answer, say exactly what to re-scan.',
        'The user may paste screenshots (charts, option chains, positions, news) — read them carefully and tie what you see to the scan data.',
        'Keep answers tight (a few short paragraphs or bullets). No boilerplate disclaimers.',
        last && typeof last.dossier === 'string'
          ? `LATEST SCAN (direction=${String(last.direction)}, horizon=${String(last.horizon)}):\nRESULT: ${String(last.result ?? '')}\nDOSSIER: ${String(last.dossier).slice(0, 100_000)}`
          : 'No scan has been run yet this session — tell the user to run one for contract-level answers.'
      ].join('\n')
    }
    const userTurn: AiMessage = {
      role: 'user',
      text: question.trim() || 'Here is a screenshot — read it and relate it to my scan.',
      images: images.length > 0 ? images : undefined
    }
    const ai = await callAi(aiKeys(), [system, ...history, userTurn], { tier: 'pro' })
    if (!ai.ok) return { ok: false, error: ai.error }
    return { ok: true, text: ai.text, provider: ai.provider }
  })

  /* ------------------------------- history --------------------------------- */

  ctx.ipcMain.handle(`${ID}:history`, () => {
    const hist = ctx.storeGet<unknown[]>(HISTORY_KEY, [])
    return { ok: true, entries: (Array.isArray(hist) ? hist : []).slice(0, 15) }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Watchlist + scan history',
      path: join(ctx.app.getPath('userData'), 'wicked-settings.json'),
      note: 'Stored in the shared module store (options-assistant.* keys)'
    }
  ])
}

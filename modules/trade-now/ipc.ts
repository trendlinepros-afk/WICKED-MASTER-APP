import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getAggregates, getTickerDetails } from '../stock-planner/ipc/market/massive'

/**
 * TRADE NOW — a live position tracker that starts as a snapshot of the moment
 * you buy. Each position captures the company name and 52-week range at first
 * entry, plus a ledger of BUY/SELL legs (price + quantity + time) you can add to
 * over the life of the trade (average down, scale out, close). A position is
 * "in trade" until the shares sold cover the shares bought. The chart spans the
 * whole position and marks every leg; "why I bought" / "prediction" notes stay
 * editable. Everything persists as plain JSON in the module folder.
 */
const ID = 'trade-now'
const NOTE_MAX = 2000
const DAY_MS = 86_400_000

export interface TradeLeg {
  id: string
  side: 'buy' | 'sell'
  price: number
  quantity: number
  /** ms epoch when this buy/sell happened */
  at: number
}

/** A hand-drawn trendline, anchored to chart data (logical index + price) so it
 *  survives zoom/pan and re-renders identically in the exported PDF. */
export interface TrendLine {
  id: string
  l1: number
  p1: number
  l2: number
  p2: number
}

export interface TradeNowEntry {
  id: string
  symbol: string
  name: string
  /** when the position was first created (ms epoch) */
  createdAt: number
  high52: number | null
  low52: number | null
  reason: string
  prediction: string
  legs: TradeLeg[]
  /** user-drawn trendlines on the chart */
  drawings: TrendLine[]
}

/** Rolled-up position metrics (average-cost basis). */
export interface TradeSummary {
  buyQty: number
  sellQty: number
  openShares: number
  avgBuy: number
  /** total spent on all buys (Σ price×qty) */
  totalBought: number
  /** total received from all sells */
  totalSold: number
  /** realized P/L on the shares sold, average-cost method */
  realized: number
  /** cost basis of the shares still held */
  openCost: number
  status: 'open' | 'closed'
  firstAt: number
  lastAt: number
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function cleanSymbol(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10) : ''
}

function cleanNote(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, NOTE_MAX) : ''
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const legId = (): string => `leg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/**
 * Average-cost roll-up of a position's legs — replayed CHRONOLOGICALLY with a
 * running average, so each sell realizes P/L against the average cost AT THE
 * TIME of the sale. (A whole-period average would let a later buy retroactively
 * rewrite already-realized P/L: buy 100@10, sell 100@12 = +$200; adding a
 * buy 100@20 afterwards must not turn that into −$300.)
 */
export function summarize(entry: TradeNowEntry): TradeSummary {
  let buyQty = 0
  let totalBought = 0
  let sellQty = 0
  let totalSold = 0
  let firstAt = entry.createdAt
  let lastAt = entry.createdAt
  let qty = 0 // running open shares
  let cost = 0 // running cost basis of the open shares
  let realized = 0
  let lastAvg = 0
  const legs = [...entry.legs].sort((a, b) => a.at - b.at)
  for (const leg of legs) {
    if (leg.at < firstAt) firstAt = leg.at
    if (leg.at > lastAt) lastAt = leg.at
    if (leg.side === 'buy') {
      buyQty += leg.quantity
      totalBought += leg.quantity * leg.price
      cost += leg.quantity * leg.price
      qty += leg.quantity
      if (qty > 0) lastAvg = cost / qty
    } else {
      sellQty += leg.quantity
      totalSold += leg.quantity * leg.price
      const avg = qty > 0 ? cost / qty : lastAvg
      const q = Math.min(leg.quantity, Math.max(qty, 0))
      realized += leg.quantity * leg.price - q * avg
      cost -= q * avg
      qty -= leg.quantity
    }
  }
  const openShares = buyQty - sellQty
  const avgBuy = qty > 0 ? cost / qty : lastAvg
  return {
    buyQty,
    sellQty,
    openShares,
    avgBuy,
    totalBought,
    totalSold,
    realized,
    openCost: Math.max(0, cost),
    status: openShares > 1e-6 ? 'open' : 'closed',
    firstAt,
    lastAt
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const file = join(moduleDir, 'snapshots.json')

  /** Read + migrate. Older entries stored a single price/boughtAt/bars; convert
   *  that to a one-buy ledger so they keep working (quantity unknown → 0). */
  const readEntries = (): TradeNowEntry[] => {
    let raw: unknown[]
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
      raw = Array.isArray(j.entries) ? j.entries : []
    } catch {
      return []
    }
    return raw.map((e) => {
      const o = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>
      const legs = Array.isArray(o.legs) ? (o.legs as TradeLeg[]) : []
      const createdAt = num(o.createdAt) || num(o.boughtAt) || Date.now()
      if (legs.length === 0 && (typeof o.price === 'number' || typeof o.boughtAt === 'number')) {
        legs.push({
          id: legId(),
          side: 'buy',
          price: typeof o.price === 'number' ? o.price : 0,
          quantity: 0,
          at: createdAt
        })
      }
      return {
        id: String(o.id ?? legId()),
        symbol: cleanSymbol(o.symbol),
        name: typeof o.name === 'string' ? o.name : String(o.symbol ?? ''),
        createdAt,
        high52: typeof o.high52 === 'number' ? o.high52 : null,
        low52: typeof o.low52 === 'number' ? o.low52 : null,
        reason: cleanNote(o.reason),
        prediction: cleanNote(o.prediction),
        legs,
        drawings: Array.isArray(o.drawings) ? (o.drawings as TrendLine[]) : []
      }
    })
  }

  const saveEntries = (entries: TradeNowEntry[]): void => {
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ entries }, null, 2), 'utf8')
  }

  const withSummary = (e: TradeNowEntry): TradeNowEntry & { summary: TradeSummary } => ({
    ...e,
    summary: summarize(e)
  })

  ctx.ipcMain.handle(`${ID}:status`, () => ({ ok: true, hasMassive: ctx.getApiKey('massive') !== null }))

  /** Create a position: capture name + 52-week range, seed the first BUY leg. */
  ctx.ipcMain.handle(`${ID}:create`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = cleanSymbol(r.symbol)
    if (!symbol) return { ok: false, error: 'Enter a ticker symbol.' }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys first.' }

    const now = Date.now()
    try {
      const [daily, recent, details] = await Promise.all([
        getAggregates(key, symbol, 1, 'day', now - 370 * DAY_MS, now),
        getAggregates(key, symbol, 1, 'hour', now - 7 * DAY_MS, now),
        getTickerDetails(key, symbol)
      ])
      if (daily.length === 0 && recent.length === 0)
        return { ok: false, error: `No data for ${symbol} — check the ticker symbol (e.g. JetBlue is JBLU).` }

      const highs = daily.map((b) => b.h).filter(Number.isFinite)
      const lows = daily.map((b) => b.l).filter(Number.isFinite)
      const marketPrice = recent[recent.length - 1]?.c ?? daily[daily.length - 1]?.c ?? 0
      const buyPrice = r.buyPrice != null && num(r.buyPrice) > 0 ? num(r.buyPrice) : marketPrice
      const quantity = Math.max(0, num(r.quantity))
      // let the user back-date the buy (entering a trade from a previous day);
      // clamp to "now" so a future date can't be recorded
      const boughtAt = num(r.at) > 0 ? Math.min(num(r.at), now) : now

      const entry: TradeNowEntry = {
        id: `tn-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        symbol,
        name: details?.name || symbol,
        createdAt: boughtAt,
        high52: highs.length ? Math.max(...highs) : null,
        low52: lows.length ? Math.min(...lows) : null,
        reason: cleanNote(r.reason),
        prediction: cleanNote(r.prediction),
        legs: [{ id: legId(), side: 'buy', price: buyPrice, quantity, at: boughtAt }],
        drawings: []
      }
      const entries = readEntries()
      entries.unshift(entry)
      saveEntries(entries)
      return { ok: true, entry: withSummary(entry) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:list`, () => ({ ok: true, entries: readEntries().map(withSummary) }))

  ctx.ipcMain.handle(`${ID}:get`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entry = readEntries().find((x) => x.id === r.id)
    return entry ? { ok: true, entry: withSummary(entry) } : { ok: false, error: 'Position not found.' }
  })

  /* ------------------------------- legs --------------------------------- */

  ctx.ipcMain.handle(`${ID}:add-leg`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    const side = r.side === 'sell' ? 'sell' : 'buy'
    const price = num(r.price)
    const quantity = num(r.quantity)
    if (price <= 0 || quantity <= 0) return { ok: false, error: 'Enter a price and quantity greater than 0.' }
    const at = num(r.at) > 0 ? num(r.at) : Date.now()
    entry.legs.push({ id: legId(), side, price, quantity, at })
    entry.legs.sort((a, b) => a.at - b.at)
    try {
      saveEntries(entries)
      return { ok: true, entry: withSummary(entry) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:update-leg`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    const leg = entry.legs.find((l) => l.id === r.legId)
    if (!leg) return { ok: false, error: 'Leg not found.' }
    if (r.side === 'buy' || r.side === 'sell') leg.side = r.side
    if (r.price != null) leg.price = num(r.price)
    if (r.quantity != null) leg.quantity = num(r.quantity)
    if (r.at != null && num(r.at) > 0) leg.at = num(r.at)
    if (leg.price <= 0 || leg.quantity <= 0) return { ok: false, error: 'Price and quantity must be greater than 0.' }
    entry.legs.sort((a, b) => a.at - b.at)
    try {
      saveEntries(entries)
      return { ok: true, entry: withSummary(entry) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:delete-leg`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    const before = entry.legs.length
    entry.legs = entry.legs.filter((l) => l.id !== r.legId)
    if (entry.legs.length === before) return { ok: false, error: 'Leg not found.' }
    try {
      saveEntries(entries)
      return { ok: true, entry: withSummary(entry) }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:set-drawings`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    const list = Array.isArray(r.drawings) ? r.drawings : []
    entry.drawings = list
      .map((d) => {
        const o = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>
        return { id: String(o.id ?? legId()), l1: num(o.l1), p1: num(o.p1), l2: num(o.l2), p2: num(o.p2) }
      })
      .filter((d) => Number.isFinite(d.p1) && Number.isFinite(d.p2))
      .slice(0, 100)
    try {
      saveEntries(entries)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:update-notes`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    if (typeof r.reason === 'string') entry.reason = cleanNote(r.reason)
    if (typeof r.prediction === 'string') entry.prediction = cleanNote(r.prediction)
    try {
      saveEntries(entries)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:delete`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const next = entries.filter((x) => x.id !== r.id)
    if (next.length === entries.length) return { ok: false, error: 'Position not found.' }
    try {
      saveEntries(next)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /**
   * Chart bars spanning the whole position (first leg → now) at an interval
   * sized to the span, plus the latest price for live P/L. Fetched on demand so
   * the chart and every leg marker stay current as the trade evolves.
   */
  ctx.ipcMain.handle(`${ID}:chart`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entry = readEntries().find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Position not found.' }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'No Massive/Polygon key.' }
    const sum = summarize(entry)
    const now = Date.now()
    const SIX_MONTHS = 183 * DAY_MS
    const spanDays = Math.max(1, (now - sum.firstAt) / DAY_MS)
    const pad = Math.max(3 * DAY_MS, spanDays * 0.08 * DAY_MS)
    // Always load at least ~6 months of history (ending now) so you can zoom/pan
    // out for context even on a brand-new position; older trades load their full
    // span. The default on-screen view still frames the trade.
    const from = Math.min(sum.firstAt - pad, now - SIX_MONTHS)
    const loadedDays = Math.max(1, (now - from) / DAY_MS)
    // interval scaled to how much we're loading, so the chart stays legible and
    // under the provider's row caps
    let mult = 1
    let timespan: 'minute' | 'hour' | 'day' = 'day'
    if (loadedDays <= 240) {
      // ≤ ~8 months → hourly (~1,000–1,500 bars): fine detail for a recent trade
      // with a full 6 months of context available on zoom-out
      mult = 1
      timespan = 'hour'
    } else if (loadedDays <= 800) {
      // ≤ ~2 years → 4-hour bars
      mult = 4
      timespan = 'hour'
    }
    try {
      const bars = await getAggregates(key, entry.symbol, mult, timespan, from, now)
      const price = bars.length ? bars[bars.length - 1].c : null
      return { ok: true, bars, price }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  // The renderer builds the printable PDF (jsPDF, incl. the chart image) and
  // sends the bytes; we save into Downloads/Trade Now so it lands somewhere that
  // exists on every machine, then reveal it.
  ctx.ipcMain.handle(`${ID}:save-pdf`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const sym = cleanSymbol(r.symbol) || 'TRADE'
    const b64 = typeof r.data === 'string' ? r.data : ''
    if (!b64) return { ok: false, error: 'No PDF data.' }
    const folder = join(ctx.app.getPath('downloads'), 'Trade Now')
    try {
      mkdirSync(folder, { recursive: true })
      const d = new Date()
      const p = (n: number): string => String(n).padStart(2, '0')
      const name = `${sym} - Trade Now - ${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}.pdf`
      const outFile = join(folder, name)
      writeFileSync(outFile, Buffer.from(b64, 'base64'))
      ctx.shell.showItemInFolder(outFile)
      return { ok: true, file: outFile }
    } catch (err) {
      return { ok: false, error: 'Could not save the PDF: ' + errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:quote`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = cleanSymbol(r.symbol)
    if (!symbol) return { ok: false, error: 'Enter a symbol.' }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'No Massive/Polygon key.' }
    try {
      const bars = await getAggregates(key, symbol, 1, 'hour', Date.now() - 7 * DAY_MS, Date.now())
      const last = bars[bars.length - 1]
      return last ? { ok: true, price: last.c, t: last.t } : { ok: false, error: 'No recent bars.' }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Positions',
      path: existsSync(file) ? file : null,
      note: 'Trade Now positions: buy/sell legs, 52-week range and notes (JSON)'
    }
  ])
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getAggregates, getTickerDetails, type Bar } from '../stock-planner/ipc/market/massive'

/**
 * TRADE NOW — a snapshot of the moment you buy a stock. Creating a snapshot
 * freezes: company name, the (15-min-delayed) price, the 52-week high/low, and
 * ~90 days of 4h chart bars ending at the purchase moment, so the chart can be
 * re-rendered later exactly as it looked with a BUY mark at your entry. The
 * "why I bought" and "prediction" notes stay editable afterwards. Everything
 * persists as plain JSON in the module folder.
 */
const ID = 'trade-now'
const NOTE_MAX = 2000
const CHART_DAYS = 90
const DAY_MS = 86_400_000

export interface TradeNowEntry {
  id: string
  symbol: string
  name: string
  /** when the snapshot was taken (= when you bought), ms epoch */
  boughtAt: number
  /** price at the snapshot moment (latest delayed bar close) */
  price: number | null
  high52: number | null
  low52: number | null
  reason: string
  prediction: string
  /** frozen 4h bars ending at the purchase moment (the marked chart) */
  bars: Bar[]
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

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const file = join(moduleDir, 'snapshots.json')

  const readEntries = (): TradeNowEntry[] => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { entries?: unknown }
      return Array.isArray(j.entries) ? (j.entries as TradeNowEntry[]) : []
    } catch {
      return [] // missing or unreadable = no snapshots yet
    }
  }

  const saveEntries = (entries: TradeNowEntry[]): void => {
    mkdirSync(moduleDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ entries }, null, 2), 'utf8')
  }

  const stripBars = (e: TradeNowEntry): Omit<TradeNowEntry, 'bars'> => {
    const { bars: _bars, ...meta } = e
    return meta
  }

  ctx.ipcMain.handle(`${ID}:status`, () => ({ ok: true, hasMassive: ctx.getApiKey('massive') !== null }))

  /** Take the snapshot: fetch everything live, freeze it into an entry. */
  ctx.ipcMain.handle(`${ID}:create`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = cleanSymbol(r.symbol)
    if (!symbol) return { ok: false, error: 'Enter a ticker symbol.' }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys first.' }

    const now = Date.now()
    try {
      const [daily, chartBars, details] = await Promise.all([
        getAggregates(key, symbol, 1, 'day', now - 370 * DAY_MS, now),
        getAggregates(key, symbol, 4, 'hour', now - CHART_DAYS * DAY_MS, now),
        getTickerDetails(key, symbol)
      ])
      if (daily.length === 0 && chartBars.length === 0)
        return { ok: false, error: `No data for ${symbol} — check the ticker symbol (e.g. JetBlue is JBLU).` }

      const highs = daily.map((b) => b.h).filter(Number.isFinite)
      const lows = daily.map((b) => b.l).filter(Number.isFinite)
      const lastChart = chartBars[chartBars.length - 1]
      const lastDaily = daily[daily.length - 1]
      const entry: TradeNowEntry = {
        id: `tn-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        symbol,
        name: details?.name || symbol,
        boughtAt: now,
        price: lastChart?.c ?? lastDaily?.c ?? null,
        high52: highs.length ? Math.max(...highs) : null,
        low52: lows.length ? Math.min(...lows) : null,
        reason: cleanNote(r.reason),
        prediction: cleanNote(r.prediction),
        bars: chartBars
      }
      const entries = readEntries()
      entries.unshift(entry)
      saveEntries(entries)
      return { ok: true, entry }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /** List all snapshots, newest first, without the (heavy) bar arrays. */
  ctx.ipcMain.handle(`${ID}:list`, () => ({ ok: true, entries: readEntries().map(stripBars) }))

  /** One full snapshot, bars included (for rendering the marked chart). */
  ctx.ipcMain.handle(`${ID}:get`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entry = readEntries().find((x) => x.id === r.id)
    return entry ? { ok: true, entry } : { ok: false, error: 'Snapshot not found.' }
  })

  ctx.ipcMain.handle(`${ID}:update-notes`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const entries = readEntries()
    const entry = entries.find((x) => x.id === r.id)
    if (!entry) return { ok: false, error: 'Snapshot not found.' }
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
    if (next.length === entries.length) return { ok: false, error: 'Snapshot not found.' }
    try {
      saveEntries(next)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /** Latest (delayed) price for "now vs. when I bought" on the review screen. */
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
      label: 'Buy snapshots',
      path: existsSync(file) ? file : null,
      note: 'Frozen buy-moment snapshots with notes (JSON)'
    }
  ])
}

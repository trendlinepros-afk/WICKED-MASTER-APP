import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getAggregates } from '../stock-planner/ipc/market/massive'

/**
 * ADVANCED CHARTS — a multi-chart candlestick workspace rendered in the
 * renderer with Lightweight Charts (MIT), fed by the same Massive/Polygon
 * market data the rest of the Stocks tools use. Timeframes are CANDLE
 * DURATIONS (1m … weekly, defaulting to 4h in the UI); each carries its own
 * lookback window sized to yield a usable number of bars. Per-ticker chart
 * notes persist in the module folder as plain JSON.
 */
const ID = 'advanced-charts'
const NOTE_MAX = 500

interface Timeframe {
  mult: number
  timespan: 'minute' | 'hour' | 'day' | 'week'
  days: number
}

/** Candle duration → aggregate params + how far back to fetch. */
const TIMEFRAMES: Record<string, Timeframe> = {
  '1m': { mult: 1, timespan: 'minute', days: 2 },
  '5m': { mult: 5, timespan: 'minute', days: 7 },
  '15m': { mult: 15, timespan: 'minute', days: 15 },
  '30m': { mult: 30, timespan: 'minute', days: 30 },
  '1h': { mult: 1, timespan: 'hour', days: 60 },
  '2h': { mult: 2, timespan: 'hour', days: 90 },
  '4h': { mult: 4, timespan: 'hour', days: 180 },
  '1D': { mult: 1, timespan: 'day', days: 380 },
  '1W': { mult: 1, timespan: 'week', days: 1830 }
}

function cleanSymbol(v: unknown): string {
  return typeof v === 'string' ? v.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10) : ''
}

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const notesFile = join(moduleDir, 'ticker-notes.json')

  const readNotes = (): Record<string, string> => {
    try {
      const j = JSON.parse(readFileSync(notesFile, 'utf8')) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(j)) {
        const sym = cleanSymbol(k)
        if (sym && typeof v === 'string' && v.trim()) out[sym] = v.slice(0, NOTE_MAX)
      }
      return out
    } catch {
      return {} // missing or unreadable = no notes yet
    }
  }

  ctx.ipcMain.handle(`${ID}:status`, () => {
    const hasMassive = ctx.getApiKey('massive') !== null
    return { ok: true, hasMassive, configured: hasMassive }
  })

  ctx.ipcMain.handle(`${ID}:candles`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = cleanSymbol(r.symbol)
    const tfKey = typeof r.timeframe === 'string' && TIMEFRAMES[r.timeframe] ? r.timeframe : '4h'
    if (!symbol) return { ok: false, error: 'Enter a symbol.', bars: [] }
    const key = ctx.getApiKey('massive')
    if (!key) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys to load charts.', bars: [] }
    const tf = TIMEFRAMES[tfKey]
    const to = Date.now()
    const from = to - tf.days * 86_400_000
    try {
      const bars = await getAggregates(key, symbol, tf.mult, tf.timespan, from, to)
      return {
        ok: true,
        bars,
        timeframe: tfKey,
        ...(bars.length === 0
          ? { note: `No ${tfKey} data for ${symbol} — unknown symbol, or your plan/market hours have no bars yet.` }
          : {})
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), bars: [] }
    }
  })

  /* ------------------------- per-ticker chart notes ------------------------ */

  ctx.ipcMain.handle(`${ID}:notes-get`, () => ({ ok: true, notes: readNotes() }))

  ctx.ipcMain.handle(`${ID}:note-set`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = cleanSymbol(r.symbol)
    if (!symbol) return { ok: false, error: 'A symbol is required.' }
    const text = typeof r.text === 'string' ? r.text.slice(0, NOTE_MAX) : ''
    const notes = readNotes()
    if (text.trim()) notes[symbol] = text
    else delete notes[symbol]
    try {
      mkdirSync(moduleDir, { recursive: true })
      writeFileSync(notesFile, JSON.stringify(notes, null, 2), 'utf8')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Ticker notes',
      path: existsSync(notesFile) ? notesFile : null,
      note: 'Per-ticker chart notes (JSON)'
    }
  ])
}

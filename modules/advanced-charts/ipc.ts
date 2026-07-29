import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getAggregates } from '../stock-planner/ipc/market/massive'

/**
 * ADVANCED CHARTS — a self-contained candlestick chart rendered in the renderer
 * with Lightweight Charts (MIT), fed by the same Massive/Polygon market data the
 * rest of the Stocks tools use. No licensed TradingView library or local chart
 * server is required: if the Massive key is set, charts work out of the box.
 */
const ID = 'advanced-charts'

interface Timeframe {
  mult: number
  timespan: 'minute' | 'day'
  days: number
}
const TIMEFRAMES: Record<string, Timeframe> = {
  '1D': { mult: 1, timespan: 'minute', days: 2 },
  '5D': { mult: 5, timespan: 'minute', days: 7 },
  '1M': { mult: 1, timespan: 'day', days: 40 },
  '3M': { mult: 1, timespan: 'day', days: 100 },
  '1Y': { mult: 1, timespan: 'day', days: 380 }
}

export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle(`${ID}:status`, () => {
    const hasMassive = ctx.getApiKey('massive') !== null
    return { ok: true, hasMassive, configured: hasMassive }
  })

  ctx.ipcMain.handle(`${ID}:candles`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '') : ''
    const tfKey = typeof r.timeframe === 'string' && TIMEFRAMES[r.timeframe] ? r.timeframe : '1D'
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

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [])
}

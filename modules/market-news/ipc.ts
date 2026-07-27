import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
// Shared stock market-data layer lives in the stock-planner module; this
// module deliberately reuses it (one Finnhub client + cache, not two).
import { getCompanyNews, getGeneralNews } from '../stock-planner/ipc/market/finnhub'

/**
 * MARKET NEWS — the ported dashboard news card as its own tool. Market-wide
 * Finnhub headlines, cached until the 6:00 AM ET rollover; optional per-ticker
 * filter reuses the company-news endpoint.
 */
const ID = 'market-news'

export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle(`${ID}:news`, async (_e, rawSym: unknown) => {
    const key = ctx.getApiKey('finnhub')
    if (!key)
      return { ok: false, error: 'Add your Finnhub key in Settings → API Keys to load market news.' }
    const sym = typeof rawSym === 'string' ? rawSym.trim().toUpperCase() : ''
    try {
      const rows = sym ? await getCompanyNews(key, sym) : await getGeneralNews(key)
      return { ok: true, rows }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [])
}

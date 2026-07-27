import { existsSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { chartServerUrl, startChartServer } from './ipc/server'

/**
 * ADVANCED CHARTS — main process. The TradingView Charting Library is licensed
 * and NOT bundled: the user requests free access at
 * tradingview.com/advanced-charts, downloads the charting_library folder, and
 * points the module at it. Until then the UI shows setup instructions instead
 * of breaking (ported behavior).
 */
const ID = 'advanced-charts'
const LIB_KEY = `${ID}.libraryPath`

const LIB_MAIN_JS = 'charting_library.standalone.js'

export default function register(ctx: ModuleIpcContext): void {
  const layoutsDir = join(ctx.app.getPath('userData'), 'modules', ID, 'layouts')

  const libraryPath = (): string => {
    const v = ctx.storeGet<string>(LIB_KEY, '')
    return typeof v === 'string' ? v : ''
  }
  const libraryValid = (dir: string): boolean => !!dir && existsSync(join(dir, LIB_MAIN_JS))

  ctx.ipcMain.handle(`${ID}:status`, () => {
    const lib = libraryPath()
    return {
      ok: true,
      libraryPath: lib || null,
      configured: libraryValid(lib),
      hasMassive: !!ctx.getApiKey('massive'),
      url: chartServerUrl() || null
    }
  })

  ctx.ipcMain.handle(`${ID}:set-library-path`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Locate your TradingView charting_library folder',
      properties: ['openDirectory' as const]
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    let dir = res.filePaths[0]
    // accept the parent folder too (user picked the repo root)
    if (!libraryValid(dir) && libraryValid(join(dir, 'charting_library'))) dir = join(dir, 'charting_library')
    if (!libraryValid(dir))
      return {
        ok: false,
        error: `That folder has no ${LIB_MAIN_JS}. Pick the charting_library folder from TradingView's Advanced Charts download.`
      }
    ctx.storeSet(LIB_KEY, dir)
    return { ok: true, libraryPath: dir }
  })

  ctx.ipcMain.handle(`${ID}:start`, async () => {
    const lib = libraryPath()
    if (!libraryValid(lib))
      return {
        ok: false,
        error:
          'The charting library is not set up yet. Request free access at tradingview.com/advanced-charts, download it, then click "Locate library…".'
      }
    try {
      const { url } = await startChartServer({
        getMassiveKey: () => ctx.getApiKey('massive'),
        libraryPath,
        layoutsDir
      })
      return { ok: true, url }
    } catch (err) {
      return { ok: false, error: 'Could not start the chart host: ' + (err instanceof Error ? err.message : String(err)) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Charting library',
      path: libraryValid(libraryPath()) ? libraryPath() : null,
      note: 'Licensed TradingView folder you downloaded (not bundled with WICKED)'
    },
    {
      label: 'Saved layouts',
      path: existsSync(layoutsDir) ? layoutsDir : null,
      note: 'Chart layouts incl. drawings (JSON, 8MB cap each)'
    }
  ])
}

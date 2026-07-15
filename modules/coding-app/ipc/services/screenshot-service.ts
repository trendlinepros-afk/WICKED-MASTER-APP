import { BrowserWindow } from 'electron'
import { previewManager } from './preview-manager'
import { logger } from './logger'

/**
 * Captures a PNG screenshot of the running live preview by loading its URL in a
 * hidden, offscreen BrowserWindow and calling `capturePage()`. Returns the PNG
 * as a base64 string (no data-URI prefix). Never retries automatically.
 */
export class ScreenshotService {
  async capture(): Promise<{ base64: string } | { error: string }> {
    const status = previewManager.getStatus()
    if (!status.running || !status.url) {
      return { error: 'Live preview is not running. Start it first.' }
    }
    let win: BrowserWindow | null = null
    try {
      win = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: { offscreen: true }
      })
      await win.loadURL(status.url)
      // Allow the page to settle (fonts, layout, async content).
      await delay(1200)
      const image = await win.webContents.capturePage()
      const png = image.toPNG()
      return { base64: png.toString('base64') }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Screenshot capture failed', message)
      return { error: `Screenshot failed: ${message}` }
    } finally {
      win?.destroy()
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const screenshotService = new ScreenshotService()

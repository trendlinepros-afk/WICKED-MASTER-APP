import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getApiKey } from './api-keys'
import { onBackupFlush } from './backup-flush'
import { recordingIpcMain } from './mcp/channel-registry'
import { moduleStoreGet, moduleStoreSet } from './settings'

/**
 * Render an HTML document in a hidden window and print it to PDF bytes
 * (Chromium's real layout engine — tables, SVG charts and CSS come out
 * exactly as rendered). Shell-owned so modules never create BrowserWindows
 * themselves; they just hand over a self-contained HTML string.
 */
async function printHtmlToPdf(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(app.getPath('temp'), 'wicked-pdf-'))
  const file = join(dir, 'print.html')
  try {
    writeFileSync(file, html, 'utf8')
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    throw err
  }
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
  })
  try {
    // loadFile resolves on did-finish-load, which a hung subresource can stall
    // forever — race a timeout so the hidden window/renderer can't leak.
    await Promise.race([
      win.loadFile(file),
      new Promise((_r, reject) => setTimeout(() => reject(new Error('PDF render timed out')), 20_000))
    ])
    // give layout/fonts a beat to settle before printing
    await new Promise((r) => setTimeout(r, 300))
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.45, bottom: 0.55, left: 0.4, right: 0.4 },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;text-align:center;font-size:8px;color:#8a93a3;font-family:system-ui"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    })
  } finally {
    win.destroy()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

/**
 * Context handed to every module's ipc.ts register() function.
 * Modules must namespace channels as `<module-id>:<action>`.
 */
export interface ModuleIpcContext {
  ipcMain: typeof ipcMain
  app: typeof app
  shell: typeof shell
  dialog: typeof dialog
  getMainWindow: () => BrowserWindow | null
  /** simple persistence shared across modules (electron-store), key = `<module-id>.<key>` */
  storeGet: <T>(key: string, fallback: T) => T
  storeSet: (key: string, value: unknown) => void
  /**
   * Central API key vault (Settings → API Keys). Returns the decrypted key or
   * null if unset. Modules must use this instead of storing provider keys
   * themselves, and must never forward the value to the renderer.
   */
  getApiKey: (provider: string) => string | null
  /**
   * Render a self-contained HTML string to PDF bytes in a hidden shell-owned
   * window (real Chromium layout: CSS, tables, inline SVG). Use for
   * export-to-PDF features where jsPDF hand-layout would butcher rich content.
   */
  printHtmlToPdf: (html: string) => Promise<Buffer>
  /**
   * Register a synchronous flush run right before Backup/Cloud Sync read files
   * (e.g. `db.pragma('wal_checkpoint(TRUNCATE)')` for a WAL SQLite database) so
   * on-disk state is consistent when captured.
   */
  onBackupFlush: (fn: () => void) => void
}

type RegisterFn = (ctx: ModuleIpcContext) => void

// Build-time scan: any modules/<id>/ipc.ts is bundled and registered automatically.
const ipcModules = import.meta.glob<{ default: RegisterFn }>('@modules/*/ipc.ts', {
  eager: true
})

export function registerModuleIpc(getMainWindow: () => BrowserWindow | null): string[] {
  const ctx: ModuleIpcContext = {
    // recording proxy: captures each module's channel->handler so MCP tools can
    // call the same function the UI calls (see mcp/channel-registry.ts)
    ipcMain: recordingIpcMain(),
    app,
    shell,
    dialog,
    getMainWindow,
    storeGet: moduleStoreGet,
    storeSet: moduleStoreSet,
    getApiKey,
    printHtmlToPdf,
    onBackupFlush
  }
  const registered: string[] = []
  for (const [path, mod] of Object.entries(ipcModules)) {
    try {
      mod.default(ctx)
      registered.push(path)
    } catch (err) {
      // one broken module must not take down the shell
      console.error(`[wicked] failed to register module ipc: ${path}`, err)
    }
  }
  return registered
}

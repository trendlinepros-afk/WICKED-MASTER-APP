import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { getApiKey } from './api-keys'
import { recordingIpcMain } from './mcp/channel-registry'
import { moduleStoreGet, moduleStoreSet } from './settings'

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
    getApiKey
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

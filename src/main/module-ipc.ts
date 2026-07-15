import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
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
}

type RegisterFn = (ctx: ModuleIpcContext) => void

// Build-time scan: any modules/<id>/ipc.ts is bundled and registered automatically.
const ipcModules = import.meta.glob<{ default: RegisterFn }>('@modules/*/ipc.ts', {
  eager: true
})

export function registerModuleIpc(getMainWindow: () => BrowserWindow | null): string[] {
  const ctx: ModuleIpcContext = {
    ipcMain,
    app,
    shell,
    dialog,
    getMainWindow,
    storeGet: moduleStoreGet,
    storeSet: moduleStoreSet
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

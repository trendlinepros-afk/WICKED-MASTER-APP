import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

/**
 * Records every module IPC handler as it registers, so the MCP layer can call
 * the exact same function the renderer's `invoke` would hit — no duplicated
 * logic between UI-triggered and MCP-triggered actions.
 *
 * Every module obtains ipcMain from `ctx.ipcMain`, so wrapping that one object
 * captures all module handlers without touching any module code.
 */
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const handlers = new Map<string, InvokeHandler>()
let getWin: () => BrowserWindow | null = () => null

export function setMainWindowGetter(fn: () => BrowserWindow | null): void {
  getWin = fn
}

/**
 * Patch ipcMain.handle ONCE so EVERY handler (shell channels + modules) is
 * recorded, not just the module ones that go through recordingIpcMain. The web
 * server's remote bridge needs to invoke shell channels too. Call before the
 * first ipcMain.handle in the app.
 */
let globalInstalled = false
export function installGlobalRecorder(): void {
  if (globalInstalled) return
  globalInstalled = true
  const orig = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: InvokeHandler) => {
    // record only AFTER Electron accepts it — a duplicate-channel throw must
    // not leave the map pointing at a handler Electron never registered
    const out = orig(channel, listener as Parameters<typeof orig>[1])
    handlers.set(channel, listener)
    return out
  }) as typeof ipcMain.handle
  const origRemove = ipcMain.removeHandler.bind(ipcMain)
  ipcMain.removeHandler = ((channel: string) => {
    handlers.delete(channel)
    return origRemove(channel)
  }) as typeof ipcMain.removeHandler
}

/** A drop-in replacement for `ipcMain` that also records `.handle` registrations. */
export function recordingIpcMain(): typeof ipcMain {
  return new Proxy(ipcMain, {
    get(target, prop, receiver) {
      if (prop === 'handle') {
        return (channel: string, listener: InvokeHandler): void => {
          target.handle(channel, listener as Parameters<typeof target.handle>[1])
          handlers.set(channel, listener)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

export function hasChannel(channel: string): boolean {
  return handlers.has(channel)
}

/**
 * Invoke a registered channel handler in-process. The synthetic event carries
 * the main window's webContents as `sender` (null when the window is closed or
 * destroyed — handlers already null-guard their sends).
 */
export async function invokeChannel(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`)
  const w = getWin()
  const sender = w && !w.isDestroyed() ? w.webContents : null
  const event = { sender, frameId: 0, processId: 0 } as unknown as IpcMainInvokeEvent
  return await handler(event, ...args)
}

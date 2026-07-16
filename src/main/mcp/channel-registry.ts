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

/** A drop-in replacement for `ipcMain` that also records `.handle` registrations. */
export function recordingIpcMain(): typeof ipcMain {
  return new Proxy(ipcMain, {
    get(target, prop, receiver) {
      if (prop === 'handle') {
        return (channel: string, listener: InvokeHandler): void => {
          handlers.set(channel, listener)
          target.handle(channel, listener as Parameters<typeof target.handle>[1])
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

export function registeredChannels(): string[] {
  return [...handlers.keys()]
}

/**
 * Invoke a registered channel handler in-process. The synthetic event carries
 * the main window's webContents as `sender`, so handlers that stream progress
 * back via `event.sender.send(...)` still reach the UI, exactly as when the
 * user triggers the action.
 */
export async function invokeChannel(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`)
  const sender = getWin()?.webContents ?? null
  const event = { sender, frameId: 0, processId: 0 } as unknown as IpcMainInvokeEvent
  return await handler(event, ...args)
}

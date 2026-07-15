/**
 * Renderer push — the module runs inside the WICKED shell's single window, so
 * push events go through the ModuleIpcContext window getter instead of
 * BrowserWindow.getAllWindows(). register() wires the getter at startup.
 */
import type { BrowserWindow } from 'electron'

let getWin: () => BrowserWindow | null = () => null

export function setWindowGetter(fn: () => BrowserWindow | null): void {
  getWin = fn
}

export function sendToRenderer(channel: string, payload: unknown): void {
  const win = getWin()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

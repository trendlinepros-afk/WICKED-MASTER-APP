import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Single bridge for shell + all modules.
 * Modules call their own namespaced channels through invoke/on.
 */
const api = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: unknown[]) => void): (() => void) => {
    const wrapped = (_e: IpcRendererEvent, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  /** Absolute path of a dropped/picked File (Electron removed File.path). */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('wicked', api)

export type WickedApi = typeof api

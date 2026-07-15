import { BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { SHELL_IPC, type UpdateEvent } from '@shared/types'
import { getSettings } from './settings'

const { autoUpdater } = electronUpdater

let timer: NodeJS.Timeout | null = null

function send(win: BrowserWindow, ev: UpdateEvent): void {
  if (!win.isDestroyed()) win.webContents.send(SHELL_IPC.updateEvent, ev)
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    const w = getWin()
    if (w) send(w, { kind: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    const w = getWin()
    if (w) send(w, { kind: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    const w = getWin()
    if (w) send(w, { kind: 'none' })
  })
  autoUpdater.on('update-downloaded', (info) => {
    const w = getWin()
    if (w) send(w, { kind: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    const w = getWin()
    // Update-feed failures must never break the app — surface quietly and move on.
    if (w) send(w, { kind: 'error', message: err?.message ?? String(err) })
  })

  ipcMain.handle(SHELL_IPC.updateCheck, () => checkNow())
  ipcMain.handle(SHELL_IPC.updateInstall, () => autoUpdater.quitAndInstall())
  ipcMain.handle(SHELL_IPC.updatePostpone, () => {
    // nothing to cancel — the downloaded update installs on next quit
    return true
  })

  scheduleChecks()
}

export function checkNow(): void {
  autoUpdater.checkForUpdates().catch(() => {
    /* offline or feed unreachable — the error event above already reported it */
  })
}

export function scheduleChecks(): void {
  if (timer) clearInterval(timer)
  const { autoCheck, intervalHours } = getSettings().update
  if (!autoCheck) return
  // check shortly after launch, then periodically
  setTimeout(checkNow, 10_000)
  timer = setInterval(checkNow, Math.max(1, intervalHours) * 3_600_000)
}

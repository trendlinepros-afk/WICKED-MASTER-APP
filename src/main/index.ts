import './paths' // must be first — pins userData before any store/module loads
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { realpathSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SHELL_IPC, type ShellSettings } from '@shared/types'
import { registerApiKeyIpc } from './api-keys'
import { setMainWindowGetter } from './mcp/channel-registry'
import { getMcpStatus, setMcpEnabled, stopMcpServer } from './mcp/server'
import { getSettings, setSettings } from './settings'
import { initUpdater, scheduleChecks } from './updater'
import { registerModuleIpc } from './module-ipc'

// Chromium's GPU child process cannot launch when Electron runs from a network
// share (dev happens on the NAS; mapped drives resolve to UNC). Run the GPU
// in-process with software rendering there — packaged installs run from C:\
// and keep the normal GPU path.
try {
  if (realpathSync.native(process.execPath).startsWith('\\\\')) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('in-process-gpu')
  }
} catch {
  /* path resolution failed — leave GPU defaults alone */
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    title: 'WICKED',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // coding-app module hosts its live preview in a <webview>
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.wickedrc.wicked')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // shell IPC
  ipcMain.handle(SHELL_IPC.settingsGet, () => getSettings())
  ipcMain.handle(SHELL_IPC.settingsSet, (_e, patch: Partial<ShellSettings>) => {
    const next = setSettings(patch)
    scheduleChecks() // update prefs may have changed
    return next
  })
  ipcMain.handle(SHELL_IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  ipcMain.handle(SHELL_IPC.appVersion, () => app.getVersion())

  registerApiKeyIpc(() => mainWindow)

  // MCP: the channel registry needs the main window for synthetic-event senders
  setMainWindowGetter(() => mainWindow)
  ipcMain.handle(SHELL_IPC.mcpStatus, () => getMcpStatus())
  ipcMain.handle(SHELL_IPC.mcpSetEnabled, async (_e, value: boolean) => {
    const status = await setMcpEnabled(value)
    setSettings({ mcpEnabled: status.enabled })
    return status
  })

  // module IPC (auto-registered from modules/*/ipc.ts) — must run before the MCP
  // server builds its tool list, so the channel registry is populated.
  const registered = registerModuleIpc(() => mainWindow)
  console.log(`[wicked] registered module ipc: ${registered.length}`)

  // start the MCP server if the user left it enabled last session
  if (getSettings().mcpEnabled) setMcpEnabled(true)

  initUpdater(() => mainWindow)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopMcpServer()
})

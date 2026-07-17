import './paths' // must be first — pins userData before any store/module loads
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { realpathSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SHELL_IPC, type ShellSettings } from '@shared/types'
import { registerApiKeyIpc } from './api-keys'
import { hasChannel, invokeChannel, setMainWindowGetter } from './mcp/channel-registry'
import { getMcpStatus, setMcpEnabled, stopMcpServer } from './mcp/server'
import { getSettings, setSettings } from './settings'
import { initUpdater, scheduleChecks } from './updater'
import { registerModuleIpc } from './module-ipc'
import { registerRecoveryIpc } from './recovery'
import { registerBackupIpc, scheduleBackups } from './backup'

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
/** module id -> its standalone window (one per module) */
const moduleWindows = new Map<string, BrowserWindow>()

const sharedWebPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false,
  contextIsolation: true,
  nodeIntegration: false,
  // coding-app module hosts its live preview in a <webview>
  webviewTag: true
}

/** Load the renderer into `win`, optionally at a specific hash route. */
function loadRenderer(win: BrowserWindow, hash?: string): void {
  const suffix = hash ? `#${hash}` : ''
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${suffix}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
}

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
    webPreferences: sharedWebPreferences
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

/** Open (or focus) a standalone window rendering just one module at /w/:id. */
function openModuleWindow(id: string): void {
  const existing = moduleWindows.get(id)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    title: 'WICKED',
    webPreferences: sharedWebPreferences
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.on('closed', () => moduleWindows.delete(id))
  moduleWindows.set(id, win)
  loadRenderer(win, `/w/${id}`)
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
    if (patch.backup) scheduleBackups() // backup schedule may have changed
    return next
  })
  ipcMain.handle(SHELL_IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  ipcMain.handle(SHELL_IPC.appVersion, () => app.getVersion())
  ipcMain.handle(SHELL_IPC.openModuleWindow, (_e, id: string) => openModuleWindow(String(id)))

  // A module's file/data locations for the Settings dropdown. A module opts in by
  // registering `<module-id>:data-paths`; otherwise there's nothing to show.
  ipcMain.handle(SHELL_IPC.moduleDataPaths, async (_e, id: string) => {
    const ch = `${String(id)}:data-paths`
    if (!hasChannel(ch)) return []
    try {
      return await invokeChannel(ch)
    } catch {
      return []
    }
  })

  registerApiKeyIpc(() => mainWindow)
  registerRecoveryIpc(() => mainWindow)
  registerBackupIpc(() => mainWindow)

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

  // start the scheduled-backup timer if the user enabled it
  scheduleBackups()

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

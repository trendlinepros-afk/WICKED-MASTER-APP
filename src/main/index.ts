import './paths' // must be first — pins userData before any store/module loads
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { realpathSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SHELL_IPC, type ShellSettings } from '@shared/types'
import { registerApiKeyIpc } from './api-keys'
import { hasChannel, installGlobalRecorder, invokeChannel, setMainWindowGetter } from './mcp/channel-registry'
import { getMcpStatus, setMcpEnabled, stopMcpServer } from './mcp/server'
import { broadcastToWeb, registerWebServerIpc, stopWebServer } from './webserver'
import { getSettings, setSettings } from './settings'
import { initUpdater, scheduleChecks } from './updater'
import { registerModuleIpc } from './module-ipc'
import { registerRecoveryIpc } from './recovery'
import { registerBackupIpc, scheduleBackups } from './backup'
import { pushNow, registerSyncIpc, scheduleSync, shouldPushOnClose } from './sync'

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
  // Null the shared reference on close: standalone module windows keep the app
  // alive, and every getMainWindow()?.webContents.send would otherwise throw
  // "Object has been destroyed" from async module callbacks.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Mirror every event the desktop window receives to any connected web-server
  // browser client. Modules push progress via getMainWindow().webContents.send
  // and handlers via event.sender.send — both hit THIS webContents.send, so
  // wrapping it once fans every event out to the LAN clients too.
  const wc = mainWindow.webContents as unknown as {
    send: (channel: string, ...args: unknown[]) => void
  }
  const origSend = wc.send.bind(wc)
  wc.send = (channel: string, ...args: unknown[]): void => {
    origSend(channel, ...args)
    try {
      broadcastToWeb(channel, args)
    } catch {
      /* never let mirroring break a desktop event */
    }
  }

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

  // Record EVERY ipcMain.handle (shell + modules) so the web-server bridge can
  // invoke any channel. Must run before the first handle below.
  installGlobalRecorder()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Defense in depth for every webContents (windows AND <webview>s): strip any
  // preload/nodeIntegration a webview tag might request, and block in-place
  // top-level navigation away from the app (which would hand a remote page the
  // window.wicked bridge). setWindowOpenHandler only covers NEW windows.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (_ev, webPreferences) => {
      delete (webPreferences as { preload?: string }).preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
    })
    contents.on('will-navigate', (ev, url) => {
      const devOrigin = process.env['ELECTRON_RENDERER_URL'] ?? ''
      const allowed = url.startsWith('file://') || (devOrigin && url.startsWith(devOrigin))
      // only guard top-level app windows — webview guests navigate freely
      if (!allowed && contents.getType() === 'window') ev.preventDefault()
    })
  })

  // shell IPC
  ipcMain.handle(SHELL_IPC.settingsGet, () => getSettings())
  ipcMain.handle(SHELL_IPC.settingsSet, (_e, patch: Partial<ShellSettings>) => {
    const next = setSettings(patch)
    if (patch.update) scheduleChecks() // update prefs changed
    if (patch.backup) scheduleBackups() // backup schedule may have changed
    return next
  })
  ipcMain.handle(SHELL_IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
  ipcMain.handle(SHELL_IPC.appVersion, () => app.getVersion())
  ipcMain.handle(SHELL_IPC.openModuleWindow, (_e, id: string) => {
    // renderer/LAN-bridge input: sane id shape + a cap so a loop can't spawn
    // unbounded blank windows
    const clean = String(id)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clean) || moduleWindows.size >= 20) return
    openModuleWindow(clean)
  })

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
  registerSyncIpc(() => mainWindow)
  // LAN web server (Settings → Web Server; OFF by default, auto-starts here only
  // if the user left it enabled last run and a password is set)
  registerWebServerIpc()

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
  // start the cloud-sync auto-push timer if the user enabled it
  scheduleSync()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  // a throw during startup must not leave a silent, windowless process
  console.error('[wicked] startup failed:', err)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dialog } = require('electron') as typeof import('electron')
    dialog.showErrorBox('WICKED failed to start', String(err))
  } catch {
    /* headless */
  }
  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  // log instead of crashing main on a stray module promise
  console.error('[wicked] unhandled rejection:', reason)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let closingPushDone = false
app.on('before-quit', (e) => {
  // "Sync app on close": push one last snapshot, then really quit. app.exit(0)
  // bypasses before-quit, so this runs at most once. 20s network cap so a hung
  // connection can't wedge the quit; a failed/timed-out push is persisted by
  // sync.ts (lastPushError) and warned about in the Cloud Sync panel.
  if (!closingPushDone && shouldPushOnClose()) {
    e.preventDefault()
    closingPushDone = true
    Promise.race([
      pushNow('auto').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 20_000))
    ]).finally(() => {
      stopMcpServer()
      stopWebServer()
      app.exit(0)
    })
    return
  }
  stopMcpServer()
  stopWebServer()
})

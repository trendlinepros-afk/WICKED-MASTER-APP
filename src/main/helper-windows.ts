import { app, BrowserWindow, globalShortcut } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Shell-owned services for modules that need to reach outside their page:
 *
 *  - system-wide hotkeys (globalShortcut) with bookkeeping, so they are all
 *    released on quit and a module can re-bind without leaking the old one;
 *  - "helper windows": a frameless overlay drawn on top of a monitor (screen
 *    pickers, a recording pill) or a hidden worker page (e.g. a MediaRecorder
 *    that must keep running while the user is elsewhere in the app).
 *
 * Modules never construct BrowserWindows or call globalShortcut themselves;
 * they hand the shell a self-contained HTML string (inline CSS/JS) — the same
 * pattern as printHtmlToPdf. Helper pages get the normal preload bridge
 * (window.wicked.invoke/on), so they talk to their module's ipc.ts handlers
 * over `<module-id>:<action>` channels; handlers can recognise a helper by
 * comparing `event.sender.id` with `HelperWindow.id`.
 */

export interface HelperBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface HelperWindowOptions {
  /** self-contained HTML document (inline CSS/JS only — no remote content) */
  html: string
  /** DIP bounds; for an overlay usually a Display's `bounds` */
  bounds: HelperBounds
  /** see-through background (overlays); default false */
  transparent?: boolean
  /** above everything incl. the taskbar; default false */
  alwaysOnTop?: boolean
  /** may take keyboard focus; default false (clicks still work) */
  focusable?: boolean
  /** mouse passes through to the windows below; default false */
  clickThrough?: boolean
  /**
   * Hide this window from screenshots and screen recordings (Windows 10 2004+
   * WDA_EXCLUDEFROMCAPTURE). It stays visible on the monitor.
   */
  excludeFromCapture?: boolean
}

export interface HelperWindow {
  /** webContents id — compare with `IpcMainInvokeEvent.sender.id` */
  readonly id: number
  /** resolves once the page has loaded (its window.wicked.on listeners exist) */
  readonly ready: Promise<void>
  send: (channel: string, ...args: unknown[]) => void
  show: (opts?: { focus?: boolean }) => void
  hide: () => void
  setBounds: (bounds: HelperBounds) => void
  close: () => void
  isAlive: () => boolean
  onClosed: (fn: () => void) => void
}

const helpers = new Set<BrowserWindow>()

export function isHelperWindow(win: BrowserWindow): boolean {
  return helpers.has(win)
}

/** Close every helper window (the shell calls this when the last real window closes). */
export function closeAllHelperWindows(): void {
  for (const w of [...helpers]) {
    try {
      if (!w.isDestroyed()) w.destroy()
    } catch {
      /* already gone */
    }
  }
  helpers.clear()
}

function applyBounds(win: BrowserWindow, b: HelperBounds): void {
  const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) }
  // Windows + mixed-DPI monitors: the first setBounds after a window crosses
  // onto a monitor with a different scale factor sizes it with the old
  // factor. Applying twice lands it exactly.
  win.setBounds(r)
  win.setBounds(r)
}

export function createHelperWindow(opts: HelperWindowOptions): HelperWindow {
  const dir = mkdtempSync(join(app.getPath('temp'), 'wicked-helper-'))
  const file = join(dir, 'index.html')
  writeFileSync(file, opts.html, 'utf8')

  const win = new BrowserWindow({
    x: Math.round(opts.bounds.x),
    y: Math.round(opts.bounds.y),
    width: Math.max(1, Math.round(opts.bounds.width)),
    height: Math.max(1, Math.round(opts.bounds.height)),
    show: false,
    frame: false,
    transparent: !!opts.transparent,
    backgroundColor: opts.transparent ? '#00000000' : '#111318',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: !!opts.focusable,
    alwaysOnTop: !!opts.alwaysOnTop,
    title: 'WICKED',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // a hidden worker (recorder) must not be throttled while it's not shown
      backgroundThrottling: false,
      // helper pages may run WebAudio without a click (level meters, mixing)
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false
    }
  })
  helpers.add(win)
  win.setMenu(null)
  if (opts.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
  if (opts.excludeFromCapture) win.setContentProtection(true)
  if (opts.clickThrough) win.setIgnoreMouseEvents(true, { forward: true })
  applyBounds(win, opts.bounds)

  // helper pages are local-only: no popups, no navigation away
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  const id = win.webContents.id
  const closedFns: (() => void)[] = []
  win.on('closed', () => {
    helpers.delete(win)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* temp cleanup is best-effort */
    }
    for (const fn of closedFns) {
      try {
        fn()
      } catch (err) {
        console.error('[wicked] helper window onClosed handler failed', err)
      }
    }
  })

  const ready = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
    win.once('closed', () => resolve())
  })
  void win.loadFile(file).catch((err) => console.error('[wicked] helper window failed to load', err))

  const alive = (): boolean => !win.isDestroyed()
  return {
    id,
    ready,
    send: (channel, ...args) => {
      if (alive()) win.webContents.send(channel, ...args)
    },
    show: (o) => {
      if (!alive()) return
      if (o?.focus && opts.focusable) {
        win.show()
        win.focus()
        win.webContents.focus()
      } else {
        win.showInactive()
      }
      if (opts.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver')
    },
    hide: () => {
      if (alive()) win.hide()
    },
    setBounds: (b) => {
      if (alive()) applyBounds(win, b)
    },
    close: () => {
      if (alive()) win.destroy()
    },
    isAlive: alive,
    onClosed: (fn) => {
      closedFns.push(fn)
    }
  }
}

/* ------------------------------ global hotkeys ------------------------------ */

const shortcuts = new Map<string, () => void>()

/**
 * Register a system-wide hotkey (Electron accelerator syntax, e.g.
 * "CommandOrControl+R", "R", "Escape"). Fails — without throwing — when the
 * accelerator is malformed or another program already owns it.
 */
export function registerGlobalShortcut(accelerator: string, handler: () => void): { ok: true } | { ok: false; error: string } {
  const accel = String(accelerator ?? '').trim()
  if (!accel) return { ok: false, error: 'No key combination given' }
  // never silently steal a combo another WICKED tool holds — callers re-binding
  // their own hotkey unregister it first
  if (shortcuts.has(accel)) return { ok: false, error: `${accel} is already used by another WICKED tool` }
  let ok = false
  try {
    ok = globalShortcut.register(accel, () => {
      try {
        handler()
      } catch (err) {
        console.error(`[wicked] hotkey ${accel} handler failed`, err)
      }
    })
  } catch (err) {
    return { ok: false, error: `"${accel}" is not a valid key combination (${err instanceof Error ? err.message : String(err)})` }
  }
  if (!ok) return { ok: false, error: `${accel} is already used by another program (or Windows) — pick a different key combination` }
  shortcuts.set(accel, handler)
  return { ok: true }
}

export function unregisterGlobalShortcut(accelerator: string): void {
  const accel = String(accelerator ?? '').trim()
  if (!shortcuts.has(accel)) return
  shortcuts.delete(accel)
  try {
    globalShortcut.unregister(accel)
  } catch {
    /* already released */
  }
}

app.on('will-quit', () => {
  shortcuts.clear()
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* quitting anyway */
  }
})

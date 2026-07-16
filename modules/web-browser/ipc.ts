import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { session } from 'electron'
import type { ModuleDataPath } from '@shared/types'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import {
  activateTarget,
  closeTarget,
  getVersion,
  listTargets,
  openTarget,
  withCdp,
  type CdpTarget
} from './ipc/cdp'
import { findChrome, launchChrome } from './ipc/chrome'

const ID = 'web-browser'
/** must match the partition the renderer's <webview> tags use */
const PARTITION = 'persist:web-browser'
/** deliberately not 9222 so dev tooling on the machine doesn't collide */
const DEFAULT_DEBUG_PORT = 9224
const LAUNCH_WAIT_MS = 20_000
const MAX_PAGE_CHARS = 150_000
const MAX_SESSION_TABS = 40

const CHROME_NOT_FOUND =
  'Google Chrome was not found. Install Chrome, or pick chrome.exe manually in the Web Browser module (Full Chrome panel → "Locate Chrome…").'
const NOT_RUNNING =
  'Full Chrome is not running with the WICKED profile. Launch it first (web-browser:launch / the "Launch Full Chrome" button).'
const DEVTOOLS_BUSY =
  'DevTools is open on that tab, which blocks automation. Close the DevTools window for that tab and retry.'

interface Bookmark {
  title: string
  url: string
  addedAt: string
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim())
}

/** URLs a tool may open/navigate to — web pages plus Chrome's own pages. */
function normalizeNavUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return /^(https?:\/\/|about:|chrome:\/\/)/i.test(s) ? s : null
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const bookmarksFile = join(moduleDir, 'bookmarks.json')
  const profileDir = join(moduleDir, 'chrome-profile')
  const screenshotsDir = join(moduleDir, 'screenshots')

  const customChromePath = (): string => {
    const v = ctx.storeGet<string>(`${ID}.chromePath`, '')
    return typeof v === 'string' ? v : ''
  }

  const debugPort = (): number => {
    const n = Number(ctx.storeGet<number>(`${ID}.debugPort`, DEFAULT_DEBUG_PORT))
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_DEBUG_PORT
  }

  /* -------------------------------- bookmarks ---------------------------- */

  async function readBookmarks(): Promise<Bookmark[]> {
    try {
      const raw = JSON.parse(await readFile(bookmarksFile, 'utf8')) as { bookmarks?: unknown }
      if (!Array.isArray(raw.bookmarks)) return []
      return raw.bookmarks
        .map((b): Bookmark | null => {
          const r = asRecord(b)
          if (!isHttpUrl(r.url)) return null
          return {
            url: r.url,
            title: typeof r.title === 'string' && r.title ? r.title : r.url,
            addedAt: typeof r.addedAt === 'string' ? r.addedAt : ''
          }
        })
        .filter((b): b is Bookmark => b !== null)
    } catch {
      return [] // missing or unreadable file = no bookmarks yet
    }
  }

  async function saveBookmarks(bookmarks: Bookmark[]): Promise<void> {
    mkdirSync(moduleDir, { recursive: true })
    await writeFile(bookmarksFile, JSON.stringify({ bookmarks }, null, 2), 'utf8')
  }

  ctx.ipcMain.handle(`${ID}:bookmarks-get`, async () => {
    return { ok: true, bookmarks: await readBookmarks() }
  })

  ctx.ipcMain.handle(`${ID}:bookmark-add`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (!isHttpUrl(r.url)) return { ok: false, error: 'A full http(s):// URL is required.' }
    const url = r.url.trim()
    const bookmarks = await readBookmarks()
    if (!bookmarks.some((b) => b.url === url)) {
      bookmarks.push({
        url,
        title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : url,
        addedAt: new Date().toISOString()
      })
      try {
        await saveBookmarks(bookmarks)
      } catch (err) {
        return { ok: false, error: 'Could not save bookmarks: ' + errMsg(err) }
      }
    }
    return { ok: true, bookmarks }
  })

  ctx.ipcMain.handle(`${ID}:bookmark-remove`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (typeof r.url !== 'string') return { ok: false, error: 'url is required.' }
    const bookmarks = (await readBookmarks()).filter((b) => b.url !== r.url)
    try {
      await saveBookmarks(bookmarks)
    } catch (err) {
      return { ok: false, error: 'Could not save bookmarks: ' + errMsg(err) }
    }
    return { ok: true, bookmarks }
  })

  /* ------------------- in-app tab session (restore on open) -------------- */

  ctx.ipcMain.handle(`${ID}:session-get`, () => {
    const raw = asRecord(ctx.storeGet<unknown>(`${ID}.session`, {}))
    const urls = Array.isArray(raw.urls)
      ? raw.urls.filter(isHttpUrl).slice(0, MAX_SESSION_TABS)
      : []
    return {
      ok: true,
      urls,
      activeUrl: typeof raw.activeUrl === 'string' ? raw.activeUrl : null
    }
  })

  ctx.ipcMain.handle(`${ID}:session-set`, (_e, raw: unknown) => {
    const r = asRecord(raw)
    const urls = Array.isArray(r.urls) ? r.urls.filter(isHttpUrl).slice(0, MAX_SESSION_TABS) : []
    ctx.storeSet(`${ID}.session`, {
      urls,
      activeUrl: typeof r.activeUrl === 'string' ? r.activeUrl : null
    })
    return { ok: true }
  })

  const browserSession = session.fromPartition(PARTITION)

  /* --------- present the embedded browser as consistent, clean Chrome ------ *
   * Spoofing only the User-Agent string (e.g. via the <webview useragent>
   * attribute) is worse than useless: Chromium still emits Sec-CH-UA client-
   * hint headers whose brand list says "Electron", so the UA claims plain
   * Chrome while the hints say Electron. That mismatch makes Google (and other
   * bot filters) flag the browser and trap it in an endless reCAPTCHA loop.
   * Fix: set the UA AND rewrite the Sec-CH-UA headers to match, so the two
   * always agree and read as a normal Chrome-on-Windows client.
   * ------------------------------------------------------------------------ */
  const CHROME_VERSION = process.versions.chrome // Chromium bundled with this Electron
  const CHROME_MAJOR = CHROME_VERSION.split('.')[0]
  const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
  const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="24"`
  const SEC_CH_UA_FULL = `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not?A_Brand";v="24.0.0.0"`
  try {
    browserSession.setUserAgent(CHROME_UA)
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders
      headers['User-Agent'] = CHROME_UA
      for (const key of Object.keys(headers)) {
        switch (key.toLowerCase()) {
          case 'sec-ch-ua':
            headers[key] = SEC_CH_UA
            break
          case 'sec-ch-ua-full-version-list':
            headers[key] = SEC_CH_UA_FULL
            break
          case 'sec-ch-ua-mobile':
            headers[key] = '?0'
            break
          case 'sec-ch-ua-platform':
            headers[key] = '"Windows"'
            break
        }
      }
      callback({ requestHeaders: headers })
    })
  } catch (err) {
    console.error(`[${ID}] could not configure browser session user agent`, err)
  }

  /* ---------------- popups from the embedded browser → new tab ----------- */

  // <webview> guests can't open windows themselves; route window.open /
  // target=_blank from OUR partition into a new in-app tab. Other modules'
  // webviews (different session) are untouched.
  ctx.app.on('web-contents-created', (_ev, wc) => {
    try {
      if (wc.getType() !== 'webview' || wc.session !== browserSession) return
      wc.setWindowOpenHandler(({ url }) => {
        if (isHttpUrl(url)) ctx.getMainWindow()?.webContents.send(`${ID}:open-tab`, url)
        return { action: 'deny' }
      })
    } catch {
      /* never interfere with other modules' guests */
    }
  })

  /* --------------------------- Full Chrome (CDP) ------------------------- */

  async function debuggerUp(port: number): Promise<boolean> {
    return getVersion(port).then(
      () => true,
      () => false
    )
  }

  async function waitForDebugger(port: number): Promise<boolean> {
    const deadline = Date.now() + LAUNCH_WAIT_MS
    while (Date.now() < deadline) {
      if (await debuggerUp(port)) return true
      await sleep(300)
    }
    return false
  }

  /** Spawn Chrome (detached) and wait for its automation port to answer. */
  async function launchAndWait(url?: string): Promise<{ ok: boolean; error?: string }> {
    const exe = findChrome(customChromePath())
    if (!exe) return { ok: false, error: CHROME_NOT_FOUND }
    const port = debugPort()
    try {
      launchChrome(exe, profileDir, port, url)
    } catch (err) {
      return { ok: false, error: 'Could not start Chrome: ' + errMsg(err) }
    }
    if (!(await waitForDebugger(port)))
      return {
        ok: false,
        error:
          'Chrome started but its automation port never came up. If a Chrome window using the WICKED profile was already open (without automation), close all its windows and try again.'
      }
    return { ok: true }
  }

  type PageResolution = { target: CdpTarget } | { error: string }

  /** Pick the tab to operate on: by id when given, else the first page tab. */
  async function resolvePage(targetId: unknown): Promise<PageResolution> {
    const port = debugPort()
    let targets: CdpTarget[]
    try {
      targets = await listTargets(port)
    } catch {
      return { error: NOT_RUNNING }
    }
    const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    if (pages.length === 0) return { error: 'No open Chrome tabs found.' }
    if (typeof targetId !== 'string' || !targetId) return { target: pages[0] }
    const hit = pages.find((p) => p.id === targetId)
    return hit ? { target: hit } : { error: `No tab with id "${targetId}". List tabs first.` }
  }

  ctx.ipcMain.handle(`${ID}:status`, async () => {
    const exe = findChrome(customChromePath())
    const port = debugPort()
    let running = false
    let browser: string | null = null
    let tabCount = 0
    try {
      browser = (await getVersion(port)).browser
      running = true
      tabCount = (await listTargets(port)).filter((t) => t.type === 'page').length
    } catch {
      /* not running */
    }
    return {
      ok: true,
      chromeFound: exe !== null,
      chromePath: exe,
      customPath: customChromePath() || null,
      running,
      browser,
      port,
      profileDir,
      tabCount
    }
  })

  ctx.ipcMain.handle(`${ID}:launch`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const url = normalizeNavUrl(r.url) ?? undefined
    const port = debugPort()
    if (await debuggerUp(port)) {
      // already running: open the URL there, or just raise a window
      try {
        if (url) await openTarget(port, url)
        else {
          const exe = findChrome(customChromePath())
          if (exe) launchChrome(exe, profileDir, port) // focuses/creates a window in the running instance
        }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
      return { ok: true, running: true, alreadyRunning: true, port }
    }
    const res = await launchAndWait(url)
    return res.ok ? { ok: true, running: true, alreadyRunning: false, port } : res
  })

  ctx.ipcMain.handle(`${ID}:tabs`, async () => {
    const port = debugPort()
    try {
      const tabs = (await listTargets(port))
        .filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
        .map((t) => ({ targetId: t.id, title: t.title, url: t.url }))
      return { ok: true, tabs }
    } catch {
      return { ok: false, error: NOT_RUNNING }
    }
  })

  ctx.ipcMain.handle(`${ID}:open`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const url = normalizeNavUrl(r.url)
    if (!url) return { ok: false, error: 'A full http(s):// URL is required.' }
    const port = debugPort()
    if (!(await debuggerUp(port))) {
      const res = await launchAndWait(url)
      return res.ok ? { ok: true, launched: true } : res
    }
    try {
      const target = await openTarget(port, url)
      return {
        ok: true,
        launched: false,
        target: target ? { targetId: target.id, title: target.title, url: target.url } : null
      }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:navigate`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const url = normalizeNavUrl(r.url)
    if (!url) return { ok: false, error: 'A full http(s):// URL is required.' }
    const res = await resolvePage(r.targetId)
    if ('error' in res) return { ok: false, error: res.error }
    if (!res.target.webSocketDebuggerUrl) return { ok: false, error: DEVTOOLS_BUSY }
    try {
      const out = await withCdp(res.target.webSocketDebuggerUrl, (send) =>
        send('Page.navigate', { url })
      )
      if (typeof out.errorText === 'string' && out.errorText)
        return { ok: false, error: `Navigation failed: ${out.errorText}` }
      return { ok: true, targetId: res.target.id, url }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:page`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const res = await resolvePage(r.targetId)
    if ('error' in res) return { ok: false, error: res.error }
    const t = res.target
    if (!t.webSocketDebuggerUrl) return { ok: false, error: DEVTOOLS_BUSY }
    const format = r.format === 'html' ? 'html' : 'text'
    const expression =
      format === 'html'
        ? 'document.documentElement.outerHTML'
        : "document.body ? document.body.innerText : ''"
    try {
      const out = await withCdp(t.webSocketDebuggerUrl, (send) =>
        send('Runtime.evaluate', { expression, returnByValue: true })
      )
      const result = asRecord(out.result)
      let content = typeof result.value === 'string' ? result.value : ''
      const truncated = content.length > MAX_PAGE_CHARS
      if (truncated) content = content.slice(0, MAX_PAGE_CHARS)
      return { ok: true, targetId: t.id, url: t.url, title: t.title, format, content, truncated }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:screenshot`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const res = await resolvePage(r.targetId)
    if ('error' in res) return { ok: false, error: res.error }
    const t = res.target
    if (!t.webSocketDebuggerUrl) return { ok: false, error: DEVTOOLS_BUSY }
    try {
      const out = await withCdp(t.webSocketDebuggerUrl, async (send) => {
        await send('Page.bringToFront') // background tabs can't be captured
        return send('Page.captureScreenshot', { format: 'png' })
      })
      if (typeof out.data !== 'string' || !out.data)
        return { ok: false, error: 'Chrome returned no screenshot data.' }
      mkdirSync(screenshotsDir, { recursive: true })
      const file = join(screenshotsDir, `tab-${timestamp()}.png`)
      await writeFile(file, Buffer.from(out.data, 'base64'))
      return { ok: true, path: file, targetId: t.id, url: t.url, title: t.title }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:eval`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const expression = typeof r.expression === 'string' ? r.expression : ''
    if (!expression.trim()) return { ok: false, error: 'expression is required.' }
    if (expression.length > 50_000)
      return { ok: false, error: 'expression is too long (max 50,000 characters).' }
    const res = await resolvePage(r.targetId)
    if ('error' in res) return { ok: false, error: res.error }
    if (!res.target.webSocketDebuggerUrl) return { ok: false, error: DEVTOOLS_BUSY }
    try {
      const out = await withCdp(res.target.webSocketDebuggerUrl, (send) =>
        send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        })
      )
      const exception = asRecord(out.exceptionDetails)
      if (out.exceptionDetails) {
        const detail = asRecord(exception.exception)
        const msg =
          (typeof detail.description === 'string' && detail.description) ||
          (typeof exception.text === 'string' && exception.text) ||
          'Script threw an exception.'
        return { ok: false, error: msg }
      }
      const result = asRecord(out.result)
      const value =
        'value' in result
          ? result.value
          : typeof result.description === 'string'
            ? result.description
            : null
      return { ok: true, targetId: res.target.id, value, type: result.type ?? null }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:activate-tab`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (typeof r.targetId !== 'string' || !r.targetId)
      return { ok: false, error: 'targetId is required — list tabs first.' }
    try {
      await activateTarget(debugPort(), r.targetId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:close-tab`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (typeof r.targetId !== 'string' || !r.targetId)
      return { ok: false, error: 'targetId is required — list tabs first.' }
    try {
      await closeTarget(debugPort(), r.targetId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  /* ---------------------------- misc / settings -------------------------- */

  ctx.ipcMain.handle(`${ID}:set-chrome-path`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (r.clear === true) {
      ctx.storeSet(`${ID}.chromePath`, '')
      return { ok: true, path: null }
    }
    const win = ctx.getMainWindow()
    if (!win) return { ok: false, error: 'No application window available.' }
    const res = await ctx.dialog.showOpenDialog(win, {
      title: 'Locate the Chrome executable',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Chrome', extensions: ['exe'] }] : []
    })
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    ctx.storeSet(`${ID}.chromePath`, res.filePaths[0])
    return { ok: true, path: res.filePaths[0] }
  })

  // MCP-triggered: open a URL as a new tab in the EMBEDDED in-app browser
  ctx.ipcMain.handle(`${ID}:ui-open`, (_e, raw: unknown) => {
    const r = asRecord(raw)
    if (!isHttpUrl(r.url)) return { ok: false, error: 'A full http(s):// URL is required.' }
    const win = ctx.getMainWindow()
    if (!win) return { ok: false, error: 'The WICKED window is not open.' }
    win.webContents.send(`${ID}:open-tab`, r.url.trim())
    return {
      ok: true,
      note: 'Sent to the in-app browser. The tab appears when the Web Browser module is open in the WICKED window.'
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Bookmarks',
      path: existsSync(bookmarksFile) ? bookmarksFile : null,
      note: 'In-app browser bookmarks (JSON)'
    },
    {
      label: 'Full Chrome profile',
      path: existsSync(profileDir) ? profileDir : null,
      note: 'Dedicated Chrome user-data-dir — sign into sync here to get your bookmarks & extensions'
    },
    {
      label: 'Screenshots',
      path: existsSync(screenshotsDir) ? screenshotsDir : null,
      note: 'PNG captures taken by the automation tools'
    }
  ])
}

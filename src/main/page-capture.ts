import { BrowserWindow, session } from 'electron'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

/**
 * Shell service: open a REMOTE web page in a hidden, locked-down Chromium
 * window and hand back a faithful snapshot of it.
 *
 * Modules never create BrowserWindows (and helper windows only take local
 * HTML with the privileged bridge), so the one module that saves websites asks
 * the shell instead. The capture window is as inert as Electron allows:
 *   - its own throw-away session (no WICKED cookies / logins, nothing kept);
 *   - sandboxed, context-isolated, no preload, no Node — the page gets no
 *     window.wicked and no file access;
 *   - popups refused, downloads cancelled, every permission request denied,
 *     only http(s) navigations allowed;
 *   - never shown, closed (and its session cleared) when done or on timeout.
 *
 * The snapshot is MHTML — Chromium's single-file archive of the page as
 * rendered (DOM after scripts ran, every stylesheet, image, font and frame).
 * Optionally a full-page PNG screenshot too.
 */

export interface CapturePageOptions {
  url: string
  /** give up after this long overall (default 90 s) */
  timeoutMs?: number
  /** scroll to the bottom first so lazy-loaded images load (default true) */
  scroll?: boolean
  /** also return a full-page PNG (default false) */
  screenshot?: boolean
  /** viewport width the page is laid out at (default 1440) */
  width?: number
  onProgress?: (step: string) => void
}

export interface CapturedPage {
  mhtml: Buffer
  title: string
  finalUrl: string
  screenshot: Buffer | null
  /** resources the page requested, and how many failed */
  requests: number
  failed: number
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

export async function capturePage(opts: CapturePageOptions): Promise<CapturedPage> {
  let target: URL
  try {
    target = new URL(opts.url)
  } catch {
    throw new Error('That isn’t a valid web address.')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Only http:// and https:// pages can be saved.')

  const step = opts.onProgress ?? ((): void => undefined)
  const timeoutMs = Math.max(10_000, opts.timeoutMs ?? 90_000)
  const width = Math.max(800, Math.min(2560, opts.width ?? 1440))
  const ses = session.fromPartition(`page-capture-${randomUUID()}`, { cache: true })
  ses.setUserAgent(UA)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())

  // count network activity so we know when the page has settled
  let inflight = 0
  let requests = 0
  let failed = 0
  let lastActivity = Date.now()
  ses.webRequest.onBeforeRequest((d, cb) => {
    const ok = /^(https?|data|blob|about|chrome-extension):/i.test(d.url) // no file:// etc.
    if (ok && /^https?:/i.test(d.url)) {
      inflight++
      requests++
      lastActivity = Date.now()
    }
    cb({ cancel: !ok })
  })
  const done = (d: { url: string }): void => {
    if (/^https?:/i.test(d.url)) {
      inflight = Math.max(0, inflight - 1)
      lastActivity = Date.now()
    }
  }
  ses.webRequest.onCompleted(done)
  ses.webRequest.onErrorOccurred((d) => {
    failed++
    done(d)
  })

  const win = new BrowserWindow({
    show: false,
    width,
    height: 900,
    // off-screen rendering: never on screen, yet it paints every frame (a merely hidden window
    // may not paint at all, and a screenshot of it would wait forever)
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, javascript: true, backgroundThrottling: false, offscreen: true }
  })
  const wc = win.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-navigate', (e, u) => {
    if (!/^https?:/i.test(u)) e.preventDefault()
  })
  wc.setAudioMuted(true)

  const tmp = mkdtempSync(join(tmpdir(), 'wicked-capture-'))
  const started = Date.now()
  const left = (): number => timeoutMs - (Date.now() - started)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** wait until nothing has been loading for `quietMs` (or the budget runs out) */
  /** never let one step hang the whole capture */
  const within = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))])
  const settle = async (quietMs: number, maxMs: number): Promise<void> => {
    const until = Date.now() + Math.min(maxMs, Math.max(0, left() - 8000))
    while (Date.now() < until) {
      if (inflight === 0 && Date.now() - lastActivity >= quietMs) return
      await sleep(200)
    }
  }

  try {
    step('Loading the page…')
    const loaded = wc.loadURL(target.toString())
    await Promise.race([loaded.catch((err: unknown) => {
      // ERR_ABORTED is a redirect / client navigation, not a failure
      if (!/ERR_ABORTED/.test(String(err))) throw err
    }), sleep(Math.max(5000, left() - 15_000))])
    if (wc.isLoading()) await Promise.race([new Promise<void>((r) => wc.once('did-stop-loading', () => r())), sleep(Math.max(2000, left() - 15_000))])
    await settle(1200, 15_000)

    if (opts.scroll !== false) {
      step('Scrolling through it so every image loads…')
      // step down the page like a reader would — lazy images / infinite sections load as they come into view
      await within(wc.executeJavaScript(
        `(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const h = () => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight);
          let y = 0;
          for (let i = 0; i < 80 && y < h(); i++) { y += Math.max(400, innerHeight * 0.8); scrollTo(0, y); await sleep(250); }
          document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
          scrollTo(0, 0); await sleep(300);
          return true;
        })()`,
        true
      ), 40_000, 'Scrolling').catch(() => undefined)
      await settle(1500, 20_000)
    }

    let screenshot: Buffer | null = null
    if (opts.screenshot) {
      step('Taking a full-page picture…')
      try {
        wc.debugger.attach('1.3')
        const m = (await within(wc.debugger.sendCommand('Page.getLayoutMetrics'), 10_000, 'Measuring the page')) as { cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }
        const size = m.cssContentSize ?? m.contentSize ?? { width, height: 900 }
        const shot = (await within(wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.min(size.width, 4000), height: Math.min(size.height, 16_000), scale: 1 }
        }), 30_000, 'The picture')) as { data: string }
        screenshot = Buffer.from(shot.data, 'base64')
      } catch {
        screenshot = null // a picture is a bonus — the page itself still saves
      } finally {
        try {
          wc.debugger.detach()
        } catch {
          /* not attached */
        }
      }
    }

    step('Saving every file the page uses…')
    const file = join(tmp, 'page.mhtml')
    await within(wc.savePage(file, 'MHTML'), 60_000, 'Saving the page')
    const mhtml = readFileSync(file)
    if (!mhtml.length) throw new Error('Chromium returned an empty page.')
    return { mhtml, title: wc.getTitle() || target.hostname, finalUrl: wc.getURL() || target.toString(), screenshot, requests, failed }
  } finally {
    if (!win.isDestroyed()) win.destroy()
    void ses.clearStorageData().catch(() => undefined)
    void ses.clearCache().catch(() => undefined)
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* temp cleanup is best-effort */
    }
  }
}

/** capturePage, but never longer than the overall budget (a hung page can't wedge the module) */
export function capturePageWithTimeout(opts: CapturePageOptions): Promise<CapturedPage> {
  const ms = Math.max(10_000, opts.timeoutMs ?? 90_000) + 15_000
  return Promise.race([capturePage(opts), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The page took too long to load.')), ms))])
}

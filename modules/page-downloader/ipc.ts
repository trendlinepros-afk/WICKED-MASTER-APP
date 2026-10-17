/**
 * Webpage Downloader — main process.
 *
 * Save = the shell's capturePage (hidden, sandboxed Chromium window; the page
 * is loaded, scrolled so lazy images load, and snapshotted as MHTML) → the
 * snapshot is unpacked into <save folder>/<page title> (<site>) <date>/ with
 * index.html + assets/ (lib/mhtml.ts), gaps the snapshot left (fonts, icons)
 * fetched from the site (lib/save.ts). Optional: a full-page screenshot.png
 * and the single-file page.mhtml next to it.
 */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { net } from 'electron'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { savePageToFolder, type FetchFn } from './lib/save'

const ID = 'page-downloader'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

export interface SavedPage {
  id: string
  url: string
  title: string
  dir: string
  index: string
  savedAt: number
  files: number
  bytes: number
  external: number
  screenshot: boolean
  mhtml: boolean
}

export interface SavePrefs {
  screenshot: boolean
  keepMhtml: boolean
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** "example.com/page" → "https://example.com/page"; null when it can't be a web page */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null
    return u.toString()
  } catch {
    return null
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const dataDir = join(ctx.app.getPath('userData'), 'modules', ID)
  const historyFile = join(dataDir, 'history.json')
  const send = (ch: string, p: unknown): void => ctx.getMainWindow()?.webContents.send(ch, p)

  const saveDir = (): string => {
    const v = ctx.storeGet<string>(`${ID}.saveDir`, '')
    return v && v.trim() ? v : ctx.app.getPath('downloads')
  }
  const prefs = (): SavePrefs => {
    const p = ctx.storeGet<Partial<SavePrefs>>(`${ID}.prefs`, {})
    return { screenshot: p.screenshot !== false, keepMhtml: p.keepMhtml !== false }
  }

  let history: SavedPage[] = []
  try {
    const j = JSON.parse(readFileSync(historyFile, 'utf8'))
    if (Array.isArray(j)) history = j
  } catch {
    history = []
  }
  const saveHistory = (): void => {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(`${historyFile}.tmp`, JSON.stringify(history.slice(0, 300)), 'utf8')
      renameSync(`${historyFile}.tmp`, historyFile)
    } catch {
      /* the list is a convenience; the saved pages are on disk regardless */
    }
    send(`${ID}:history`, listHistory())
  }
  const listHistory = (): (SavedPage & { exists: boolean })[] => history.map((h) => ({ ...h, exists: existsSync(h.index) }))

  /* ------------------------------- saving -------------------------------- */

  // one page at a time (each one is a whole hidden browser); the rest wait in line
  let chain: Promise<unknown> = Promise.resolve()
  let waiting = 0

  const fetchFn: FetchFn = (url, init) => net.fetch(url, { headers: init.headers, signal: init.signal }) as unknown as ReturnType<FetchFn>

  async function savePage(rawUrl: string, opt: Partial<SavePrefs> = {}, jobId: string = randomUUID()): Promise<{ ok: boolean; page?: SavedPage; error?: string; jobId: string }> {
    const url = normalizeUrl(rawUrl)
    if (!url) return { ok: false, error: 'That doesn’t look like a web address — e.g. https://example.com/page', jobId }
    const p = { ...prefs(), ...opt }
    const progress = (step: string, state: 'running' | 'done' | 'error' = 'running', extra: Record<string, unknown> = {}): void => send(`${ID}:progress`, { jobId, url, step, state, ...extra })
    waiting++
    progress(waiting > 1 ? 'Waiting for the page before it…' : 'Starting…')
    const run = chain.then(async () => {
      try {
        const shot = await ctx.capturePage({ url, screenshot: p.screenshot, scroll: true, timeoutMs: 90_000, onProgress: (s) => progress(s) })
        const also: { name: string; data: Buffer }[] = []
        if (shot.screenshot) also.push({ name: 'screenshot.png', data: shot.screenshot })
        if (p.keepMhtml) also.push({ name: 'page.mhtml', data: shot.mhtml })
        const r = await savePageToFolder({ mhtml: shot.mhtml, url: shot.finalUrl || url, parentDir: saveDir(), fetchFn, userAgent: UA, alsoWrite: also, onStep: (s) => progress(s) })
        const page: SavedPage = { id: jobId, url: r.url, title: r.title || shot.title, dir: r.dir, index: r.index, savedAt: Date.now(), files: r.files, bytes: r.bytes, external: r.external, screenshot: !!shot.screenshot, mhtml: p.keepMhtml }
        history = [page, ...history.filter((h) => h.id !== page.id)]
        saveHistory()
        progress('Saved', 'done', { page })
        return { ok: true, page, jobId }
      } catch (err) {
        const error = /ERR_NAME_NOT_RESOLVED/.test(errMsg(err))
          ? 'That site couldn’t be found — check the address.'
          : /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(errMsg(err))
            ? 'No internet connection.'
            : `Couldn’t save the page: ${errMsg(err).replace(/^Error:\s*/, '')}`
        progress(error, 'error')
        return { ok: false, error, jobId }
      } finally {
        waiting--
      }
    })
    chain = run.catch(() => undefined)
    return run
  }

  ctx.ipcMain.handle(`${ID}:save`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { url?: unknown; screenshot?: unknown; keepMhtml?: unknown; jobId?: unknown }
    const opt: Partial<SavePrefs> = {}
    if (typeof r.screenshot === 'boolean') opt.screenshot = r.screenshot
    if (typeof r.keepMhtml === 'boolean') opt.keepMhtml = r.keepMhtml
    return savePage(String(r.url ?? ''), opt, typeof r.jobId === 'string' && r.jobId ? r.jobId : undefined)
  })

  /* ------------------------------ the rest ------------------------------- */

  ctx.ipcMain.handle(`${ID}:status`, () => ({ ok: true, saveDir: saveDir(), defaultDir: ctx.app.getPath('downloads'), prefs: prefs(), history: listHistory() }))

  ctx.ipcMain.handle(`${ID}:prefs-set`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as Partial<SavePrefs>
    const next = { ...prefs(), ...(typeof r.screenshot === 'boolean' ? { screenshot: r.screenshot } : {}), ...(typeof r.keepMhtml === 'boolean' ? { keepMhtml: r.keepMhtml } : {}) }
    ctx.storeSet(`${ID}.prefs`, next)
    return { ok: true, prefs: next }
  })

  ctx.ipcMain.handle(`${ID}:pick-folder`, async () => {
    const win = ctx.getMainWindow()
    const opts = { title: 'Save web pages in…', defaultPath: saveDir(), properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true }
    ctx.storeSet(`${ID}.saveDir`, r.filePaths[0])
    return { ok: true, saveDir: r.filePaths[0] }
  })

  ctx.ipcMain.handle(`${ID}:reset-folder`, () => {
    ctx.storeSet(`${ID}.saveDir`, '')
    return { ok: true, saveDir: saveDir() }
  })

  const find = (raw: unknown): SavedPage | undefined => history.find((h) => h.id === String((raw as { id?: unknown })?.id ?? ''))

  /** open the saved page in the default browser */
  ctx.ipcMain.handle(`${ID}:open`, async (_e, raw: unknown) => {
    const h = find(raw)
    if (!h || !existsSync(h.index)) return { ok: false, error: 'That saved page is no longer there.' }
    const err = await ctx.shell.openPath(h.index)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:reveal`, (_e, raw: unknown) => {
    const h = find(raw)
    if (h && existsSync(h.index)) ctx.shell.showItemInFolder(h.index)
    else void ctx.shell.openPath(saveDir())
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:open-folder`, async () => ({ ok: !(await ctx.shell.openPath(saveDir())) }))

  ctx.ipcMain.handle(`${ID}:open-original`, async (_e, raw: unknown) => {
    const h = find(raw)
    if (!h || !/^https?:/i.test(h.url)) return { ok: false }
    await ctx.shell.openExternal(h.url)
    return { ok: true }
  })

  /** take it off the list (the files stay) */
  ctx.ipcMain.handle(`${ID}:forget`, (_e, raw: unknown) => {
    const n = history.length
    history = history.filter((h) => h.id !== String((raw as { id?: unknown })?.id ?? ''))
    if (history.length !== n) saveHistory()
    return { ok: true }
  })

  /** move the saved folder to the Recycle Bin and take it off the list */
  ctx.ipcMain.handle(`${ID}:delete`, async (_e, raw: unknown) => {
    const h = find(raw)
    if (!h) return { ok: false, error: 'Not on the list.' }
    try {
      if (existsSync(h.dir)) await ctx.shell.trashItem(h.dir)
    } catch (err) {
      return { ok: false, error: `Couldn’t move it to the Recycle Bin: ${errMsg(err)}` }
    }
    history = history.filter((x) => x.id !== h.id)
    saveHistory()
    return { ok: true }
  })

  ctx.ipcMain.handle(
    `${ID}:data-paths`,
    (): ModuleDataPath[] => [
      { label: 'Saved pages', path: saveDir(), note: 'One folder per page: index.html + assets (+ screenshot.png, page.mhtml)' },
      { label: 'History', path: historyFile }
    ]
  )
}

/**
 * Snapshot → folder on disk, filling the snapshot's gaps (main only; fetch is
 * injected so tests run without Electron).
 *
 * Chromium's MHTML leaves out a few things a page uses — web fonts, the
 * favicon, a stylesheet's own @import or background now and then. After the
 * first unpack, every such file is fetched straight from the site (two rounds,
 * so a fetched stylesheet's fonts come too) and the page is unpacked again
 * with them included. Caps keep a hostile page from filling the disk.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { folderNameFor, unpackMhtml, type ExtraFile } from './mhtml'

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get: (n: string) => string | null }; arrayBuffer: () => Promise<ArrayBuffer> }>

export interface SaveOptions {
  mhtml: Buffer
  /** the address asked for (the page may have redirected) */
  url: string
  /** folder the page's own folder is created in (e.g. Downloads) */
  parentDir: string
  fetchFn: FetchFn
  userAgent?: string
  /** written next to index.html, e.g. screenshot.png / page.mhtml */
  alsoWrite?: { name: string; data: Buffer }[]
  savedAt?: Date
  onStep?: (step: string) => void
}

export interface SaveResult {
  dir: string
  index: string
  title: string
  url: string
  files: number
  bytes: number
  /** gaps filled by fetching */
  fetched: number
  /** still pointing at the web (the site refused, too big, …) */
  external: number
}

export const LIMITS = { files: 300, fileBytes: 30 * 1024 * 1024, totalBytes: 300 * 1024 * 1024, timeoutMs: 20_000, parallel: 6 }

const GUESS: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon' }

export async function fetchMissing(urls: string[], o: { fetchFn: FetchFn; referer: string; userAgent?: string; budget: { files: number; bytes: number } }): Promise<ExtraFile[]> {
  const queue = urls.filter((u) => /^https?:/i.test(u)).slice(0, Math.max(0, o.budget.files))
  const got: ExtraFile[] = []
  const worker = async (): Promise<void> => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      if (o.budget.files <= 0 || o.budget.bytes <= 0) return
      try {
        const r = await o.fetchFn(u, { headers: { 'User-Agent': o.userAgent ?? 'Mozilla/5.0', Referer: o.referer, Accept: '*/*' }, signal: AbortSignal.timeout(LIMITS.timeoutMs) })
        if (!r.ok) continue
        const len = Number(r.headers.get('content-length') ?? 0)
        if (len > LIMITS.fileBytes) continue
        const body = Buffer.from(await r.arrayBuffer())
        if (!body.length || body.length > LIMITS.fileBytes || body.length > o.budget.bytes) continue
        o.budget.files--
        o.budget.bytes -= body.length
        let type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') {
          const ext = /\.([a-z0-9]+)(?:$|[?#])/i.exec(new URL(u).pathname)?.[1]?.toLowerCase() ?? ''
          type = GUESS[ext] ?? 'application/octet-stream'
        }
        got.push({ url: u, type, body })
      } catch {
        /* unreachable / refused / timed out: it keeps its web address */
      }
    }
  }
  await Promise.all(Array.from({ length: LIMITS.parallel }, worker))
  return got
}

/** a folder name that isn't taken yet */
export function uniqueDir(parent: string, name: string): string {
  let dir = join(parent, name)
  for (let n = 2; existsSync(dir); n++) dir = join(parent, `${name} (${n})`)
  return dir
}

export async function savePageToFolder(o: SaveOptions): Promise<SaveResult> {
  const at = o.savedAt ?? new Date()
  const step = o.onStep ?? ((): void => undefined)
  step('Unpacking the page…')
  let r = unpackMhtml(o.mhtml, { sourceUrl: o.url, savedAt: at })
  const extra: ExtraFile[] = []
  const tried = new Set<string>()
  const budget = { files: LIMITS.files, bytes: LIMITS.totalBytes }
  for (let round = 0; round < 2 && r.missing.some((u) => !tried.has(u)); round++) {
    const todo = r.missing.filter((u) => !tried.has(u))
    todo.forEach((u) => tried.add(u))
    step(`Fetching ${todo.length} file${todo.length === 1 ? '' : 's'} the snapshot left out (fonts, icons…)…`)
    extra.push(...(await fetchMissing(todo, { fetchFn: o.fetchFn, referer: r.url || o.url, userAgent: o.userAgent, budget })))
    r = unpackMhtml(o.mhtml, { sourceUrl: o.url, savedAt: at, extra })
  }

  step('Writing the files…')
  mkdirSync(o.parentDir, { recursive: true })
  const dir = uniqueDir(o.parentDir, folderNameFor(r.title, r.url || o.url, at))
  let bytes = 0
  for (const f of r.files) {
    const p = join(dir, ...f.path.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, f.data)
    bytes += f.data.length
  }
  for (const f of o.alsoWrite ?? []) {
    writeFileSync(join(dir, f.name), f.data)
    bytes += f.data.length
  }
  return { dir, index: join(dir, 'index.html'), title: r.title, url: r.url || o.url, files: r.files.length + (o.alsoWrite?.length ?? 0), bytes, fetched: extra.length, external: r.external }
}

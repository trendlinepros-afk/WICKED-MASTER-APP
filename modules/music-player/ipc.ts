import { protocol } from 'electron'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  ART_EXTS,
  AUDIO_EXTS,
  type Library,
  type PlayerCommand,
  type PlayerSnapshot,
  type Playlist,
  type Track
} from './shared/types'

/* ------------------------------------------------------------------------ *
 *  MUSIC PLAYER — main process.
 *
 *  Three jobs:
 *   1. Stream audio/art into the renderer over the `wkmusic://` scheme with
 *      HTTP Range support (webSecurity stays on; seeking needs 206s — same
 *      architecture as automatic-editing's wcmedia://). The scheme itself is
 *      registered in automatic-editing/ipc.ts: registerSchemesAsPrivileged
 *      may only run ONCE per app, so all privileged module schemes share
 *      that one list. Only files under the configured library root are served.
 *   2. Scan the library folder (works on UNC/network shares): one folder per
 *      artist, tracks = audio files, art = the thumbnails yt-dlp saves next
 *      to them. Filename/folder metadata only — no tag parsing. The result is
 *      cached to library.json so startup is instant; Rescan streams progress.
 *   3. Persist playlists + hold the latest player snapshot the RENDERER
 *      engine reports (playback itself runs in the renderer so it survives
 *      route changes), and relay MCP commands back to it.
 * ------------------------------------------------------------------------ */

const ID = 'music-player'
const ROOT_KEY = `${ID}.libraryRoot`
const MAX_DEPTH = 8
const MAX_FILES = 50_000
const PROGRESS_MS = 500

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function mimeForFile(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.mp3':
      return 'audio/mpeg'
    case '.m4a':
      return 'audio/mp4'
    case '.aac':
      return 'audio/aac'
    case '.opus':
    case '.ogg':
    case '.oga':
      return 'audio/ogg'
    case '.webm':
      return 'audio/webm'
    case '.flac':
      return 'audio/flac'
    case '.wav':
      return 'audio/wav'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    default:
      return 'application/octet-stream'
  }
}

/** "0042 - Song Name [dQw4w9WgXcQ].m4a" → "Song Name". */
export function cleanTitle(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '')
  s = s.replace(/^\s*\d{1,3}\s*[-–.)]\s+/, '')
  // strip ONLY a trailing 11-char YouTube id — never real brackets like "[Live]"
  s = s.replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, '')
  return s.trim() || fileName
}

const trackId = (relPath: string): string => createHash('sha1').update(relPath).digest('hex').slice(0, 16)

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = (): string => path.join(ctx.app.getPath('userData'), 'modules', ID)
  const libraryFile = (): string => path.join(moduleDir(), 'library.json')
  const playlistsFile = (): string => path.join(moduleDir(), 'playlists.json')
  const libraryRoot = (): string => ctx.storeGet<string>(ROOT_KEY, '').trim()

  const writeJsonAtomic = (file: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
    fs.renameSync(tmp, file)
  }

  /* --------------------------- wkmusic:// streaming ------------------------ */

  // Cloned from automatic-editing's wcmedia handler (the proven Range/seek
  // implementation) — but the allowlist here is the library root ONLY.
  protocol.handle('wkmusic', async (request) => {
    try {
      const decoded = decodeURIComponent(request.url.slice('wkmusic://'.length))
      const resolved = path.resolve(decoded)
      const root = libraryRoot()
      const allowed =
        !!root && (resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep))
      if (!allowed) return new Response('Forbidden', { status: 403 })

      const total = (await fs.promises.stat(resolved)).size
      const type = mimeForFile(resolved)
      const rangeHeader = request.headers.get('Range')

      if (rangeHeader) {
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= total) end = total - 1
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
        const body = Readable.toWeb(fs.createReadStream(resolved, { start, end })) as ReadableStream
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      const body = Readable.toWeb(fs.createReadStream(resolved)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' }
      })
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  /* -------------------------------- library ------------------------------- */

  const readLibrary = (): Library | null => {
    try {
      const j = JSON.parse(fs.readFileSync(libraryFile(), 'utf8')) as Library
      return Array.isArray(j.tracks) ? j : null
    } catch {
      return null
    }
  }

  let scanning = false

  async function scanLibrary(root: string): Promise<Library> {
    const tracks: Track[] = []
    let dirs = 0
    let files = 0
    let truncated = false
    let lastPush = 0
    const audioSet = new Set<string>(AUDIO_EXTS)
    const artSet = new Set<string>(ART_EXTS)

    const push = (done = false): void => {
      const now = Date.now()
      if (!done && now - lastPush < PROGRESS_MS) return
      lastPush = now
      ctx.getMainWindow()?.webContents.send(`${ID}:scan-progress`, { dirs, files, done })
    }

    const walk = async (absDir: string, relDir: string, topArtist: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || truncated) return
      dirs++
      push()
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(absDir, { withFileTypes: true })
      } catch {
        return // unreadable folder — skip, keep scanning
      }
      const images: string[] = []
      const audio: fs.Dirent[] = []
      const subdirs: fs.Dirent[] = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const ext = path.extname(e.name).toLowerCase()
        if (e.isDirectory()) subdirs.push(e)
        else if (audioSet.has(ext)) audio.push(e)
        else if (artSet.has(ext)) images.push(e.name)
      }
      const imageByBase = new Map<string, string>()
      for (const img of images) imageByBase.set(img.replace(/\.[^.]+$/, ''), img)
      for (const a of audio) {
        if (tracks.length >= MAX_FILES) {
          truncated = true
          break
        }
        files++
        const rel = (relDir ? `${relDir}/${a.name}` : a.name).replace(/\\/g, '/')
        const base = a.name.replace(/\.[^.]+$/, '')
        const artName = imageByBase.get(base) ?? images[0] ?? null
        tracks.push({
          id: trackId(rel),
          artist: topArtist || '(library root)',
          title: cleanTitle(a.name),
          relPath: rel,
          art: artName ? (relDir ? `${relDir}/${artName}` : artName).replace(/\\/g, '/') : null
        })
        push()
      }
      for (const d of subdirs) {
        await walk(
          path.join(absDir, d.name),
          relDir ? `${relDir}/${d.name}` : d.name,
          topArtist || d.name,
          depth + 1
        )
      }
    }

    await walk(root, '', '', 0)
    push(true)
    tracks.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title))
    return { root, tracks, scannedUtc: new Date().toISOString(), truncated }
  }

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    root: libraryRoot(),
    hasLibrary: fs.existsSync(libraryFile()),
    scanning
  }))

  ctx.ipcMain.handle(`${ID}:pick-folder`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Choose your music library folder (network shares work)',
      properties: ['openDirectory' as const],
      ...(libraryRoot() ? { defaultPath: libraryRoot() } : {})
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    ctx.storeSet(ROOT_KEY, res.filePaths[0])
    return { ok: true, root: res.filePaths[0] }
  })

  ctx.ipcMain.handle(`${ID}:library`, () => {
    const lib = readLibrary()
    return lib ? { ok: true, library: lib } : { ok: true, library: null }
  })

  ctx.ipcMain.handle(`${ID}:scan`, async () => {
    const root = libraryRoot()
    if (!root) return { ok: false, error: 'Pick your music folder first.' }
    if (!fs.existsSync(root))
      return { ok: false, error: `The library folder is not reachable right now: ${root}` }
    if (scanning) return { ok: false, error: 'A scan is already running.' }
    scanning = true
    try {
      const lib = await scanLibrary(root)
      writeJsonAtomic(libraryFile(), lib)
      return { ok: true, library: lib }
    } catch (err) {
      return { ok: false, error: `Scan failed: ${errMsg(err)}` }
    } finally {
      scanning = false
    }
  })

  /* ------------------------------- playlists ------------------------------- */

  const readPlaylists = (): Playlist[] => {
    try {
      const j = JSON.parse(fs.readFileSync(playlistsFile(), 'utf8')) as { playlists?: unknown }
      return Array.isArray(j.playlists) ? (j.playlists as Playlist[]) : []
    } catch {
      return []
    }
  }

  ctx.ipcMain.handle(`${ID}:playlists-get`, () => ({ ok: true, playlists: readPlaylists() }))

  // Full-replace save. Track ids that point at missing files are kept — they
  // are relPath hashes, so the tracks reappear after a rescan; pruning here
  // would permanently destroy playlist entries whenever the NAS is offline.
  ctx.ipcMain.handle(`${ID}:playlists-save`, (_e, raw: unknown) => {
    const list = (Array.isArray(raw) ? raw : []).slice(0, 200).map((p): Playlist => {
      const r = asRecord(p)
      return {
        id: String(r.id ?? '') || `pl-${Date.now().toString(36)}`,
        name: String(r.name ?? 'Playlist').slice(0, 80),
        trackIds: (Array.isArray(r.trackIds) ? r.trackIds : []).map(String).slice(0, 5000)
      }
    })
    try {
      writeJsonAtomic(playlistsFile(), { playlists: list })
      return { ok: true, playlists: list }
    } catch (err) {
      return { ok: false, error: `Could not save playlists: ${errMsg(err)}` }
    }
  })

  /* --------------------- renderer engine <-> MCP bridge -------------------- */

  let snapshot: PlayerSnapshot | null = null

  ctx.ipcMain.handle(`${ID}:report-state`, (_e, raw: unknown) => {
    snapshot = raw as PlayerSnapshot
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:snapshot`, () => ({ ok: true, snapshot }))

  ctx.ipcMain.handle(`${ID}:command`, (_e, raw: unknown) => {
    const cmd = String(asRecord(raw).cmd ?? '') as PlayerCommand
    if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(cmd))
      return { ok: false, error: 'Unknown command.' }
    if (!snapshot)
      return { ok: false, error: 'The player engine is not running yet — open the Music Player tool once.' }
    const win = ctx.getMainWindow()
    if (!win) return { ok: false, error: 'No app window.' }
    win.webContents.send(`${ID}:cmd`, cmd)
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    {
      label: 'Music library',
      path: libraryRoot() || null,
      note: 'Your music folder (e.g. a network share). External — NOT included in Backup & Cloud Sync.'
    },
    {
      label: 'Playlists & library index',
      path: fs.existsSync(moduleDir()) ? moduleDir() : null,
      note: 'playlists.json + the scanned library cache. Included in Backup & Cloud Sync.'
    }
  ])
}

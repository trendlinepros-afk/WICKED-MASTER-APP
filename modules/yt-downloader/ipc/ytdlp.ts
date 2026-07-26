import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * yt-dlp binary management + process helpers.
 *
 * yt-dlp is NOT bundled: YouTube changes constantly and yt-dlp ships fixes
 * almost weekly, so a pinned copy would rot. Instead the module downloads the
 * latest release into its own userData bin folder on first use and can update
 * it on demand. FFmpeg (for merging video+audio) comes from the suite's bundled
 * ffmpeg-static.
 */

const GH_LATEST = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

export function ytDlpAsset(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return 'yt-dlp_linux'
}

export function binDir(userData: string): string {
  return join(userData, 'modules', 'yt-downloader', 'bin')
}

export function ytDlpPath(userData: string): string {
  return join(binDir(userData), ytDlpAsset())
}

/** Resolve the bundled ffmpeg (asar-unpacked in a packaged build). */
export function resolveFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require('ffmpeg-static') as string | { path?: string } | null
    let p = typeof m === 'string' ? m : m?.path
    if (p) p = p.replace(/\bapp\.asar([\\/])/, 'app.asar.unpacked$1')
    if (p && existsSync(p)) return p
  } catch {
    /* fall through */
  }
  return null
}

/** True if a usable yt-dlp binary is present (module copy or on PATH). */
export function hasYtDlp(userData: string): boolean {
  return existsSync(ytDlpPath(userData))
}

/** Path to invoke: the module copy if present, else rely on PATH. */
export function ytDlpCmd(userData: string): string {
  return hasYtDlp(userData) ? ytDlpPath(userData) : ytDlpAsset().replace(/\.(exe)$|_.*$/, '')
}

/** Download the latest yt-dlp release binary into the module bin folder. */
export async function downloadYtDlp(userData: string): Promise<{ ok: boolean; error?: string }> {
  const dir = binDir(userData)
  mkdirSync(dir, { recursive: true })
  const url = `${GH_LATEST}/${ytDlpAsset()}`
  try {
    const resp = await fetch(url, { redirect: 'follow' })
    if (!resp.ok) return { ok: false, error: `Download failed: HTTP ${resp.status}` }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length < 1_000_000) return { ok: false, error: 'Downloaded file looks too small — try again.' }
    const dest = ytDlpPath(userData)
    const tmp = dest + '.tmp'
    writeFileSync(tmp, buf)
    if (process.platform !== 'win32') chmodSync(tmp, 0o755)
    renameSync(tmp, dest)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------ format args ------------------------------ */

export interface DownloadRequest {
  url: string
  /** 'best' | '2160' | '1440' | '1080' | '720' | '480' | '360' | 'audio' */
  quality: string
  isPlaylist: boolean
  downloadDir: string
}

/* ----------------------------- URL analysis ------------------------------ *
 * YouTube Music (music.youtube.com) is served by the same yt-dlp extractor as
 * youtube.com, so it works — but its URLs need care:
 *   - Clicking a song in YT Music yields `watch?v=<track>&list=RDAMVM<track>`,
 *     i.e. the track PLUS an auto-generated (effectively endless) radio mix.
 *     yt-dlp's default for a v+list URL is to take the PLAYLIST, so a naive
 *     download grabs the whole radio instead of the one song. We detect that
 *     and let the user choose.
 *   - Album URLs use `list=OLAK5uy_…`, radio/mix use `list=RD…`, and personal
 *     library lists (LM / liked music) need a signed-in session we don't have.
 * ------------------------------------------------------------------------- */

export type PlaylistKind = 'album' | 'mix' | 'playlist' | 'library'

export interface YtUrlInfo {
  isMusic: boolean
  videoId: string | null
  listId: string | null
  playlistKind: PlaylistKind | null
  /** URL carries BOTH a track and a list → the user must pick which to fetch */
  hasBoth: boolean
  /** list needs a signed-in account (personal library) — unsupported */
  needsAuth: boolean
}

function classifyList(listId: string | null): PlaylistKind | null {
  if (!listId) return null
  if (listId.startsWith('OLAK5uy_')) return 'album' // YT Music album
  if (/^RD|^RDAMVM|^RDCLAK/.test(listId)) return 'mix' // radio / auto-mix
  if (listId === 'LM' || listId.startsWith('LL')) return 'library' // liked music
  return 'playlist'
}

/** Parse a YouTube / YouTube Music URL (pure). Never throws. */
export function parseYtUrl(raw: string): YtUrlInfo {
  const empty: YtUrlInfo = {
    isMusic: false,
    videoId: null,
    listId: null,
    playlistKind: null,
    hasBoth: false,
    needsAuth: false
  }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return empty
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const isMusic = host === 'music.youtube.com'
  let videoId = u.searchParams.get('v')
  const listId = u.searchParams.get('list')

  // youtu.be/<id>, /shorts/<id>, /live/<id> carry the id in the path
  if (!videoId) {
    if (host === 'youtu.be') videoId = u.pathname.replace(/^\//, '').split('/')[0] || null
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
      if (m) videoId = m[1]
    }
  }
  const playlistKind = classifyList(listId)
  return {
    isMusic,
    videoId: videoId || null,
    listId: listId || null,
    playlistKind,
    hasBoth: !!videoId && !!listId,
    needsAuth: playlistKind === 'library'
  }
}

export function isAudioQuality(quality: string): boolean {
  return quality === 'audio' || quality === 'audio-native'
}

/**
 * Tag + cover-art embedding for audio downloads. Without this, music files land
 * in a library with no artist/album/artwork, which makes them near-useless.
 * Thumbnails are converted to jpg because YouTube serves webp, which many
 * players/taggers won't read as embedded art.
 */
const AUDIO_TAG_ARGS = [
  '--embed-metadata',
  '--embed-thumbnail',
  '--convert-thumbnails',
  'jpg'
]

/** Map a quality preset to yt-dlp -f / postprocessor args. */
export function formatArgs(quality: string): string[] {
  if (quality === 'audio') {
    // transcode to MP3 (universally compatible)
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', ...AUDIO_TAG_ARGS]
  }
  if (quality === 'audio-native') {
    // keep YouTube's original audio (opus/m4a) — no lossy re-encode
    return ['-f', 'bestaudio/best', '-x', '--audio-format', 'best', ...AUDIO_TAG_ARGS]
  }
  const height = Number(quality)
  if (Number.isFinite(height) && height > 0) {
    return [
      '-f',
      `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
      '--merge-output-format',
      'mp4',
      '--embed-metadata'
    ]
  }
  // best
  return ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4', '--embed-metadata']
}

const PGRESS = 'WKPROG'

/** Build the argv for a download job. */
export function buildDownloadArgs(req: DownloadRequest, ffmpeg: string | null): string[] {
  // Audio gets music-library-friendly names (artist in the filename, album as
  // the folder). yt-dlp's `%(a,b)s` syntax falls back left-to-right, so a
  // missing artist/album degrades to uploader/playlist title rather than
  // erroring or producing "NA".
  const audio = isAudioQuality(req.quality)
  const out = req.isPlaylist
    ? join(
        req.downloadDir,
        audio ? '%(playlist_title,album,uploader)s' : '%(playlist_title,uploader)s',
        audio
          ? '%(playlist_index)03d - %(artist,creator,uploader)s - %(title)s [%(id)s].%(ext)s'
          : '%(playlist_index)03d - %(title)s [%(id)s].%(ext)s'
      )
    : join(
        req.downloadDir,
        audio
          ? '%(artist,creator,uploader)s - %(title)s [%(id)s].%(ext)s'
          : '%(title)s [%(id)s].%(ext)s'
      )

  const args: string[] = [
    ...formatArgs(req.quality),
    '-o',
    out,
    req.isPlaylist ? '--yes-playlist' : '--no-playlist',
    '--newline',
    '--no-color',
    '--ignore-errors', // one bad video in a playlist shouldn't abort the rest
    '--no-mtime',
    '--concurrent-fragments',
    '4',
    '--progress-template',
    `download:${PGRESS}|%(info.playlist_index)s|%(info.n_entries)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.title)s`
  ]
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
  args.push(req.url)
  return args
}

export interface Progress {
  index: number
  total: number
  percent: number
  speed: string
  eta: string
  title: string
}

/** Parse one stdout line into a Progress update, or null if it isn't one. */
export function parseProgressLine(line: string): Progress | { note: string } | null {
  const s = line.trim()
  if (s.startsWith(PGRESS + '|')) {
    const [, idx, total, pct, speed, eta, ...titleParts] = s.split('|')
    const percent = parseFloat((pct || '').replace('%', '').trim())
    const n = (v: string): number => {
      const x = parseInt(v, 10)
      return Number.isFinite(x) ? x : 0
    }
    return {
      index: n(idx) || 1,
      total: n(total) || 1,
      percent: Number.isFinite(percent) ? percent : 0,
      speed: (speed || '').trim(),
      eta: (eta || '').trim(),
      title: titleParts.join('|').trim()
    }
  }
  // Human-readable status lines worth surfacing.
  const m = s.match(/^\[(download|Merger|ExtractAudio|youtube:tab|info)\]\s+(.*)$/)
  if (m) {
    const msg = m[2]
    if (/Destination:|Downloading item|Merging|Extracting audio|Downloading \d+ items/.test(msg))
      return { note: msg }
  }
  return null
}

/* -------------------------------- spawning ------------------------------- */

export interface ProcResult {
  ok: boolean
  code: number | null
  cancelled: boolean
  stderrTail: string
}

/** Spawn yt-dlp; stream stdout lines to onLine; resolve on close. No timeout. */
export function spawnYtDlp(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  register: (child: ChildProcess) => void
): Promise<ProcResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (err) {
      resolve({ ok: false, code: null, cancelled: false, stderrTail: String(err) })
      return
    }
    register(child)
    let stdoutBuf = ''
    let stderrTail = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBuf += d.toString()
      const lines = stdoutBuf.split(/\r?\n/)
      stdoutBuf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000)
    })
    child.on('error', (err) => {
      resolve({ ok: false, code: null, cancelled: false, stderrTail: stderrTail + '\n' + String(err) })
    })
    child.on('close', (code) => {
      if (stdoutBuf.trim()) onLine(stdoutBuf)
      resolve({ ok: code === 0, code, cancelled: child.killed, stderrTail })
    })
  })
}

export function isBinaryTooOld(path: string): boolean {
  try {
    // if older than ~45 days, suggest an update (YouTube breaks stale copies)
    const age = Date.now() - statSync(path).mtimeMs
    return age > 45 * 24 * 3600 * 1000
  } catch {
    return false
  }
}

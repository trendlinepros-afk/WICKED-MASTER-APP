import { spawn, type ChildProcess } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  binDir,
  buildDownloadArgs,
  downloadDeno,
  downloadYtDlp,
  hasJsRuntime,
  hasYtDlp,
  isAudioQuality,
  isBinaryTooOld,
  parseProgressLine,
  parseYtUrl,
  resolveFfmpeg,
  resolveFfprobe,
  spawnYtDlp,
  treeKill,
  ytDlpCmd,
  ytDlpPath,
  type DownloadRequest
} from './ipc/ytdlp'
import { canvasFor, collectOutputs, combineClips, sanitizeName } from './ipc/combine'
import { DRIVE_ROOT_NAME, DriveSink, leftoverMedia, readDoneList, type DriveProgress } from './ipc/drive'
import { getDriveProvider } from '../file-vault/ipc/shared'
import { DriveApiError, findByName, findOrCreateSubfolder, getFileMeta, listFolder, md5File, resumableUpload, trashFile } from '../file-vault/ipc/gdrive'
import { MusicBrainz, mbUserAgent } from './ipc/musicbrainz'
import { extractArt, probeSong, readImage, writeSongTags, type Art } from './ipc/tagio'
import { ReviewStore, TagFixer, type ReadyInfo, type TagFixDeps } from './ipc/tagfix'
import { DEVICE_ID, SongLibrary, artistFolder, songFileName, docSignature, findDownloadedSongs, parseSongFileName, videoIdOf, AUDIO_EXT, type LibrarySong, type ListDoc } from './ipc/library'
import { assessTags, emptyTags, sanitizeTags, type ArtChoice, type ReviewItem, type SongTags, type TagSummary } from './lib/songinfo'

/* ------------------------------------------------------------------------ *
 *  YT DOWNLOADER — main process.
 *
 *  Drives yt-dlp (managed in userData, see ipc/ytdlp.ts) + the suite's bundled
 *  ffmpeg. Probe reads a URL's metadata (video vs playlist, title, count).
 *  Download spawns yt-dlp and streams progress to the renderer — it is a
 *  long-lived child with NO timeout, so multi-hour playlist downloads run to
 *  completion. Up to MAX_JOBS downloads run concurrently; each is a tracked
 *  job (jobId) whose progress events are tagged and which cancels
 *  independently.
 *
 *  CRASH RESUME: every started job is journaled to pending-jobs.json and
 *  cleared on completion/cancel. If the app (or the whole PC) dies mid-job,
 *  the journal survives — on the next launch those jobs restart themselves:
 *  yt-dlp skips finished files and continues half-downloaded ones, and the
 *  job's original manifest (kept across the crash) still feeds the combine.
 *  job-start / job-end events keep the UI in sync with resumed jobs.
 * ------------------------------------------------------------------------ */

const ID = 'yt-downloader'
const DIR_KEY = `${ID}.downloadDir`
const MUSIC_AUDIO_ONLY_KEY = `${ID}.musicAudioOnly`
const MUSIC_FORMAT_KEY = `${ID}.musicFormat`
const COMBINE_KEY = `${ID}.combineClips`
const COMBINE_SHUFFLE_KEY = `${ID}.combineShuffle`
const FIX_TAGS_KEY = `${ID}.fixTags`
const OFFICIAL_ART_KEY = `${ID}.officialArt`
const SKIP_DUPES_KEY = `${ID}.skipDuplicates`
const PROBE_TIMEOUT_MS = 90_000
const MAX_JOBS = 2
const WATCH_EVERY_MS = 48 * 3600 * 1000
const WATCH_TICK_MS = 15 * 60 * 1000
const RESUME_DELAY_MS = 8000
const MAX_RESUME_ATTEMPTS = 3

interface PendingJob {
  jobId: string
  url: string
  quality: string
  isPlaylist: boolean
  combine: boolean
  shuffle?: boolean
  /** upload to Google Drive (File Vault's connection) instead of keeping files locally */
  toDrive?: boolean
  /** "Fix missing song info" (MusicBrainz) for audio downloads */
  fixTags?: boolean
  officialArt?: boolean
  /** music: skip songs already in the downloaded-songs list */
  skipDuplicates?: boolean
  /** started by a watched playlist (its own persistent yt-dlp archive) */
  watchId?: string
  title: string
  startedAt: number
  attempts: number
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function register(ctx: ModuleIpcContext): void {
  // One entry per running download. `child` is whatever process the job is on
  // right now (yt-dlp, then ffprobe/ffmpeg during combine); cancel kills it and
  // flips cancelRequested so the job's combine loop stops too.
  interface Job {
    child: ChildProcess | null
    cancelRequested: boolean
    /** extra cancel work (a Drive job aborts its in-flight upload) */
    onCancel?: () => void
  }
  const jobs = new Map<string, Job>()
  /** set on app quit: running jobs stay journaled (and Drive staging stays) for resume */
  let quitting = false

  const userData = (): string => ctx.app.getPath('userData')
  const moduleDir = (): string => join(userData(), 'modules', ID)
  const pendingFile = (): string => join(moduleDir(), 'pending-jobs.json')
  const manifestPathFor = (jobId: string): string => join(moduleDir(), `combine-manifest-${jobId}.txt`)

  /* -------------------- crash-resume journal (pending jobs) ---------------- */

  const readPending = (): PendingJob[] => {
    try {
      const j = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { jobs?: unknown }
      return Array.isArray(j.jobs) ? (j.jobs as PendingJob[]) : []
    } catch {
      return []
    }
  }
  const savePending = (list: PendingJob[]): void => {
    mkdirSync(moduleDir(), { recursive: true })
    // temp + rename: a crash mid-write must never corrupt the resume journal
    const tmp = `${pendingFile()}.tmp`
    writeFileSync(tmp, JSON.stringify({ jobs: list }, null, 2), 'utf8')
    renameSync(tmp, pendingFile())
  }
  const addPending = (p: PendingJob): void => {
    savePending([...readPending().filter((x) => x.jobId !== p.jobId), p])
  }
  const removePending = (jobId: string): void => {
    savePending(readPending().filter((x) => x.jobId !== jobId))
  }

  // Songs MusicBrainz couldn't identify wait here for the user (review.json).
  const review = new ReviewStore(join(moduleDir(), 'review.json'), (items) => send(`${ID}:review`, items))
  // one shared client: MusicBrainz allows 1 request/second per app
  const mb = new MusicBrainz(mbUserAgent(ctx.app.getVersion()))
  // every song ever downloaded (so the same song is never downloaded twice)
  const library = new SongLibrary(join(moduleDir(), 'downloaded-songs.json'), (total) => send(`${ID}:library-count`, total))

  // Drive jobs download into <temp>/WICKED YouTube to Drive/<jobId>; a folder
  // whose job isn't about to resume (and holds no song waiting for review) is
  // leftover scratch.
  const stagingRoot = (): string => join(ctx.app.getPath('temp'), 'WICKED YouTube to Drive')
  const stagingDirFor = (jobId: string): string => join(stagingRoot(), jobId)
  try {
    const keep = new Set([...survivorsForStaging().map((p) => p.jobId), ...review.list().filter((i) => i.toDrive).map((i) => i.jobId)])
    for (const name of readdirSync(stagingRoot())) if (!keep.has(name)) rmSync(join(stagingRoot(), name), { recursive: true, force: true })
  } catch {
    /* nothing staged */
  }
  function survivorsForStaging(): PendingJob[] {
    return readPending().filter((p) => p.toDrive)
  }

  // Sweep ffmpeg scratch left by interrupted combines — but KEEP manifests that
  // belong to journaled (about-to-resume) jobs: they list the files downloaded
  // before the crash, which the resumed combine still needs.
  const survivors = readPending()
  const keepManifests = new Set(survivors.map((p) => `combine-manifest-${p.jobId}.txt`))
  try {
    for (const name of readdirSync(moduleDir())) {
      if (/^combine-(tmp|manifest-)/.test(name) && !keepManifests.has(name)) {
        rmSync(join(moduleDir(), name), { recursive: true, force: true })
        console.log(`[${ID}] removed stale combine scratch: ${name}`)
      }
    }
  } catch {
    /* module dir may not exist yet */
  }

  const defaultDownloadDir = (): string => join(ctx.app.getPath('downloads'), 'WICKED YouTube')
  const downloadDir = (): string => {
    const v = ctx.storeGet<string>(DIR_KEY, '')
    return v && v.trim() ? v : defaultDownloadDir()
  }

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  /** YouTube extraction needs a JS runtime (deno beside yt-dlp) since 2026 —
   *  fetch it once on demand. Failure is soft: yt-dlp's own error still shows. */
  const ensureJsRuntime = async (): Promise<void> => {
    if (hasJsRuntime(userData())) return
    send(`${ID}:status-msg`, 'Downloading the YouTube JS runtime (Deno) — one-time setup…')
    const res = await downloadDeno(userData())
    if (!res.ok) send(`${ID}:status-msg`, `Could not download the JS runtime: ${res.error ?? 'unknown error'}`)
  }

  /* ------------------------------- status -------------------------------- */

  ctx.ipcMain.handle(`${ID}:status`, async () => {
    const ud = userData()
    const ready = hasYtDlp(ud)
    let version: string | null = null
    if (ready) {
      version = await new Promise<string | null>((resolve) => {
        try {
          const c = spawn(ytDlpCmd(ud), ['--version'], { windowsHide: true })
          let out = ''
          c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
          c.on('error', () => resolve(null))
          c.on('close', () => resolve(out.trim() || null))
        } catch {
          resolve(null)
        }
      })
    }
    return {
      ok: true,
      binReady: ready,
      binPath: ytDlpPath(ud),
      version,
      stale: ready ? isBinaryTooOld(ytDlpPath(ud)) : false,
      ffmpegReady: resolveFfmpeg() !== null,
      jsRuntimeReady: hasJsRuntime(ud),
      downloadDir: downloadDir(),
      busy: jobs.size > 0,
      activeJobs: jobs.size,
      maxJobs: MAX_JOBS,
      // "Download to Google Drive" availability (File Vault's connection)
      googleDrive: (() => {
        const st = getDriveProvider()?.status() ?? { connected: false, email: '' }
        return { connected: st.connected, email: st.email, folder: `WICKED Vault/${DRIVE_ROOT_NAME}` }
      })()
    }
  })

  ctx.ipcMain.handle(`${ID}:ensure`, async () => {
    const ud = userData()
    if (hasYtDlp(ud)) {
      await ensureJsRuntime()
      return { ok: true, already: true }
    }
    send(`${ID}:status-msg`, 'Downloading yt-dlp (one-time setup)…')
    const res = await downloadYtDlp(ud)
    await ensureJsRuntime()
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })

  ctx.ipcMain.handle(`${ID}:update`, async () => {
    send(`${ID}:status-msg`, 'Updating yt-dlp to the latest release…')
    const res = await downloadYtDlp(userData())
    // refresh the JS runtime alongside (and fetch it if it was never installed)
    send(`${ID}:status-msg`, 'Updating the YouTube JS runtime (Deno)…')
    const deno = await downloadDeno(userData())
    if (!deno.ok) send(`${ID}:status-msg`, `Could not update the JS runtime: ${deno.error ?? 'unknown error'}`)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })

  /* ------------------------------- prefs --------------------------------- *
   * Persisted module preferences (shell store, `<module-id>.` prefixed).
   * "Audio only for YouTube Music links" is ON by default: a music.youtube.com
   * link is a song, so grabbing video is almost never what's wanted.
   * ---------------------------------------------------------------------- */

  const prefs = (): { musicAudioOnly: boolean; musicFormat: string; combineClips: boolean; combineShuffle: boolean; fixTags: boolean; officialArt: boolean; skipDuplicates: boolean } => {
    const fmt = ctx.storeGet<string>(MUSIC_FORMAT_KEY, 'audio')
    return {
      musicAudioOnly: ctx.storeGet<boolean>(MUSIC_AUDIO_ONLY_KEY, true) !== false,
      musicFormat: fmt === 'audio-native' ? 'audio-native' : 'audio',
      combineClips: ctx.storeGet<boolean>(COMBINE_KEY, false) === true,
      combineShuffle: ctx.storeGet<boolean>(COMBINE_SHUFFLE_KEY, false) === true,
      // "Fix missing song info" + official album art: ON by default for music
      fixTags: ctx.storeGet<boolean>(FIX_TAGS_KEY, true) !== false,
      officialArt: ctx.storeGet<boolean>(OFFICIAL_ART_KEY, true) !== false,
      skipDuplicates: ctx.storeGet<boolean>(SKIP_DUPES_KEY, true) !== false
    }
  }

  ctx.ipcMain.handle(`${ID}:prefs-get`, () => ({ ok: true, ...prefs() }))

  ctx.ipcMain.handle(`${ID}:prefs-set`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof r.musicAudioOnly === 'boolean') ctx.storeSet(MUSIC_AUDIO_ONLY_KEY, r.musicAudioOnly)
    if (r.musicFormat === 'audio' || r.musicFormat === 'audio-native')
      ctx.storeSet(MUSIC_FORMAT_KEY, r.musicFormat)
    if (typeof r.combineClips === 'boolean') ctx.storeSet(COMBINE_KEY, r.combineClips)
    if (typeof r.combineShuffle === 'boolean') ctx.storeSet(COMBINE_SHUFFLE_KEY, r.combineShuffle)
    if (typeof r.fixTags === 'boolean') ctx.storeSet(FIX_TAGS_KEY, r.fixTags)
    if (typeof r.officialArt === 'boolean') ctx.storeSet(OFFICIAL_ART_KEY, r.officialArt)
    if (typeof r.skipDuplicates === 'boolean') ctx.storeSet(SKIP_DUPES_KEY, r.skipDuplicates)
    return { ok: true, ...prefs() }
  })

  /* -------------------------------- folder ------------------------------- */

  ctx.ipcMain.handle(`${ID}:pick-folder`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Choose where to save downloads',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: downloadDir()
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    ctx.storeSet(DIR_KEY, res.filePaths[0])
    return { ok: true, downloadDir: res.filePaths[0] }
  })

  ctx.ipcMain.handle(`${ID}:open-folder`, async () => {
    const dir = downloadDir()
    mkdirSync(dir, { recursive: true })
    await ctx.shell.openPath(dir)
    return { ok: true }
  })

  /* ----------------------------- google drive ---------------------------- */

  // "Download to Google Drive" uses File Vault's connection (token only).
  ctx.ipcMain.handle(`${ID}:drive-status`, () => {
    const d = getDriveProvider()
    const st = d?.status() ?? { connected: false, email: '' }
    return { ok: true, available: !!d, connected: st.connected, email: st.email, folder: `WICKED Vault/${DRIVE_ROOT_NAME}` }
  })

  ctx.ipcMain.handle(`${ID}:open-drive`, async (_e, raw: unknown) => {
    const url = typeof raw === 'string' && /^https:\/\/drive\.google\.com\//.test(raw) ? raw : 'https://drive.google.com/drive/my-drive'
    await ctx.shell.openExternal(url)
    return { ok: true }
  })

  type Provider = NonNullable<ReturnType<typeof getDriveProvider>>
  function driveDeps(drive: Provider): ConstructorParameters<typeof DriveSink>[1] {
    return {
      getToken: drive.getToken,
      vaultFolderId: drive.vaultFolderId,
      findOrCreateSubfolder,
      findByName,
      upload: (o) => resumableUpload({ ...o, getToken: drive.getToken }),
      md5File
    }
  }

  /* --------------------- song info (MusicBrainz) + review -------------------- */

  function tagDeps(ffmpeg: string, ffprobe: string): TagFixDeps {
    return {
      probe: (path) => probeSong(ffprobe, path),
      find: (q, durationMs) => mb.find(q, durationMs),
      genre: (rgId) => mb.genre(rgId),
      cover: (releaseId, rgId) => mb.coverArt(releaseId, rgId, 500),
      write: (path, probed, t, art) => writeSongTags(ffmpeg, path, probed, t, art)
    }
  }

  /** Keep only the songs still waiting for review in a Drive job's staging folder. */
  function pruneStaging(jobId: string): void {
    const held = review.forJob(jobId).map((i) => i.path)
    const walk = (d: string): void => {
      let names: string[] = []
      try {
        names = readdirSync(d)
      } catch {
        return
      }
      for (const n of names) {
        const f = join(d, n)
        try {
          if (statSync(f).isDirectory()) walk(f)
          else if (!held.some((h) => relative(h, f) === '')) rmSync(f, { force: true })
        } catch {
          /* locked — swept later */
        }
      }
    }
    walk(stagingDirFor(jobId))
  }

  const dataUrl = (a: Art): string => `data:${a.mime};base64,${a.data.toString('base64')}`

  /**
   * File a finished song as <base>/<Artist>/<Title> [<id>].<ext> (its cover
   * thumbnail moves along). The artist folder is created when missing; the
   * playlist folder yt-dlp used is removed once empty. Returns the new path.
   */
  function fileUnderArtist(path: string, base: string, tags: { title?: string; artist?: string; albumArtist?: string }, leftDirs?: Set<string>): string {
    const vid = videoIdOf(basename(path))
    if (!vid || !existsSync(path)) return path
    const ext = path.slice(path.lastIndexOf('.'))
    // no artist tag: the "<artist> - <title>" yt-dlp put in the file name
    const named = parseSongFileName(basename(path))
    const artist = tags.albumArtist || tags.artist || named.artist
    // no artist anywhere, but already in a folder of its own (filed earlier): keep that folder
    const folder = !artist && relative(base, dirname(path)) && !/[\\/]/.test(relative(base, dirname(path))) && !relative(base, dirname(path)).startsWith('..') ? basename(dirname(path)) : artistFolder({ artist })
    // "Artist - Song (Official Video)" as the title: drop the repeated artist
    let title = tags.title || named.title
    if (artist && title.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) title = title.slice(artist.length + 3)
    const dest = join(base, folder, songFileName(title, vid, ext))
    if (relative(dest, path) === '') return path
    try {
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(path, dest)
    } catch {
      return path // keep it where it is rather than lose it
    }
    const oldDir = dirname(path)
    const oldStem = basename(path).slice(0, -ext.length)
    const newStem = basename(dest).slice(0, -ext.length)
    try {
      for (const n of readdirSync(oldDir))
        if (n.startsWith(`${oldStem}.`) && /\.(jpe?g|png|webp)$/i.test(n)) renameSync(join(oldDir, n), join(dirname(dest), newStem + n.slice(oldStem.length)))
    } catch {
      /* the cover is optional */
    }
    // yt-dlp may still be writing into it: a running job removes it at the end
    if (leftDirs) leftDirs.add(oldDir)
    else removeIfEmpty(oldDir, base)
    return dest
  }

  /** remove a playlist folder under `base` that filing songs by artist left empty */
  function removeIfEmpty(dir: string, base: string): void {
    try {
      if (relative(base, dir) && !relative(base, dir).startsWith('..') && !readdirSync(dir).some((n) => !n.startsWith('.'))) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }

  /** Delete a duplicate song and its same-name cover thumbnail. */
  function removeSongFile(path: string): void {
    rmSync(path, { force: true })
    const stem = basename(path).replace(/\.[^.]+$/, '')
    try {
      for (const n of readdirSync(dirname(path)))
        if (n.startsWith(`${stem}.`) && /\.(jpe?g|png|webp)$/i.test(n)) rmSync(join(dirname(path), n), { force: true })
    } catch {
      /* best-effort */
    }
  }

  /* --------------------------- downloaded songs --------------------------- */

  /** Add songs already on disk / in Drive (from before the list existed).
   *  The automatic first-run scan skips songs you removed from the list on
   *  purpose (their file may still be on disk); the button re-adds everything. */
  async function scanExisting(includeDrive: boolean, keepRemoved = false): Promise<{ local: number; drive: number; error?: string }> {
    let local = 0
    let drive = 0
    const skip = (id: string): boolean => library.has(id) || (keepRemoved && library.isForgotten(id))
    for (const f of findDownloadedSongs(downloadDir())) {
      if (skip(f.videoId)) continue
      const { artist, title } = parseSongFileName(f.fileName)
      library.record({ videoId: f.videoId, title, artist, album: '', originalTitle: title, originalArtist: artist, recordingId: '', durationMs: null, fileName: f.fileName, location: 'local', path: f.path, driveFileId: '', playlist: basename(dirname(f.path)), jobId: '', downloadedAt: Date.now(), device: DEVICE_ID })
      local++
    }
    const d = includeDrive ? getDriveProvider() : null
    if (d?.status().connected)
      try {
        const token = await d.getToken()
        const root = await findOrCreateSubfolder(token, DRIVE_ROOT_NAME, await d.vaultFolderId())
        const walk = async (folderId: string, folderName: string, depth: number): Promise<void> => {
          if (depth > 4) return
          for (const f of await listFolder(token, folderId)) {
            if (f.mimeType === 'application/vnd.google-apps.folder') await walk(f.id, f.name, depth + 1)
            else {
              const id = videoIdOf(f.name)
              const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
              if (!id || !AUDIO_EXT.has(ext) || skip(id)) continue
              const { artist, title } = parseSongFileName(f.name)
              library.record({ videoId: id, title, artist, album: '', originalTitle: title, originalArtist: artist, recordingId: '', durationMs: null, fileName: f.name, location: 'drive', path: '', driveFileId: f.id, playlist: folderName, jobId: '', downloadedAt: Date.now() })
              drive++
            }
          }
        }
        await walk(root, DRIVE_ROOT_NAME, 0)
      } catch (err) {
        library.flush()
        return { local, drive, error: `Couldn’t read Google Drive: ${errMsg(err)}` }
      }
    library.flush()
    return { local, drive }
  }
  // first run with the list: pick up what's already in the download folder —
  // once no download is running (a running job lists its own songs properly)
  if (library.fresh) {
    const firstScan = (): void => {
      if (jobs.size > 0) return void setTimeout(firstScan, 30_000)
      void scanExisting(false, true)
    }
    setTimeout(firstScan, 4000)
  }

  ctx.ipcMain.handle(`${ID}:library-list`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { query?: unknown; limit?: unknown; offset?: unknown; ids?: unknown }
    const limit = Math.max(1, Math.min(1000, Number(r.limit) || 200))
    const ids = Array.isArray(r.ids) ? r.ids.map(String) : undefined
    return { ok: true, ...library.list(typeof r.query === 'string' ? r.query : '', limit, Math.max(0, Number(r.offset) || 0), ids), syncedAt: listSync.at, syncError: listSync.error }
  })

  /** forget songs (or all) so they can be downloaded again — files are not touched */
  ctx.ipcMain.handle(`${ID}:library-forget`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { videoIds?: unknown; all?: unknown }
    const n = r.all === true ? library.forgetAll() : Array.isArray(r.videoIds) ? library.forget(r.videoIds.map(String)) : 0
    library.flush()
    void syncListWithDrive()
    return { ok: true, forgotten: n, total: library.size }
  })

  ctx.ipcMain.handle(`${ID}:library-scan`, async () => ({ ok: true, ...(await scanExisting(true)), total: library.size }))

  /* ---- is a listed song really still there? (so a stale entry never blocks a download) ---- */

  type StaleSong = LibrarySong & { reason: string }

  /**
   * Songs on the list whose file is gone: a Drive file that was deleted /
   * trashed, a file on THIS PC that isn't there any more, or an upload that
   * never finished (its job isn't running, journaled or waiting for song info).
   * Songs on another PC can't be checked from here and are trusted.
   */
  async function findStale(entries: LibrarySong[]): Promise<StaleSong[]> {
    const out: StaleSong[] = []
    const journaled = new Set(readPending().map((x) => x.jobId))
    const driveOnes: LibrarySong[] = []
    for (const s of entries) {
      if (s.location === 'pending') {
        if (!jobs.has(s.jobId) && !journaled.has(s.jobId) && !(s.path && review.isHeld(s.path))) out.push({ ...s, reason: 'its upload never finished' })
      } else if (s.location === 'local') {
        // a path from before device ids: only judge it if its folder exists on this PC
        const mine = s.device ? s.device === DEVICE_ID : !!s.path && existsSync(dirname(s.path))
        if (mine && s.path && !existsSync(s.path)) out.push({ ...s, reason: 'it’s no longer on this PC' })
      } else if (s.location === 'drive' && s.driveFileId) driveOnes.push(s)
    }
    const d = getDriveProvider()
    if (driveOnes.length && d?.status().connected) {
      const token = await d.getToken()
      const queue = [...driveOnes]
      const worker = async (): Promise<void> => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          try {
            const meta = await getFileMeta(token, s.driveFileId)
            if (meta.trashed) out.push({ ...s, reason: 'it’s in Google Drive’s trash' })
          } catch (err) {
            if (err instanceof DriveApiError && err.status === 404) out.push({ ...s, reason: 'it’s no longer in Google Drive' })
            /* other errors (offline, rate limit): trust the list */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(8, driveOnes.length) }, worker))
    }
    return out
  }

  /** Take stale songs off the list (so they download again). */
  function dropStale(stale: StaleSong[]): void {
    if (!stale.length) return
    library.forget(stale.map((s) => s.videoId))
    library.flush()
    void syncListWithDrive()
  }

  const songLabel = (s: LibrarySong): string => `“${s.title || s.fileName}”${s.artist ? ` — ${s.artist}` : ''}`
  const whereIs = (s: LibrarySong): string =>
    s.location === 'drive' ? `in Google Drive · ${s.playlist}` : s.location === 'pending' ? 'still uploading / waiting for info' : s.device && s.device !== DEVICE_ID ? `on another PC · ${s.playlist}` : `on this PC · ${s.playlist}`

  /** Video ids a URL will download (flat playlist read; [] if it can't be read). */
  async function readUrl(url: string, isPlaylist: boolean): Promise<{ ids: string[]; title: string }> {
    const ud = userData()
    if (!hasYtDlp(ud)) return { ids: [], title: '' }
    const r = await probeJson(ud, url, isPlaylist ? [] : ['--no-playlist'])
    if (!r.ok) return { ids: [], title: '' }
    const j = r.json
    const title = String(j.title ?? '')
    if (Array.isArray(j.entries)) return { ids: (j.entries as { id?: unknown }[]).map((e) => String(e?.id ?? '')).filter(Boolean), title }
    return { ids: j.id ? [String(j.id)] : [], title }
  }

  /** Which of these ids are already downloaded — after dropping stale entries. */
  async function checkKnown(ids: string[]): Promise<{ known: LibrarySong[]; stale: StaleSong[] }> {
    const seen = new Set<string>()
    const listed = ids.map((id) => library.get(id)).filter((s): s is LibrarySong => !!s && !seen.has(s.videoId) && !!seen.add(s.videoId))
    const stale = await findStale(listed)
    dropStale(stale)
    const goneIds = new Set(stale.map((s) => s.videoId))
    return { known: listed.filter((s) => !goneIds.has(s.videoId)), stale }
  }

  ctx.ipcMain.handle(`${ID}:library-check`, async () => {
    const all = library.list('', Number.MAX_SAFE_INTEGER).items
    const stale = await findStale(all)
    dropStale(stale)
    return { ok: true, checked: all.length, removed: stale.length, items: stale.slice(0, 50).map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, playlist: s.playlist, reason: s.reason })), total: library.size }
  })

  // after crash-resumes have had their chance, clear uploads that will never finish
  setTimeout(() => {
    void findStale(library.list('', Number.MAX_SAFE_INTEGER).items.filter((s) => s.location === 'pending')).then(dropStale)
  }, RESUME_DELAY_MS + 60_000)

  /* ---- shared through Google Drive: every PC with Drive connected sees every PC's downloads ---- */

  const DRIVE_LIST_NAME = '.wicked-downloaded-songs.json'
  const listSync = { at: 0, error: '' }
  let listSyncChain: Promise<void> = Promise.resolve()

  /** Merge the Drive copy into this PC's list, then upload the result if they differed. One at a time. */
  function syncListWithDrive(): Promise<void> {
    const run = listSyncChain.then(async () => {
      const d = getDriveProvider()
      if (!d?.status().connected) {
        listSync.error = 'not-connected'
        return
      }
      try {
        const token = await d.getToken()
        const folder = await findOrCreateSubfolder(token, DRIVE_ROOT_NAME, await d.vaultFolderId())
        // two PCs syncing at the same moment can each create the file — read
        // every copy, merge them all, keep the oldest and trash the rest
        const q = encodeURIComponent(`name = '${DRIVE_LIST_NAME}' and '${folder.replace(/'/g, "\\'")}' in parents and trashed = false`)
        const lr = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=${encodeURIComponent('files(id,createdTime)')}&orderBy=createdTime&pageSize=20`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30_000)
        })
        if (!lr.ok) throw new Error(`Couldn’t look for the shared list (HTTP ${lr.status})`)
        const copies = (((await lr.json()) as { files?: { id: string }[] }).files ?? []).filter((f) => f?.id)
        const remoteFile = copies[0]
        let remoteSig = ''
        for (const [i, c] of copies.entries()) {
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(c.id)}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(60_000)
          })
          if (!r.ok) throw new Error(`Couldn’t read the shared list (HTTP ${r.status})`)
          const raw = (await r.json()) as Partial<ListDoc>
          const doc: ListDoc = { version: 2, songs: Array.isArray(raw.songs) ? raw.songs : [], forgotten: raw.forgotten && typeof raw.forgotten === 'object' ? raw.forgotten : {} }
          if (i === 0) remoteSig = docSignature(doc)
          else remoteSig = 'merged-extra-copies' // force an upload of the merged result
          library.mergeIn(doc)
        }
        for (const extra of copies.slice(1))
          try {
            await trashFile(token, extra.id)
          } catch {
            /* next sync tries again */
          }
        if (library.signature() !== remoteSig) {
          const tmp = join(ctx.app.getPath('temp'), `wicked-downloaded-songs-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.json`)
          mkdirSync(dirname(tmp), { recursive: true })
          writeFileSync(tmp, JSON.stringify(library.toDoc()), 'utf8')
          try {
            await resumableUpload({ localPath: tmp, size: statSync(tmp).size, name: DRIVE_LIST_NAME, folderId: folder, existingFileId: remoteFile?.id, getToken: d.getToken, signal: AbortSignal.timeout(120_000), onProgress: () => undefined })
          } finally {
            rmSync(tmp, { force: true })
          }
        }
        library.flush()
        listSync.at = Date.now()
        listSync.error = ''
      } catch (err) {
        listSync.error = errMsg(err)
        console.error(`[${ID}] downloaded-songs list sync with Google Drive failed:`, err)
      }
    })
    listSyncChain = run.catch(() => undefined)
    return run
  }
  /** don't let a slow Drive hold a download up for long */
  const syncListQuick = (ms = 20_000): Promise<void> => Promise.race([syncListWithDrive(), new Promise<void>((r) => setTimeout(r, ms))])
  setTimeout(() => void syncListWithDrive(), 6000)

  ctx.ipcMain.handle(`${ID}:library-sync`, async () => {
    await syncListQuick(30_000)
    return { ok: !listSync.error || listSync.error === 'not-connected', total: library.size, syncedAt: listSync.at, error: listSync.error }
  })

  /** delete songs: the file goes to the Recycle Bin (this PC) or Drive's trash, and it leaves the list */
  ctx.ipcMain.handle(`${ID}:library-delete`, async (_e, raw: unknown) => {
    const ids = Array.isArray((raw as { videoIds?: unknown })?.videoIds) ? (raw as { videoIds: unknown[] }).videoIds.map(String) : []
    let deleted = 0
    const errors: string[] = []
    for (const id of ids) {
      const s = library.get(id)
      if (!s) continue
      try {
        if (s.location === 'pending') throw new Error(`“${s.title || s.fileName}” is still uploading or waiting for song info — finish or cancel that first.`)
        if (s.location === 'local' && s.path && existsSync(s.path)) {
          await ctx.shell.trashItem(s.path)
          const stem = basename(s.path).replace(/\.[^.]+$/, '')
          try {
            for (const n of readdirSync(dirname(s.path)))
              if (n.startsWith(`${stem}.`) && /\.(jpe?g|png|webp)$/i.test(n)) await ctx.shell.trashItem(join(dirname(s.path), n))
          } catch {
            /* cover thumbnail is optional */
          }
        } else if (s.location === 'drive' && s.driveFileId) {
          const d = getDriveProvider()
          if (!d?.status().connected) throw new Error('Google Drive isn’t connected — connect it in File Vault to delete Drive songs.')
          try {
            await trashFile(await d.getToken(), s.driveFileId)
          } catch (err) {
            if (!/404|not ?found/i.test(errMsg(err))) throw err // already gone from Drive is fine
          }
        }
        library.forget([s.videoId])
        deleted++
      } catch (err) {
        errors.push(errMsg(err))
      }
    }
    library.flush()
    void syncListWithDrive()
    return { ok: errors.length === 0, deleted, failed: errors.length, error: errors[0], total: library.size }
  })

  /* ---- sort songs already downloaded into <Artist>/<Title> [id] (Drive + this PC) ---- */

  const NUMBERED = /^\d{2,4}\s+-\s+/
  let organizing = false

  /** artist + title to file a song by: the list's (fixed) details, else its file name */
  function songIdentity(vid: string, fileName: string): { artist: string; title: string } {
    const s = library.get(vid)
    const parsed = parseSongFileName(fileName)
    return { artist: s?.artist || parsed.artist, title: s?.title || parsed.title }
  }

  async function driveMove(token: string, fileId: string, name: string, from: string, to: string): Promise<void> {
    const qs = from === to ? '' : `&addParents=${encodeURIComponent(to)}&removeParents=${encodeURIComponent(from)}`
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id${qs}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(30_000)
    })
    if (!r.ok) throw new DriveApiError(r.status, '', `Couldn’t move ${name} in Google Drive (HTTP ${r.status})`)
  }

  async function organizeSongs(): Promise<{ moved: number; already: number; duplicates: number; failed: number; foldersRemoved: number; error?: string }> {
    const res = { moved: 0, already: 0, duplicates: 0, failed: 0, foldersRemoved: 0, error: undefined as string | undefined }
    const progress = (done: number, total: number, current: string): void => send(`${ID}:organize`, { done, total, current })

    // ---- this PC ----
    const base = downloadDir()
    const localSongs = findDownloadedSongs(base)
    for (const [i, f] of localSongs.entries()) {
      progress(i, localSongs.length, f.fileName)
      if (review.isHeld(f.path)) continue // waiting for song info — filed when saved
      const inArtistDir = relative(base, dirname(f.path)).split(/[\\/]/).length === 1 && dirname(f.path) !== base
      const id = songIdentity(f.videoId, f.fileName)
      // a name with no number, already one folder deep, and no artist known: already filed
      if (!id.artist && inArtistDir && !NUMBERED.test(f.fileName)) {
        res.already++
        continue
      }
      const dest = join(base, artistFolder(id), songFileName(id.title, f.videoId, f.path.slice(f.path.lastIndexOf('.'))))
      if (relative(dest, f.path) === '') {
        res.already++
        continue
      }
      if (existsSync(dest)) {
        // the same video twice: keep the one already filed
        await ctx.shell.trashItem(f.path).catch(() => undefined)
        const s = library.get(f.videoId)
        if (s?.location === 'local' && s.path && relative(s.path, f.path) === '') library.update(f.videoId, { path: dest, fileName: basename(dest) })
        res.duplicates++
        continue
      }
      const now = fileUnderArtist(f.path, base, id)
      if (now === f.path) res.failed++
      else {
        res.moved++
        const s = library.get(f.videoId)
        if (s && s.location === 'local' && (!s.path || relative(s.path, f.path) === '')) library.update(f.videoId, { path: now, fileName: basename(now) })
      }
    }
    library.flush()

    // ---- Google Drive ----
    const d = getDriveProvider()
    if (d?.status().connected)
      try {
        const token = await d.getToken()
        const root = await findOrCreateSubfolder(token, DRIVE_ROOT_NAME, await d.vaultFolderId())
        type Found = { file: { id: string; name: string }; parent: string; depth: number }
        const songs: Found[] = []
        const covers: Found[] = []
        const folders: { id: string; depth: number }[] = []
        const walk = async (folderId: string, depth: number): Promise<void> => {
          if (depth > 4) return
          for (const f of await listFolder(token, folderId)) {
            if (f.mimeType === 'application/vnd.google-apps.folder') {
              folders.push({ id: f.id, depth: depth + 1 })
              await walk(f.id, depth + 1)
            } else if (videoIdOf(f.name)) {
              const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
              if (AUDIO_EXT.has(ext)) songs.push({ file: f, parent: folderId, depth })
              else if (/^\.(jpe?g|png|webp)$/.test(ext)) covers.push({ file: f, parent: folderId, depth })
            }
          }
        }
        await walk(root, 0)
        const artistIds = new Map<string, string>() // folder name → id
        const artistFolderId = async (name: string): Promise<string> => {
          let id = artistIds.get(name.toLowerCase())
          if (!id) {
            id = await findOrCreateSubfolder(token, name, root)
            artistIds.set(name.toLowerCase(), id)
          }
          return id
        }
        const taken = new Map<string, string>() // `${folderId}/${name}` → file id, for duplicates
        for (const f of songs) taken.set(`${f.parent}/${f.file.name.toLowerCase()}`, f.file.id)
        const filedTo = new Map<string, { folder: string; stem: string }>() // video id → where its song went
        const touched = new Set<string>()
        for (const [i, f] of songs.entries()) {
          progress(localSongs.length + i, localSongs.length + songs.length, f.file.name)
          const vid = videoIdOf(f.file.name)!
          const ext = f.file.name.slice(f.file.name.lastIndexOf('.'))
          const id = songIdentity(vid, f.file.name)
          try {
            let folder: string
            if (!id.artist && f.depth === 1 && !NUMBERED.test(f.file.name)) {
              res.already++
              continue
            } else folder = !id.artist && f.depth === 1 ? f.parent : await artistFolderId(artistFolder(id))
            const name = songFileName(id.title, vid, ext)
            filedTo.set(vid, { folder, stem: name.slice(0, -ext.length) })
            if (folder === f.parent && name === f.file.name) {
              res.already++
              continue
            }
            const clash = taken.get(`${folder}/${name.toLowerCase()}`)
            if (clash && clash !== f.file.id) {
              await trashFile(token, f.file.id) // the same video twice: keep the one already filed
              res.duplicates++
            } else {
              await driveMove(token, f.file.id, name, f.parent, folder)
              taken.set(`${folder}/${name.toLowerCase()}`, f.file.id)
              res.moved++
              const s = library.get(vid)
              if (s?.location === 'drive' && (!s.driveFileId || s.driveFileId === f.file.id)) library.update(vid, { fileName: name, driveFileId: f.file.id })
            }
            touched.add(f.parent)
          } catch (err) {
            res.failed++
            res.error ??= errMsg(err)
          }
        }
        // cover thumbnails follow their song
        for (const c of covers) {
          const to = filedTo.get(videoIdOf(c.file.name)!)
          if (!to) continue
          const name = to.stem + c.file.name.slice(c.file.name.lastIndexOf('.'))
          if (to.folder === c.parent && name === c.file.name) continue
          try {
            await driveMove(token, c.file.id, name, c.parent, to.folder)
            touched.add(c.parent)
          } catch {
            /* a cover is optional */
          }
        }
        // old playlist folders left empty → Drive's trash (deepest first)
        for (const f of folders.sort((a, b) => b.depth - a.depth)) {
          if (!touched.has(f.id)) continue
          try {
            if (!(await listFolder(token, f.id)).length) {
              await trashFile(token, f.id)
              res.foldersRemoved++
            }
          } catch {
            /* leave it */
          }
        }
      } catch (err) {
        res.error ??= `Couldn’t read Google Drive: ${errMsg(err)}`
      }
    library.flush()
    void syncListWithDrive()
    return res
  }

  ctx.ipcMain.handle(`${ID}:library-organize`, async () => {
    if (organizing) return { ok: false, error: 'Already sorting — give it a moment.' }
    if (jobs.size > 0) return { ok: false, error: 'Wait until the downloads running now finish, then sort.' }
    organizing = true
    try {
      const r = await organizeSongs()
      return { ok: !r.error, ...r, total: library.size }
    } finally {
      organizing = false
      send(`${ID}:organize`, null)
    }
  })

  /**
   * Finish a held song: optionally write the user's tags (+ cover), then upload
   * it if it came from a Drive job; drop it from the list once it's safe.
   */
  async function finalizeReview(item: ReviewItem, write: { tags: SongTags; art: ArtChoice } | null): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(item.path)) {
      review.remove(item.id)
      return { ok: false, error: `${item.fileName} is no longer there — removed from the list.` }
    }
    try {
      if (write) {
        const ffmpeg = resolveFfmpeg()
        const ffprobe = resolveFfprobe()
        if (!ffmpeg || !ffprobe) throw new Error('ffmpeg isn’t available, so tags can’t be written.')
        const probed = await probeSong(ffprobe, item.path)
        let art: Art | null = null
        if (write.art.kind === 'release') art = await mb.coverArt(write.art.releaseId, write.art.releaseGroupId, 500)
        else if (write.art.kind === 'file') art = readImage(write.art.path)
        await writeSongTags(ffmpeg, item.path, probed, write.tags, art)
        library.update(videoIdOf(item.fileName), { title: write.tags.title, artist: write.tags.artist, album: write.tags.album })
      }
      // file it under its artist (the details just saved, else what's in the file)
      const tagsNow = write?.tags ?? (await probeSong(resolveFfprobe() ?? '', item.path).then((x) => x.tags).catch(() => item.current.artist ? item.current : item.guess))
      const base = item.toDrive ? stagingDirFor(item.jobId) : downloadDir()
      const moved = fileUnderArtist(item.path, base, tagsNow)
      if (moved !== item.path) {
        review.update(item.id, { path: moved, fileName: basename(moved) })
        item = { ...item, path: moved, fileName: basename(moved) }
      }
      if (item.toDrive) {
        const drive = getDriveProvider()
        if (!drive?.status().connected) throw new Error('Google Drive isn’t connected — reconnect it in File Vault, then save again.')
        const s = new DriveSink(stagingDirFor(item.jobId), driveDeps(drive), () => undefined)
        s.add(item.path)
        await s.drain()
        if (s.failed.length) throw new Error(`Upload to Google Drive failed: ${s.failed[0].error}`)
        library.update(videoIdOf(item.fileName), { location: 'drive', driveFileId: s.uploaded[0]?.id ?? '', path: '' })
      } else library.update(videoIdOf(item.fileName), { location: 'local', path: item.path, fileName: item.fileName })
      library.flush()
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      review.update(item.id, { error })
      return { ok: false, error }
    }
    review.remove(item.id)
    if (item.toDrive && !review.forJob(item.jobId).length && !jobs.has(item.jobId))
      rmSync(stagingDirFor(item.jobId), { recursive: true, force: true })
    return { ok: true }
  }

  ctx.ipcMain.handle(`${ID}:review-list`, () => ({ ok: true, items: review.list() }))

  /** small preview of a held song's current cover */
  ctx.ipcMain.handle(`${ID}:review-art`, async (_e, raw: unknown) => {
    const item = review.get(String((raw as { id?: unknown })?.id ?? ''))
    const ffmpeg = resolveFfmpeg()
    if (!item || !ffmpeg || !existsSync(item.path)) return { ok: false }
    const art = await extractArt(ffmpeg, item.path, 300)
    return art ? { ok: true, dataUrl: dataUrl(art) } : { ok: false }
  })

  /** MusicBrainz candidates for what the user typed (ranked; not auto-applied) */
  ctx.ipcMain.handle(`${ID}:review-search`, async (_e, raw: unknown) => {
    const r = (raw ?? {}) as { id?: string; title?: string; artist?: string }
    const item = r.id ? review.get(r.id) : undefined
    const q = { title: String(r.title ?? '').trim(), artist: String(r.artist ?? '').trim() }
    if (!q.title) return { ok: false, error: 'Type at least the song title to search.' }
    try {
      const seen = new Set<string>()
      const list = [...(await mb.search(q, item?.durationMs ?? null, false)), ...(await mb.search(q, item?.durationMs ?? null, true))]
        .sort((a, b) => b.confidence - a.confidence)
        .filter((c) => (seen.has(c.recordingId) ? false : (seen.add(c.recordingId), true)))
        .slice(0, 8)
      return { ok: true, candidates: list }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  const coverCache = new Map<string, string | null>()
  ctx.ipcMain.handle(`${ID}:cover-preview`, async (_e, raw: unknown) => {
    const r = (raw ?? {}) as { releaseId?: string; releaseGroupId?: string }
    const key = `${r.releaseId ?? ''}|${r.releaseGroupId ?? ''}`
    if (!coverCache.has(key))
      try {
        const art = await mb.coverArt(String(r.releaseId ?? ''), String(r.releaseGroupId ?? ''), 250)
        coverCache.set(key, art ? dataUrl(art) : null)
      } catch {
        return { ok: false }
      }
    const url = coverCache.get(key)
    return url ? { ok: true, dataUrl: url } : { ok: false }
  })

  ctx.ipcMain.handle(`${ID}:review-pick-image`, async () => {
    const win = ctx.getMainWindow()
    const opts = { title: 'Choose a cover image', properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }] }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true }
    try {
      const art = readImage(res.filePaths[0])
      return { ok: true, path: res.filePaths[0], dataUrl: dataUrl(art) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** save a held song with the user's details (and cover choice) */
  ctx.ipcMain.handle(`${ID}:review-save`, async (_e, raw: unknown) => {
    const r = (raw ?? {}) as { id?: string; tags?: Partial<SongTags>; art?: ArtChoice }
    const item = review.get(String(r.id ?? ''))
    if (!item) return { ok: false, error: 'That song is no longer waiting.' }
    const t = sanitizeTags(r.tags ?? {})
    if (!t.title || !t.artist) return { ok: false, error: 'Title and artist are needed.' }
    const a = r.art
    const art: ArtChoice =
      a?.kind === 'release' && a.releaseId ? { kind: 'release', releaseId: String(a.releaseId), releaseGroupId: String(a.releaseGroupId ?? '') } : a?.kind === 'file' && a.path ? { kind: 'file', path: String(a.path) } : { kind: 'keep' }
    return finalizeReview(item, { tags: t, art })
  })

  /** save held songs exactly as they are ("ignore") — ids, or every held song */
  ctx.ipcMain.handle(`${ID}:review-ignore`, async (_e, raw: unknown) => {
    const ids = (raw as { ids?: unknown })?.ids
    const items = Array.isArray(ids) ? ids.map((id) => review.get(String(id))).filter((i): i is ReviewItem => !!i) : review.list()
    let saved = 0
    const errors: string[] = []
    for (const it of items) {
      const res = await finalizeReview(it, null)
      if (res.ok) saved++
      else if (res.error) errors.push(res.error)
    }
    return { ok: errors.length === 0, saved, failed: errors.length, error: errors[0] }
  })

  /* -------------------------------- probe -------------------------------- */

  /** Run `yt-dlp -J` once and return the parsed metadata object. */
  function probeJson(
    ud: string,
    url: string,
    extraArgs: string[]
  ): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let done = false
      let child: ChildProcess
      try {
        child = spawn(
          ytDlpCmd(ud),
          ['-J', '--flat-playlist', '--no-warnings', '--ignore-no-formats-error', ...extraArgs, url],
          { windowsHide: true }
        )
      } catch (e) {
        resolve({ ok: false, error: 'Could not start yt-dlp: ' + errMsg(e) })
        return
      }
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          child.kill()
          resolve({ ok: false, error: 'Timed out reading that URL. Check the link and your connection.' })
        }
      }, PROBE_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
      child.on('error', (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: false, error: 'Could not run yt-dlp: ' + errMsg(e) })
      })
      child.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const start = out.indexOf('{')
        if (start < 0) {
          const detail = (err || 'no data').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
          resolve({ ok: false, error: 'Could not read that URL. ' + detail })
          return
        }
        try {
          resolve({ ok: true, json: JSON.parse(out.slice(start)) as Record<string, unknown> })
        } catch (e) {
          resolve({ ok: false, error: 'Could not parse yt-dlp output: ' + errMsg(e) })
        }
      })
    })
  }

  ctx.ipcMain.handle(`${ID}:probe`, async (_e, rawUrl: unknown) => {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter a full YouTube or YouTube Music URL (https://…).' }
    const ud = userData()
    if (!hasYtDlp(ud)) {
      const dl = await downloadYtDlp(ud)
      if (!dl.ok) return { ok: false, error: 'yt-dlp is not installed yet: ' + (dl.error ?? '') }
    }
    await ensureJsRuntime()

    const info = parseYtUrl(url)
    if (info.needsAuth)
      return {
        ok: false,
        error:
          'That looks like a personal YouTube Music library list (Liked Music / LM), which needs a signed-in session. Open the album or playlist itself and use its share link instead.'
      }

    const main = await probeJson(ud, url, [])
    if (!main.ok) return { ok: false, error: main.error }
    const j = main.json
    const isPlaylist = j._type === 'playlist' || Array.isArray(j.entries)
    const entries = Array.isArray(j.entries) ? j.entries : []

    // A YT Music track URL usually carries its auto-radio (`&list=RD…`), so
    // yt-dlp's default resolves the LIST. Fetch the single track's title too so
    // the UI can offer "just this track" vs "the whole album/playlist".
    let singleTitle: string | null = null
    if (info.hasBoth) {
      const one = await probeJson(ud, url, ['--no-playlist'])
      if (one.ok) singleTitle = String(one.json.title ?? '') || null
    }

    const verified = await checkKnown(isPlaylist ? entries.map((e) => String((e as { id?: unknown })?.id ?? '')).filter(Boolean) : [String(j.id ?? '')])
    return {
      ok: true,
      kind: isPlaylist ? 'playlist' : 'video',
      title: String(j.title ?? j.id ?? 'Untitled'),
      uploader: String(j.uploader ?? j.channel ?? j.artist ?? ''),
      count: isPlaylist ? entries.length : 1,
      // songs already in the downloaded-songs list (verified to still exist — stale ones are dropped)
      alreadyHave: verified.known.length,
      alreadyItems: verified.known.slice(0, 200).map((s) => ({ videoId: s.videoId, title: s.title || s.fileName, artist: s.artist, where: whereIs(s) })),
      missingRemoved: verified.stale.length,
      duration: typeof j.duration === 'number' ? j.duration : null,
      thumbnail: typeof j.thumbnail === 'string' ? j.thumbnail : null,
      id: String(j.id ?? ''),
      // YouTube Music extras
      isMusic: info.isMusic,
      playlistKind: info.playlistKind,
      canChooseSingle: info.hasBoth,
      singleTitle
    }
  })

  /* ------------------------------ download ------------------------------- */

  interface JobParams {
    jobId: string
    url: string
    quality: string
    isPlaylist: boolean
    combine: boolean
    /** true = stitch in random order; false = oldest → newest (file order) */
    shuffle: boolean
    /** upload each finished file to Google Drive, keeping nothing locally */
    toDrive: boolean
    /** audio only: look songs up on MusicBrainz and fill missing tags (+ official cover) */
    fixTags: boolean
    officialArt: boolean
    /** music: skip songs already downloaded (by video id, and the same song under another video) */
    skipDuplicates: boolean
    /** a watched playlist's check */
    watchId?: string
    title: string
    /** original start time — preserved across a crash resume for the combine */
    startedAt: number
    attempts: number
    resumed: boolean
  }

  /** The whole download (+ optional combine) session; shared by the manual
   *  handler and the launch-time crash resume. `started: true` in the result
   *  means the job actually claimed a slot (and job-start/job-end events fired). */
  async function performJob(p: JobParams): Promise<Record<string, unknown>> {
    const { jobId } = p
    if (jobs.size >= MAX_JOBS)
      return {
        ok: false,
        jobId,
        error: `Up to ${MAX_JOBS} downloads can run at once — wait for one to finish or cancel one.`
      }
    if (jobs.has(jobId)) return { ok: false, jobId, error: 'That job is already running.' }

    // claim the slot before any awaits so parallel calls can't oversubscribe
    const job: Job = { child: null, cancelRequested: false }
    jobs.set(jobId, job)
    const sendP = (payload: Record<string, unknown>): void =>
      send(`${ID}:progress`, { jobId, ...payload })

    addPending({
      jobId,
      url: p.url,
      quality: p.quality,
      isPlaylist: p.isPlaylist,
      combine: p.combine,
      shuffle: p.shuffle,
      toDrive: p.toDrive,
      fixTags: p.fixTags,
      officialArt: p.officialArt,
      skipDuplicates: p.skipDuplicates,
      watchId: p.watchId,
      title: p.title,
      startedAt: p.startedAt,
      attempts: p.attempts
    })
    sendP({
      kind: 'job-start',
      title: p.title || p.url,
      req: { url: p.url, quality: p.quality, isPlaylist: p.isPlaylist, combine: p.combine, shuffle: p.shuffle, toDrive: p.toDrive, fixTags: p.fixTags, officialArt: p.officialArt, skipDuplicates: p.skipDuplicates, title: p.title },
      watchId: p.watchId,
      quality: p.quality,
      isPlaylist: p.isPlaylist,
      combine: p.combine,
      toDrive: p.toDrive,
      fixTags: p.fixTags && isAudioQuality(p.quality),
      resumed: p.resumed
    })
    if (p.resumed)
      sendP({ kind: 'note', note: 'Resumed after a restart — finished videos are skipped, partial ones continue.' })

    const finish = (outcome: Record<string, unknown>): Record<string, unknown> => {
      const res = { ...outcome, jobId, started: true }
      sendP({ kind: 'job-end', ...res })
      return res
    }

    let sink: DriveSink | null = null
    let fixer: TagFixer | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    try {
      const ud = userData()
      if (!hasYtDlp(ud)) {
        const dl = await downloadYtDlp(ud)
        if (!dl.ok) return finish({ ok: false, error: 'yt-dlp is not installed: ' + (dl.error ?? '') })
      }
      await ensureJsRuntime()
      // "Download to Google Drive": stage in temp, upload each file as it finishes
      const drive = p.toDrive ? getDriveProvider() : null
      if (p.toDrive && !drive?.status().connected)
        return finish({ ok: false, error: 'Google Drive isn’t connected — open File Vault and click Connect, or untick “Download to Google Drive”.' })
      const dir = p.toDrive ? stagingDirFor(jobId) : downloadDir()
      mkdirSync(dir, { recursive: true })

      const ffmpeg = resolveFfmpeg()
      const ffprobe = resolveFfprobe()
      const fixTags = p.fixTags && isAudioQuality(p.quality) && !!ffmpeg && !!ffprobe
      // yt-dlp appends each finished file here — the Drive uploader and the tag
      // fixer pick songs up from it as they complete
      const isMusic = isAudioQuality(p.quality)
      const dedupe = p.skipDuplicates && isMusic
      const doneListPath = p.toDrive ? join(dir, '.wicked-done.txt') : fixTags || isMusic ? join(moduleDir(), `done-${jobId}.txt`) : undefined
      // a watched playlist keeps ONE archive across all its checks, so only new videos download
      const archivePath = p.watchId ? join(moduleDir(), `watch-${p.watchId}.archive.txt`) : p.toDrive ? join(dir, '.wicked-archive.txt') : dedupe ? join(moduleDir(), `archive-${jobId}.txt`) : undefined
      // known songs go into this job's yt-dlp archive, so they're skipped before
      // downloading — including what your other PCs downloaded (shared via Drive)
      if (dedupe) {
        await syncListQuick()
        // make sure every listed song in THIS playlist really still exists —
        // a deleted/never-uploaded one is taken off the list and downloaded again
        const read = await readUrl(p.url, p.isPlaylist)
        if (!p.title && read.title) {
          p.title = read.title
          sendP({ kind: 'title', title: read.title })
          setItemTitle(jobId, read.title, p.watchId)
        }
        const { known, stale } = await checkKnown(read.ids)
        if (stale.length)
          sendP({
            kind: 'note',
            note: `${stale.length} song${stale.length === 1 ? ' was' : 's were'} on the downloaded list but ${stale.length === 1 ? 'is' : 'are'} missing (${stale[0].reason}) — downloading ${stale.length === 1 ? 'it' : 'them'} again: ${stale.slice(0, 3).map(songLabel).join(', ')}${stale.length > 3 ? ` +${stale.length - 3} more` : ''}.`
          })
        if (known.length) {
          sendP({ kind: 'dupe-items', items: known.slice(0, 200).map((s) => ({ videoId: s.videoId, title: s.title || s.fileName, artist: s.artist, where: whereIs(s) })) })
          sendP({ kind: 'note', note: `Already downloaded — will skip: ${known.slice(0, 4).map((s) => `${songLabel(s)} (${whereIs(s)})`).join(', ')}${known.length > 4 ? ` +${known.length - 4} more` : ''}.` })
        }
      }
      if (dedupe && archivePath) {
        const have = new Set(existsSync(archivePath) ? readFileSync(archivePath, 'utf8').split(/\r?\n/) : [])
        const add = library.archiveLines().filter((l) => !have.has(l))
        if (add.length) writeFileSync(archivePath, [...have].filter(Boolean).concat(add).join('\n') + '\n', 'utf8')
      }
      // "Combine clips" only makes sense for a multi-item VIDEO download and needs
      // ffmpeg. It's ignored for single videos and audio jobs.
      const wantCombine = p.combine && p.isPlaylist && !isAudioQuality(p.quality) && !!ffmpeg
      const manifestPath = wantCombine ? manifestPathFor(jobId) : undefined
      if (manifestPath) mkdirSync(dirname(manifestPath), { recursive: true })

      const req: DownloadRequest = {
        url: p.url,
        quality: p.quality,
        isPlaylist: p.isPlaylist,
        downloadDir: dir,
        manifestPath,
        doneListPath,
        archivePath
      }
      const args = buildDownloadArgs(req, ffmpeg)

      if (drive && doneListPath) {
        sink = new DriveSink(dir, driveDeps(drive), (prog: DriveProgress) => sendP({ kind: 'drive', ...prog }))
        sink.openRoot = isMusic
        sendP({ kind: 'note', note: `Saving to Google Drive (${drive.status().email || 'File Vault'}) → WICKED Vault/${DRIVE_ROOT_NAME} — nothing is kept on this PC.` })
      }
      let dupesBefore = 0
      let dupesAfter = 0
      const finalizing = new Set<Promise<void>>()
      const track = (pr: Promise<void>): void => {
        finalizing.add(pr)
        void pr.finally(() => finalizing.delete(pr))
      }
      const recordSong = (path: string, info: ReadyInfo, location: 'local' | 'pending'): void => {
        const vid = videoIdOf(basename(path))
        if (!vid) return
        library.record({
          videoId: vid,
          title: info.tags.title,
          artist: info.tags.artist,
          album: info.tags.album,
          originalTitle: info.original.title,
          originalArtist: info.original.artist,
          recordingId: info.recordingId ?? '',
          durationMs: info.durationMs,
          fileName: basename(path),
          location,
          path,
          driveFileId: '',
          playlist: p.title || 'Download',
          jobId,
          downloadedAt: Date.now(),
          device: DEVICE_ID
        })
      }
      /** a finished song: drop it if it's one we already have, else list it and pass it on */
      /** the same song is already downloaded: keep its video id as an alias, delete this copy */
      const dropDuplicate = (path: string, vid: string, same: { videoId: string; title: string; fileName: string; playlist: string }): void => {
        library.addAlias(same.videoId, vid)
        removeSongFile(path)
        dupesAfter++
        sendP({ kind: 'dupes', before: dupesBefore, after: dupesAfter })
        sendP({ kind: 'note', note: `Already downloaded: ${basename(path)} is the same song as “${same.title || same.fileName}” (${same.playlist}) — not kept.` })
      }
      const finalized = new Set<string>()
      const leftDirs = new Set<string>()
      const finalizeSong = async (path: string, info?: ReadyInfo): Promise<void> => {
        if (finalized.has(path)) return
        finalized.add(path)
        const vid = videoIdOf(basename(path))
        if (!vid || !existsSync(path)) {
          sink?.add(path)
          return
        }
        let t = info
        if (!t) {
          let tags = { title: '', artist: '', album: '', albumArtist: '', date: '', track: '', genre: '' }
          let durationMs: number | null = null
          try {
            if (ffprobe) ({ tags, durationMs } = await probeSong(ffprobe, path))
          } catch {
            /* fall back to the file name */
          }
          if (!tags.title) tags = { ...tags, ...parseSongFileName(basename(path)) }
          t = { tags, original: tags, durationMs }
        }
        if (dedupe) {
          const sameId = library.get(vid)
          const same =
            library.findSame({ title: t.tags.title, artist: t.tags.artist, recordingId: t.recordingId, durationMs: t.durationMs }, vid) ??
            (sameId && sameId.jobId !== jobId && relative(sameId.path || '.', path) !== '' ? sameId : null)
          if (same) return dropDuplicate(path, vid, same)
        }
        // music is filed by artist: <download folder or Drive>/YouTube Downloads/<Artist>/<Title> [id]
        const filed = fileUnderArtist(path, dir, t.tags, leftDirs)
        // the end-of-job sweep finds it at its new name — it's handled already
        finalized.add(filed)
        prechecked.add(filed)
        recordSong(filed, t, p.toDrive ? 'pending' : 'local')
        sink?.add(filed)
      }

      if (fixTags && ffmpeg && ffprobe) {
        const s = sink
        fixer = new TagFixer(tagDeps(ffmpeg, ffprobe), {
          officialArt: p.officialArt,
          isHeld: (f) => review.isHeld(f),
          hold: (f, info) => {
            review.add({ jobId, jobTitle: p.title || 'Download', path: f, fileName: basename(f), toDrive: p.toDrive, ...info })
            // on the list already, so the song isn't downloaded again while it waits
            recordSong(f, { tags: info.current, original: info.current, durationMs: info.durationMs }, p.toDrive ? 'pending' : 'local')
          },
          onReady: (f, info) => track(finalizeSong(f, info)),
          onProgress: (sum: TagSummary) => sendP({ kind: 'tags', ...sum }),
          processedFile: p.toDrive ? join(dir, '.wicked-tagged.txt') : join(moduleDir(), `tagged-${jobId}.txt`)
        })
        sendP({ kind: 'note', note: `Fixing missing song info with MusicBrainz${p.officialArt ? ' + official album art' : ''} — songs it can’t identify will wait for you.` })
      }
      {
        const s = sink
        const f = fixer
        if (s || f)
          job.onCancel = () => {
            f?.abort()
            s?.abort()
          }
      }
      // every finished file: duplicate check → tag fixer (it passes songs on) →
      // the downloaded-songs list (+ a second duplicate check with the fixed
      // info) → Drive. Video files go straight to Drive.
      const prechecked = new Set<string>()
      const precheck = async (path: string): Promise<void> => {
        if (prechecked.has(path)) return
        prechecked.add(path)
        const vid = videoIdOf(basename(path))
        if (dedupe && vid && existsSync(path)) {
          let tags: SongTags = emptyTags()
          let durationMs: number | null = null
          try {
            if (ffprobe) ({ tags, durationMs } = await probeSong(ffprobe, path))
          } catch {
            /* fall back to the file name */
          }
          if (!tags.title) tags = { ...tags, ...parseSongFileName(basename(path)) }
          const q = assessTags(tags).query
          const sameId = library.get(vid)
          const same =
            (sameId && sameId.jobId !== jobId && relative(sameId.path || '.', path) !== '' ? sameId : null) ??
            library.findSame({ title: tags.title, artist: tags.artist, durationMs }, vid) ??
            library.findSame({ title: q.title, artist: q.artist, durationMs }, vid)
          if (same) return dropDuplicate(path, vid, same)
        }
        if (fixer) fixer.add(path)
        else await finalizeSong(path)
      }
      const feed = (path: string): void => {
        if (isMusic) track(precheck(path))
        else sink?.add(path)
      }
      // a stitched movie needs every clip on disk first, so combine jobs upload at the end
      if (doneListPath && (sink || fixer || isMusic) && !wantCombine) {
        let seenLines = 0
        poll = setInterval(() => {
          const lines = readDoneList(doneListPath)
          for (const l of lines.slice(seenLines)) feed(l)
          seenLines = lines.length
        }, 1500)
      }

      let completed = 0
      const result = await spawnYtDlp(
        ytDlpCmd(ud),
        args,
        (line) => {
          const prog = parseProgressLine(line)
          if (!prog) return
          if ('note' in prog) {
            if (/Downloading item|Destination|Merging|Extracting/.test(prog.note)) sendP({ kind: 'note', note: prog.note })
            if (/has already been downloaded/.test(prog.note)) completed++
            if (/has already been recorded in the archive/.test(prog.note) && dedupe) {
              dupesBefore++
              sendP({ kind: 'dupes', before: dupesBefore, after: dupesAfter })
            }
          } else {
            if (prog.percent >= 100) completed++
            sendP({ kind: 'progress', ...prog })
          }
        },
        (child) => {
          job.child = child
        }
      )

      if (poll) clearInterval(poll)
      poll = null
      // treeKill (taskkill) doesn't set child.killed, so check our flag too
      if (result.cancelled || job.cancelRequested) return finish({ ok: false, cancelled: true })
      // app is closing: leave staging + the journal so the next launch resumes
      if (quitting) return finish({ ok: false, error: 'Interrupted — resumes on next launch.' })

      // ---- combine phase (best-effort; never fails the download itself) ----
      // collectOutputs prefers the manifest, which survives a crash resume (the
      // startup sweep keeps journaled jobs' manifests), so it lists BOTH runs'
      // files; the mtime fallback uses the ORIGINAL start for the same reason.
      let combined:
        | { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean }
        | null = null
      if (wantCombine && !job.cancelRequested) {
        // Chronological baseline: the zero-padded numbering makes a path sort
        // equal playlist order. The shuffle (when chosen) happens inside
        // combineClips; file NAMES are never affected by stitch order.
        const files = collectOutputs(manifestPath ?? null, dir, p.startedAt).sort()
        if (files.length >= 2 && ffmpeg) {
          const title = p.title.trim() ? p.title.trim() : 'Playlist'
          const stamp = new Date(p.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
          const outPath = join(dir, `${sanitizeName(title)} - Combined ${stamp}.mp4`)
          const tmpDir = join(ud, 'modules', ID, `combine-tmp-${jobId}`)
          sendP({ kind: 'combine', done: 0, total: files.length, label: `Combining ${files.length} clips…` })
          const cRes = await combineClips(files, outPath, tmpDir, canvasFor(p.quality), {
            ffmpeg,
            ffprobe: resolveFfprobe(),
            shuffle: p.shuffle,
            onNote: (note) => sendP({ kind: 'note', note }),
            onStep: (done, total, label) => sendP({ kind: 'combine', done, total, label }),
            registerChild: (c) => {
              job.child = c
            },
            shouldCancel: () => job.cancelRequested
          })
          combined = cRes.cancelled
            ? { ok: false, cancelled: true }
            : cRes.ok
              ? { ok: true, path: cRes.outPath, used: cRes.used, total: cRes.total }
              : { ok: false, error: cRes.error }
          if (cRes.ok && cRes.outPath) sendP({ kind: 'note', note: `Combined movie saved: ${cRes.outPath}` })
        } else {
          combined = { ok: false, error: `Only ${files.length} downloaded file(s) found — need at least 2 to combine.` }
        }
      }

      // ---- song info + Google Drive: finish what's still queued, then report ----
      if (doneListPath && (sink || fixer || isMusic)) {
        for (const l of readDoneList(doneListPath)) feed(l)
        // anything the list missed, plus clips + the stitched movie of a combine job
        if (sink) for (const f of leftoverMedia(dir)) if (!review.isHeld(f)) feed(f)
        // duplicate checks feed the fixer, the fixer feeds the list — settle both
        for (;;) {
          while (finalizing.size) await Promise.all([...finalizing])
          if (fixer) await fixer.drain()
          if (!finalizing.size) break
        }
        // playlist folders the songs were filed out of (yt-dlp is done with them now)
        for (const d of leftDirs) removeIfEmpty(d, dir)
        if (job.cancelRequested) return finish({ ok: false, cancelled: true })
        if (quitting) return finish({ ok: false, error: 'Interrupted — resumes on next launch.' })
      }
      const dupes = dedupe ? { before: dupesBefore, after: dupesAfter } : null
      if (dupes && dupes.before + dupes.after > 0)
        sendP({ kind: 'note', note: `${dupes.before + dupes.after} song${dupes.before + dupes.after === 1 ? ' was' : 's were'} already downloaded before — skipped.` })
      const tags = fixer ? fixer.summary() : null
      if (tags) {
        sendP({ kind: 'tags', ...tags, pending: 0, current: null })
        sendP({
          kind: 'note',
          note: `Song info: ${tags.fixed} fixed · ${tags.complete} already complete · ${tags.needsInfo} need${tags.needsInfo === 1 ? 's' : ''} your input${tags.skipped ? ` · ${tags.skipped} skipped${tags.note ? ` (${tags.note})` : ''}` : ''}.`
        })
      }
      let drived: Record<string, unknown> | null = null
      if (sink && doneListPath) {
        await sink.drain()
        if (job.cancelRequested) return finish({ ok: false, cancelled: true })
        if (quitting) return finish({ ok: false, error: 'Interrupted — resumes on next launch.' })
        // a file that wouldn't upload is kept, not lost: moved to the normal downloads folder
        const kept: string[] = []
        for (const f of sink.failed) {
          const dest = join(downloadDir(), relative(dir, f.path))
          try {
            mkdirSync(dirname(dest), { recursive: true })
            try {
              renameSync(f.path, dest)
            } catch {
              copyFileSync(f.path, dest) // temp and Downloads can be on different drives
              rmSync(f.path, { force: true })
            }
            kept.push(dest)
          } catch {
            /* still in staging; reported below */
          }
        }
        for (const u of sink.uploaded) library.update(videoIdOf(u.name), { location: 'drive', driveFileId: u.id, path: '' })
        for (const k of kept) library.update(videoIdOf(basename(k)), { location: 'local', path: k })
        const pr = sink.progress()
        drived = {
          uploaded: pr.uploaded,
          failed: sink.failed.length,
          folderUrl: pr.folderUrl,
          keptLocally: kept.length,
          keptDir: kept.length ? downloadDir() : undefined,
          error: sink.failed[0]?.error
        }
        sendP({ kind: 'drive', ...pr, pending: 0, current: null, done: true })
        sendP({ kind: 'note', note: `Google Drive: ${pr.uploaded} file${pr.uploaded === 1 ? '' : 's'} uploaded to WICKED Vault/${DRIVE_ROOT_NAME}.` })
        if (sink.failed.length)
          sendP({
            kind: 'note',
            note: `${sink.failed.length} file${sink.failed.length === 1 ? '' : 's'} couldn’t be uploaded (${sink.failed[0].error}) — ${kept.length ? `saved to ${downloadDir()} instead` : 'left in the temp folder'}.`
          })
      }

      if (!result.ok) {
        const tail = result.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
        // yt-dlp exits non-zero if ANY item failed even with --ignore-errors;
        // treat as a soft warning when at least something downloaded.
        return finish({ ok: completed > 0 || dupesBefore > 0, warning: completed > 0, error: tail || `yt-dlp exited with code ${result.code}`, completed, combined, drive: drived, tags, dupes })
      }
      return finish({ ok: true, completed, combined, drive: drived, tags, dupes })
    } finally {
      if (poll) clearInterval(poll)
      jobs.delete(jobId)
      // quitting keeps the journal entry so the job resumes on the next launch
      if (!quitting) removePending(jobId)
      if (!quitting) {
        fixer?.abort()
        for (const f of [`done-${jobId}.txt`, `tagged-${jobId}.txt`, `archive-${jobId}.txt`]) rmSync(join(moduleDir(), f), { force: true })
      }
      library.flush()
      if (isAudioQuality(p.quality) && !quitting) void syncListWithDrive()
      if (p.toDrive && !quitting) {
        sink?.abort()
        // a cancelled job's staged songs are deleted, so their review entries
        // and not-yet-uploaded list entries go too
        if (job.cancelRequested) {
          review.removeJob(jobId)
          library.forget(library.list('', Number.MAX_SAFE_INTEGER).items.filter((x) => x.jobId === jobId && x.location === 'pending').map((x) => x.videoId))
        }
        // songs waiting for the user stay staged (only them); otherwise clear it all
        if (review.forJob(jobId).length) pruneStaging(jobId)
        else
          try {
            rmSync(stagingDirFor(jobId), { recursive: true, force: true })
          } catch {
            /* locked by a dying yt-dlp — swept on next launch */
          }
      }
      const manifest = manifestPathFor(jobId)
      if (existsSync(manifest)) {
        try {
          rmSync(manifest, { force: true })
        } catch {
          /* ignore */
        }
      }
      // A CANCELLED job left the journal, so nothing will ever resume its
      // half-downloaded files — sweep this job's .part/.ytdl leftovers. Only
      // when no other job is running (they share the folder and their own
      // partials must survive).
      if (job.cancelRequested && jobs.size === 0 && !p.toDrive) {
        try {
          const dir = downloadDir()
          for (const name of readdirSync(dir)) {
            if (!/\.(part|ytdl|part-Frag\d+)$/i.test(name)) continue
            const f = join(dir, name)
            try {
              if (statSync(f).mtimeMs >= p.startedAt - 60_000) rmSync(f, { force: true })
            } catch {
              /* still locked by a dying process — the next cancel sweeps it */
            }
          }
        } catch {
          /* best-effort */
        }
      }
    }
  }

  /* --------------------------- queue + watched playlists --------------------------- *
   * Every download goes through ONE saved queue (queue.json): paste as many links
   * as you like, at most MAX_JOBS (2) run at a time, the rest wait in order. The
   * queue is on disk, so after a restart / update / power loss it carries on:
   * interrupted jobs (pending-jobs.json) resume first, then the waiting ones.
   * Watched playlists (watches.json) get a check queued every 48 h (wall clock,
   * so a PC that was off longer checks as soon as it starts) — only new videos
   * download (each watch has its own persistent yt-dlp archive, and music also
   * skips anything on the downloaded-songs list).
   * ---------------------------------------------------------------------- */

  type ItemState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  interface QueueItem {
    id: string
    url: string
    quality: string
    isPlaylist: boolean
    combine: boolean
    shuffle: boolean
    toDrive: boolean
    fixTags: boolean
    officialArt: boolean
    skipDuplicates: boolean
    title: string
    watchId?: string
    state: ItemState
    addedAt: number
    startedAt?: number
    endedAt?: number
    attempts: number
    /** has run before (so the next run is a resume) */
    started?: boolean
    message?: string
  }
  interface Watch {
    id: string
    url: string
    title: string
    quality: string
    toDrive: boolean
    fixTags: boolean
    officialArt: boolean
    addedAt: number
    lastCheckedAt: number
    lastResult: string
    enabled: boolean
  }

  const queueFile = (): string => join(moduleDir(), 'queue.json')
  const watchFile = (): string => join(moduleDir(), 'watches.json')
  const readJson = <T,>(f: string, fallback: T): T => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T
    } catch {
      return fallback
    }
  }
  const writeJson = (f: string, v: unknown): void => {
    mkdirSync(dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8')
    renameSync(tmp, f)
  }
  let queue: QueueItem[] = readJson<{ items?: QueueItem[] }>(queueFile(), {}).items ?? []
  let watches: Watch[] = readJson<{ watches?: Watch[] }>(watchFile(), {}).watches ?? []
  const saveQueue = (): void => {
    // keep the last 40 finished items for the list
    const finished = queue.filter((q) => q.state !== 'queued' && q.state !== 'running')
    if (finished.length > 40) {
      const drop = new Set(finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, finished.length - 40).map((q) => q.id))
      queue = queue.filter((q) => !drop.has(q.id))
    }
    try {
      writeJson(queueFile(), { items: queue })
    } catch {
      /* next save retries */
    }
    send(`${ID}:queue`, queue)
  }
  const saveWatches = (): void => {
    try {
      writeJson(watchFile(), { watches })
    } catch {
      /* next save retries */
    }
    send(`${ID}:watches`, watches)
  }
  function setItemTitle(jobId: string, title: string, watchId?: string): void {
    const it = queue.find((q) => q.id === jobId)
    if (it && !it.title) {
      it.title = title
      saveQueue()
    }
    const w = watchId ? watches.find((x) => x.id === watchId) : undefined
    if (w && !w.title) {
      w.title = title
      saveWatches()
    }
  }

  /** Is this URL a whole playlist/album? (A song link with an auto-radio list is just the song.) */
  const playlistOf = (url: string): boolean => {
    const i = parseYtUrl(url)
    return !!i.listId && !(i.hasBoth && i.playlistKind === 'mix')
  }
  const newId = (): string => `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  // after a restart: whatever was running resumes (first in line), the rest waits as before
  let queueReady = false
  {
    const journal = readPending()
    for (const it of queue) if (it.state === 'running') it.state = 'queued'
    for (const p of journal) {
      const it = queue.find((q) => q.id === p.jobId)
      if (it) {
        it.started = true
        it.attempts = p.attempts
      } else
        queue.unshift({
          id: p.jobId,
          url: p.url,
          quality: p.quality,
          isPlaylist: p.isPlaylist,
          combine: p.combine,
          shuffle: p.shuffle === true,
          toDrive: p.toDrive === true,
          fixTags: p.fixTags === true,
          officialArt: p.officialArt !== false,
          skipDuplicates: p.skipDuplicates !== false,
          watchId: p.watchId,
          title: p.title,
          state: 'queued',
          addedAt: p.startedAt,
          startedAt: p.startedAt,
          attempts: p.attempts,
          started: true
        })
    }
    // resumed jobs go first
    queue.sort((a, b) => Number(b.state === 'queued' && !!b.started) - Number(a.state === 'queued' && !!a.started))
    // give an interrupted job's yt-dlp/ffmpeg a moment to be gone before resuming;
    // with nothing to resume the queue is ready right away
    setTimeout(
      () => {
        queueReady = true
        saveQueue()
        pumpQueue()
      },
      journal.length ? RESUME_DELAY_MS : 0
    )
  }

  /** Start waiting items while a slot (of MAX_JOBS) is free. */
  function pumpQueue(): void {
    if (!queueReady || quitting) return
    for (const it of queue) {
      if (jobs.size >= MAX_JOBS) break
      if (it.state !== 'queued' || jobs.has(it.id)) continue
      const resumed = !!it.started
      if (resumed && it.attempts >= MAX_RESUME_ATTEMPTS) {
        console.error(`[${ID}] giving up on ${it.title || it.url} after ${it.attempts} resume attempts`)
        removePending(it.id)
        it.state = 'failed'
        it.message = `Gave up after ${it.attempts} tries to resume.`
        it.endedAt = Date.now()
        continue
      }
      if (resumed) it.attempts++
      it.state = 'running'
      it.started = true
      it.startedAt = it.startedAt ?? Date.now()
      saveQueue()
      void performJob({
        jobId: it.id,
        url: it.url,
        quality: it.quality,
        isPlaylist: it.isPlaylist,
        combine: it.combine,
        shuffle: it.shuffle,
        toDrive: it.toDrive,
        fixTags: it.fixTags,
        officialArt: it.officialArt,
        skipDuplicates: it.skipDuplicates || !!it.watchId,
        watchId: it.watchId,
        title: it.title,
        startedAt: it.startedAt,
        attempts: it.attempts,
        resumed
      })
        .catch((err) => ({ ok: false, started: true, error: errMsg(err) }) as Record<string, unknown>)
        .then((res) => {
          if (quitting) {
            // stays journaled → resumes on next launch; still answer anyone waiting
            waiters.get(it.id)?.forEach((r) => r(res))
            waiters.delete(it.id)
            return
          }
          if (res.started !== true) {
            it.state = 'queued' // lost a slot race — try again shortly
            setTimeout(pumpQueue, 1500)
          } else {
            it.state = res.cancelled ? 'cancelled' : res.ok ? 'done' : 'failed'
            it.endedAt = Date.now()
            it.message = typeof res.error === 'string' ? res.error.slice(0, 300) : ''
            const w = it.watchId ? watches.find((x) => x.id === it.watchId) : undefined
            if (w) {
              const n = Number(res.completed) || 0
              const d = (res.drive as { uploaded?: number } | null)?.uploaded
              w.lastResult = res.cancelled ? 'Check cancelled.' : res.ok ? `${typeof d === 'number' ? d : n} new` : `Check failed: ${it.message}`
              saveWatches()
            }
          }
          saveQueue()
          if (res.started === true) {
            waiters.get(it.id)?.forEach((r) => r(res))
            waiters.delete(it.id)
          }
          pumpQueue()
        })
    }
    saveQueue()
  }
  /** callers of the single-link `download` channel wait for their own result */
  const waiters = new Map<string, ((res: Record<string, unknown>) => void)[]>()

  interface AddOpts {
    quality?: string
    toDrive?: boolean
    fixTags?: boolean
    officialArt?: boolean
    skipDuplicates?: boolean
    combine?: boolean
    shuffle?: boolean
  }
  function enqueue(url: string, o: AddOpts, extra: { isPlaylist?: boolean; title?: string; watchId?: string; id?: string } = {}): QueueItem {
    const it: QueueItem = {
      id: extra.id || newId(),
      url,
      quality: typeof o.quality === 'string' ? o.quality : 'best',
      isPlaylist: typeof extra.isPlaylist === 'boolean' ? extra.isPlaylist : playlistOf(url),
      combine: o.combine === true,
      shuffle: o.shuffle === true,
      toDrive: o.toDrive === true,
      fixTags: typeof o.fixTags === 'boolean' ? o.fixTags : prefs().fixTags,
      officialArt: typeof o.officialArt === 'boolean' ? o.officialArt : prefs().officialArt,
      skipDuplicates: typeof o.skipDuplicates === 'boolean' ? o.skipDuplicates : prefs().skipDuplicates,
      title: extra.title ?? '',
      watchId: extra.watchId,
      state: 'queued',
      addedAt: Date.now(),
      attempts: 0
    }
    queue.push(it)
    return it
  }

  /** Add links (one per line in the UI). `watch` also watches each playlist link. */
  ctx.ipcMain.handle(`${ID}:queue-add`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { items?: { url?: unknown; isPlaylist?: unknown; title?: unknown }[]; opts?: AddOpts; watch?: unknown }
    const o = r.opts ?? {}
    const added: QueueItem[] = []
    const skipped: { url: string; error: string }[] = []
    let watched = 0
    for (const x of r.items ?? []) {
      const url = String(x?.url ?? '').trim()
      if (!url) continue
      if (!/^https?:\/\//i.test(url)) {
        skipped.push({ url, error: 'Not a link (needs https://…)' })
        continue
      }
      if (parseYtUrl(url).needsAuth) {
        skipped.push({ url, error: 'Liked Music / personal library lists need a sign-in — use the playlist’s own share link.' })
        continue
      }
      if (queue.some((q) => q.url === url && (q.state === 'queued' || q.state === 'running'))) {
        skipped.push({ url, error: 'Already in the queue' })
        continue
      }
      const isPlaylist = typeof x?.isPlaylist === 'boolean' ? x.isPlaylist : playlistOf(url)
      let watchId: string | undefined
      if (r.watch === true && isPlaylist) {
        const listId = parseYtUrl(url).listId
        let w = watches.find((y) => parseYtUrl(y.url).listId === listId)
        if (!w) {
          w = { id: newId().replace(/^job-/, 'watch-'), url, title: typeof x?.title === 'string' ? x.title : '', quality: o.quality ?? 'audio', toDrive: o.toDrive === true, fixTags: o.fixTags !== false, officialArt: o.officialArt !== false, addedAt: Date.now(), lastCheckedAt: Date.now(), lastResult: '', enabled: true }
          watches.push(w)
          watched++
        }
        w.lastCheckedAt = Date.now() // this download is its first check
        watchId = w.id
      }
      added.push(enqueue(url, o, { isPlaylist, title: typeof x?.title === 'string' ? x.title : '', watchId }))
    }
    if (watched) saveWatches()
    saveQueue()
    pumpQueue()
    return { ok: true, added: added.length, skipped, watched, ids: added.map((a) => a.id) }
  })

  // Kept for MCP / older callers: one link → the same queue (returns once it's queued).
  ctx.ipcMain.handle(`${ID}:download`, async (_e, rawReq: unknown) => {
    const r = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'A YouTube URL is required.' }
    const it = enqueue(url, r as AddOpts, { isPlaylist: r.isPlaylist === true, title: typeof r.title === 'string' ? r.title : '', id: typeof r.jobId === 'string' && r.jobId ? r.jobId : undefined })
    // resolves with the job's result once it has had its turn and finished (as before the queue)
    const done = new Promise<Record<string, unknown>>((resolve) => waiters.set(it.id, [...(waiters.get(it.id) ?? []), resolve]))
    saveQueue()
    pumpQueue()
    return done
  })

  ctx.ipcMain.handle(`${ID}:queue-list`, () => ({ ok: true, items: queue, maxJobs: MAX_JOBS }))
  ctx.ipcMain.handle(`${ID}:queue-remove`, (_e, raw: unknown) => {
    const id = String((raw as { id?: unknown })?.id ?? '')
    queue = queue.filter((q) => !(q.id === id && q.state === 'queued'))
    saveQueue()
    return { ok: true }
  })
  ctx.ipcMain.handle(`${ID}:queue-clear-finished`, () => {
    queue = queue.filter((q) => q.state === 'queued' || q.state === 'running')
    saveQueue()
    return { ok: true }
  })

  /** Queue a check for every watched playlist that's due (or `force` one now). */
  function checkWatches(forceId?: string): number {
    let n = 0
    for (const w of watches) {
      if (!w.enabled && w.id !== forceId) continue
      const due = w.id === forceId || Date.now() - (w.lastCheckedAt || 0) >= WATCH_EVERY_MS
      if (!due) continue
      if (queue.some((q) => q.watchId === w.id && (q.state === 'queued' || q.state === 'running'))) continue
      enqueue(w.url, { quality: w.quality, toDrive: w.toDrive, fixTags: w.fixTags, officialArt: w.officialArt, skipDuplicates: true }, { isPlaylist: true, title: w.title, watchId: w.id })
      w.lastCheckedAt = Date.now()
      w.lastResult = 'Checking…'
      n++
    }
    if (n) {
      saveWatches()
      saveQueue()
      pumpQueue()
    }
    return n
  }
  setTimeout(() => checkWatches(), RESUME_DELAY_MS + 5000)
  setInterval(() => checkWatches(), WATCH_TICK_MS)

  ctx.ipcMain.handle(`${ID}:watch-list`, () => ({ ok: true, watches, everyHours: WATCH_EVERY_MS / 3600e3 }))
  ctx.ipcMain.handle(`${ID}:watch-remove`, (_e, raw: unknown) => {
    const id = String((raw as { id?: unknown })?.id ?? '')
    watches = watches.filter((w) => w.id !== id)
    rmSync(join(moduleDir(), `watch-${id}.archive.txt`), { force: true })
    saveWatches()
    return { ok: true }
  })
  ctx.ipcMain.handle(`${ID}:watch-set`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { id?: unknown; enabled?: unknown; toDrive?: unknown }
    const w = watches.find((x) => x.id === String(r.id ?? ''))
    if (!w) return { ok: false, error: 'Not watched.' }
    if (typeof r.enabled === 'boolean') w.enabled = r.enabled
    if (typeof r.toDrive === 'boolean') w.toDrive = r.toDrive
    saveWatches()
    return { ok: true }
  })
  ctx.ipcMain.handle(`${ID}:watch-check-now`, (_e, raw: unknown) => ({ ok: true, queued: checkWatches(String((raw as { id?: unknown })?.id ?? '')) }))

  // Cancel one job (jobId) or, with no argument, all running jobs — the latter
  // keeps the MCP cancel tool and any older callers working unchanged.
  ctx.ipcMain.handle(`${ID}:cancel`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const targetId = typeof r.jobId === 'string' && r.jobId ? r.jobId : null
    const targets = targetId ? [jobs.get(targetId)].filter((j): j is Job => !!j) : [...jobs.values()]
    let killed = 0
    for (const j of targets) {
      j.cancelRequested = true
      j.onCancel?.()
      if (j.child) treeKill(j.child)
      if (j.child || j.onCancel) killed++
    }
    return { ok: true, cancelled: killed > 0 }
  })

  // Quitting with downloads running must not orphan yt-dlp/ffmpeg. The jobs
  // stay in the resume journal (cancelRequested is NOT set), so the next
  // launch picks them back up.
  ctx.app.on('before-quit', () => {
    quitting = true
    library.flush()
    for (const j of jobs.values()) if (j.child) treeKill(j.child)
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const dir = downloadDir()
    const bin = ytDlpPath(userData())
    return [
      { label: 'Downloads folder', path: existsSync(dir) ? dir : null, note: 'Where videos/playlists are saved' },
      { label: 'yt-dlp binary', path: existsSync(bin) ? bin : null, note: 'Auto-downloaded; updatable in the module' },
      { label: 'Module folder', path: existsSync(binDir(userData())) ? join(userData(), 'modules', ID) : null }
    ]
  })
}

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
import { findByName, findOrCreateSubfolder, listFolder, md5File, resumableUpload } from '../file-vault/ipc/gdrive'
import { MusicBrainz, mbUserAgent } from './ipc/musicbrainz'
import { extractArt, probeSong, readImage, writeSongTags, type Art } from './ipc/tagio'
import { ReviewStore, TagFixer, type ReadyInfo, type TagFixDeps } from './ipc/tagfix'
import { SongLibrary, findDownloadedSongs, parseSongFileName, videoIdOf, AUDIO_EXT } from './ipc/library'
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
const MAX_JOBS = 3
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

  /** Add songs already on disk / in Drive (from before the list existed). */
  async function scanExisting(includeDrive: boolean): Promise<{ local: number; drive: number; error?: string }> {
    let local = 0
    let drive = 0
    for (const f of findDownloadedSongs(downloadDir())) {
      if (library.has(f.videoId)) continue
      const { artist, title } = parseSongFileName(f.fileName)
      library.record({ videoId: f.videoId, title, artist, album: '', originalTitle: title, originalArtist: artist, recordingId: '', durationMs: null, fileName: f.fileName, location: 'local', path: f.path, driveFileId: '', playlist: basename(dirname(f.path)), jobId: '', downloadedAt: Date.now() })
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
              if (!id || !AUDIO_EXT.has(ext) || library.has(id)) continue
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
      void scanExisting(false)
    }
    setTimeout(firstScan, 4000)
  }

  ctx.ipcMain.handle(`${ID}:library-list`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { query?: unknown; limit?: unknown; offset?: unknown }
    const limit = Math.max(1, Math.min(1000, Number(r.limit) || 200))
    return { ok: true, ...library.list(typeof r.query === 'string' ? r.query : '', limit, Math.max(0, Number(r.offset) || 0)) }
  })

  /** forget songs (or all) so they can be downloaded again — files are not touched */
  ctx.ipcMain.handle(`${ID}:library-forget`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { videoIds?: unknown; all?: unknown }
    const n = r.all === true ? library.forgetAll() : Array.isArray(r.videoIds) ? library.forget(r.videoIds.map(String)) : 0
    library.flush()
    return { ok: true, forgotten: n, total: library.size }
  })

  ctx.ipcMain.handle(`${ID}:library-scan`, async () => ({ ok: true, ...(await scanExisting(true)), total: library.size }))

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
      if (item.toDrive) {
        const drive = getDriveProvider()
        if (!drive?.status().connected) throw new Error('Google Drive isn’t connected — reconnect it in File Vault, then save again.')
        const s = new DriveSink(stagingDirFor(item.jobId), driveDeps(drive), () => undefined)
        s.add(item.path)
        await s.drain()
        if (s.failed.length) throw new Error(`Upload to Google Drive failed: ${s.failed[0].error}`)
        library.update(videoIdOf(item.fileName), { location: 'drive', driveFileId: s.uploaded[0]?.id ?? '', path: '' })
      } else library.update(videoIdOf(item.fileName), { location: 'local', path: item.path })
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

    return {
      ok: true,
      kind: isPlaylist ? 'playlist' : 'video',
      title: String(j.title ?? j.id ?? 'Untitled'),
      uploader: String(j.uploader ?? j.channel ?? j.artist ?? ''),
      count: isPlaylist ? entries.length : 1,
      // songs already in the downloaded-songs list (skipped when "skip duplicates" is on)
      alreadyHave: isPlaylist
        ? entries.filter((e) => library.has(String((e as { id?: unknown })?.id ?? ''))).length
        : library.has(String(j.id ?? ''))
          ? 1
          : 0,
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
      title: p.title,
      startedAt: p.startedAt,
      attempts: p.attempts
    })
    sendP({
      kind: 'job-start',
      title: p.title || p.url,
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
      const archivePath = p.toDrive ? join(dir, '.wicked-archive.txt') : dedupe ? join(moduleDir(), `archive-${jobId}.txt`) : undefined
      // known songs go into this job's yt-dlp archive, so they're skipped before downloading
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
          downloadedAt: Date.now()
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
        recordSong(path, t, p.toDrive ? 'pending' : 'local')
        sink?.add(path)
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
      if (doneListPath && (sink || fixer) && !wantCombine) {
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
      if (doneListPath && (sink || fixer)) {
        for (const l of readDoneList(doneListPath)) feed(l)
        // anything the list missed, plus clips + the stitched movie of a combine job
        if (sink) for (const f of leftoverMedia(dir)) if (!review.isHeld(f)) feed(f)
        // duplicate checks feed the fixer, the fixer feeds the list — settle both
        for (;;) {
          while (finalizing.size) await Promise.all([...finalizing])
          if (fixer) await fixer.drain()
          if (!finalizing.size) break
        }
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

  ctx.ipcMain.handle(`${ID}:download`, async (_e, rawReq: unknown) => {
    const r = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const jobId =
      typeof r.jobId === 'string' && r.jobId
        ? r.jobId
        : `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false, jobId, error: 'A YouTube URL is required.' }
    return performJob({
      jobId,
      url,
      quality: typeof r.quality === 'string' ? r.quality : 'best',
      isPlaylist: r.isPlaylist === true,
      combine: r.combine === true,
      shuffle: r.shuffle === true,
      toDrive: r.toDrive === true,
      fixTags: typeof r.fixTags === 'boolean' ? r.fixTags : prefs().fixTags,
      officialArt: typeof r.officialArt === 'boolean' ? r.officialArt : prefs().officialArt,
      skipDuplicates: typeof r.skipDuplicates === 'boolean' ? r.skipDuplicates : prefs().skipDuplicates,
      title: typeof r.title === 'string' ? r.title : '',
      startedAt: Date.now(),
      attempts: 0,
      resumed: false
    })
  })

  // Resume jobs the last session never finished (crash, power loss, app close).
  if (survivors.length > 0) {
    setTimeout(() => {
      for (const p of survivors) {
        if (p.attempts >= MAX_RESUME_ATTEMPTS) {
          console.error(`[${ID}] giving up on job ${p.jobId} after ${p.attempts} resume attempts`)
          removePending(p.jobId)
          continue
        }
        console.log(`[${ID}] resuming interrupted job: ${p.title || p.url}`)
        void performJob({
          ...p,
          shuffle: p.shuffle === true,
          toDrive: p.toDrive === true,
          fixTags: p.fixTags === true,
          officialArt: p.officialArt !== false,
          skipDuplicates: p.skipDuplicates !== false,
          attempts: p.attempts + 1,
          resumed: true
        })
      }
    }, RESUME_DELAY_MS)
  }

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

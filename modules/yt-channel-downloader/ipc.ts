import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  PGRESS,
  downloadYtDlp,
  formatArgs,
  hasYtDlp,
  isAudioQuality,
  parseProgressLine,
  resolveFfmpeg,
  resolveFfprobe,
  spawnYtDlp,
  treeKill,
  ytDlpCmd
} from '../yt-downloader/ipc/ytdlp'
import { canvasFor, collectOutputs, combineClips, isVideoFile, sanitizeName } from '../yt-downloader/ipc/combine'

/* ------------------------------------------------------------------------ *
 *  TOTAL CHANNEL DOWNLOADER — main process.
 *
 *  Takes a YouTube CHANNEL URL and downloads the creator's entire long-form
 *  library (the /videos tab: no Shorts, posts or streams), oldest → newest,
 *  numbered chronologically. Every session is recorded in history.json so a
 *  channel can be RESCANNED later; autoRescan channels are topped up shortly
 *  after every launch (downloads only — stitching always asks first).
 *
 *  CRASH RESUME: the running job is journaled to pending-job.json (phase
 *  download vs stitch, and the stitch's output path once known) and cleared on
 *  completion/cancel. After a crash / power loss / app close, the next launch
 *  resumes it: downloads re-run (yt-dlp skips finished files and continues
 *  half-downloaded ones); an interrupted stitch DELETES its partial movie file
 *  and starts a fresh stitch — a half-written mp4 can't be completed.
 *  job-start / job-end events keep the UI in sync with resumed jobs. One job
 *  (download or stitch) runs at a time.
 * ------------------------------------------------------------------------ */

const ID = 'yt-channel-downloader'
/** save-location override key — kept separate from the Custom Playlist
 *  Downloader so the two tools can point at different folders */
const DIR_KEY = `${ID}.downloadDir`
const PROBE_TIMEOUT_MS = 120_000
const AUTO_SWEEP_DELAY_MS = 30_000
const RESUME_DELAY_MS = 8000
const MAX_RESUME_ATTEMPTS = 3

interface ChannelRecord {
  /** normalized /videos URL doubles as the id */
  id: string
  url: string
  channel: string
  /** absolute channel subfolder once known (from the first session's files) */
  folder: string | null
  quality: string
  /** video files in the channel folder after the last completed session */
  downloadedCount: number
  /** videos included in the last stitched movie (0 = never stitched) */
  stitchedCount: number
  lastDownloadAt: number
  lastStitchAt: number | null
  lastStitchPath: string | null
  /** check for new uploads on every app launch and download them (no stitch) */
  autoRescan: boolean
  /** videos fetched by auto-rescan that the user hasn't been told about yet */
  autoDownloadedPending: number
}

interface PendingChannelJob {
  mode: 'download' | 'stitch'
  /** where the job was when it died: still downloading, or already stitching */
  phase: 'download' | 'stitch'
  url: string
  quality: string
  combine: boolean
  /** stitch in random order (false/absent = oldest → newest) */
  shuffle?: boolean
  channel: string
  folder: string | null
  startedAt: number
  /** the stitch output file being written (deleted on resume — unrecoverable) */
  stitchOut: string | null
  attempts: number
}

interface DownloadOutcome {
  ok: boolean
  started?: boolean
  warning?: boolean
  cancelled?: boolean
  completed?: number
  error?: string
  combined?: { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean } | null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

/**
 * Normalize any pasted channel reference (@handle, youtube.com/@handle,
 * /channel/UC…, /c/name, /user/name — with or without a tab suffix) to the
 * channel's /videos tab URL: long-form uploads only.
 */
export function normalizeChannelUrl(raw: unknown): string | null {
  let s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  if (/^@[\w.-]+$/.test(s)) s = `https://www.youtube.com/${s}`
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  try {
    const u = new URL(s)
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length === 0) return null
    const head = decodeURIComponent(parts[0])
    let base: string | null = null
    if (head.startsWith('@')) base = `/${head}`
    else if ((head === 'channel' || head === 'c' || head === 'user') && parts[1]) base = `/${head}/${parts[1]}`
    return base ? `https://www.youtube.com${base}/videos` : null
  } catch {
    return null
  }
}

/** A previously stitched movie must never be stitched into the next movie. */
const isStitchedMovie = (name: string): boolean => / - Full Channel /.test(name)

export default function register(ctx: ModuleIpcContext): void {
  let child: ChildProcess | null = null
  let cancelRequested = false
  let busy = false

  const userData = (): string => ctx.app.getPath('userData')
  const moduleDir = (): string => join(userData(), 'modules', ID)
  const historyFile = (): string => join(moduleDir(), 'history.json')
  const pendingFile = (): string => join(moduleDir(), 'pending-job.json')

  // Channel downloads have their OWN save location (separate from the Custom
  // Playlist Downloader) so the two tools can target different folders. Defaults
  // to a distinct "WICKED YouTube Channels" folder; override with pick-folder.
  const downloadDir = (): string => {
    const v = ctx.storeGet<string>(DIR_KEY, '')
    return v && v.trim() ? v : join(ctx.app.getPath('downloads'), 'WICKED YouTube Channels')
  }

  const send = (payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(`${ID}:progress`, payload)
  }

  /* ------------------------------- history ------------------------------- */

  const readHistory = (): ChannelRecord[] => {
    try {
      const j = JSON.parse(readFileSync(historyFile(), 'utf8')) as { channels?: unknown }
      const list = Array.isArray(j.channels) ? (j.channels as ChannelRecord[]) : []
      // older records predate the auto-rescan fields
      for (const c of list) {
        if (typeof c.autoRescan !== 'boolean') c.autoRescan = false
        if (typeof c.autoDownloadedPending !== 'number') c.autoDownloadedPending = 0
      }
      return list
    } catch {
      return []
    }
  }

  const saveHistory = (channels: ChannelRecord[]): void => {
    mkdirSync(moduleDir(), { recursive: true })
    // temp + rename: a crash mid-write must never corrupt the channel history
    const tmp = `${historyFile()}.tmp`
    writeFileSync(tmp, JSON.stringify({ channels }, null, 2), 'utf8')
    renameSync(tmp, historyFile())
  }

  const upsertRecord = (patch: Partial<ChannelRecord> & { id: string }): ChannelRecord => {
    const channels = readHistory()
    let rec = channels.find((c) => c.id === patch.id)
    if (!rec) {
      rec = {
        id: patch.id,
        url: patch.id,
        channel: '',
        folder: null,
        quality: '1080',
        downloadedCount: 0,
        stitchedCount: 0,
        lastDownloadAt: 0,
        lastStitchAt: null,
        lastStitchPath: null,
        autoRescan: false,
        autoDownloadedPending: 0
      }
      channels.unshift(rec)
    }
    Object.assign(rec, patch)
    saveHistory(channels)
    return rec
  }

  /* --------------------- crash-resume journal (one job) ------------------- */

  const readPendingJob = (): PendingChannelJob | null => {
    try {
      const j = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { job?: PendingChannelJob }
      return j.job && typeof j.job === 'object' ? j.job : null
    } catch {
      return null
    }
  }
  const writePendingJob = (job: PendingChannelJob): void => {
    mkdirSync(moduleDir(), { recursive: true })
    const tmp = `${pendingFile()}.tmp`
    writeFileSync(tmp, JSON.stringify({ job }, null, 2), 'utf8')
    renameSync(tmp, pendingFile())
  }
  const patchPendingJob = (patch: Partial<PendingChannelJob>): void => {
    const cur = readPendingJob()
    if (cur) writePendingJob({ ...cur, ...patch })
  }
  const clearPendingJob = (): void => {
    try {
      rmSync(pendingFile(), { force: true })
    } catch {
      /* ignore */
    }
  }

  /** All downloaded channel videos, chronological (numbered filenames sort). */
  const channelVideos = (folder: string): string[] => {
    try {
      return readdirSync(folder)
        .filter((n) => isVideoFile(n) && !isStitchedMovie(n))
        .sort()
        .map((n) => join(folder, n))
    } catch {
      return []
    }
  }

  // Sweep ffmpeg scratch left by interrupted stitches (names use the combine-
  // prefixes so the backup/sync layer excludes them too). A resumed stitch
  // always starts fresh, so nothing here is worth keeping.
  try {
    for (const name of readdirSync(moduleDir())) {
      if (/^combine-(tmp|manifest-)/.test(name)) {
        rmSync(join(moduleDir(), name), { recursive: true, force: true })
        console.log(`[${ID}] removed stale combine scratch: ${name}`)
      }
    }
  } catch {
    /* module dir may not exist yet */
  }

  /* -------------------------------- probe -------------------------------- */

  function probeChannel(
    url: string
  ): Promise<{ ok: true; url: string; channel: string; count: number } | { ok: false; error: string }> {
    const ud = userData()
    return new Promise((resolve) => {
      let out = ''
      let err = ''
      let done = false
      let probeChild: ChildProcess
      try {
        probeChild = spawn(ytDlpCmd(ud), ['-J', '--flat-playlist', '--no-warnings', url], { windowsHide: true })
      } catch (e) {
        resolve({ ok: false, error: 'Could not start yt-dlp: ' + errMsg(e) })
        return
      }
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          probeChild.kill()
          resolve({ ok: false, error: 'Timed out reading that channel. Check the URL and your connection.' })
        }
      }, PROBE_TIMEOUT_MS)
      probeChild.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      probeChild.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
      probeChild.on('error', (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: false, error: 'Could not run yt-dlp: ' + errMsg(e) })
      })
      probeChild.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const start = out.indexOf('{')
        if (start < 0) {
          const detail = (err || 'no data').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
          resolve({ ok: false, error: 'Could not read that channel. ' + detail })
          return
        }
        try {
          const j = JSON.parse(out.slice(start)) as Record<string, unknown>
          const entries = Array.isArray(j.entries) ? j.entries : []
          const channel =
            String(j.channel ?? j.uploader ?? '').trim() || String(j.title ?? '').replace(/ - Videos$/i, '')
          resolve({ ok: true, url, channel: channel || 'Unknown channel', count: entries.length })
        } catch (e) {
          resolve({ ok: false, error: 'Could not parse yt-dlp output: ' + errMsg(e) })
        }
      })
    })
  }

  /* ------------------------- the ordered full stitch ---------------------- */

  /** Stitch EVERY numbered video in the channel folder — oldest → newest by
   *  default, random order when `shuffle` is true. File names are untouched. */
  async function stitchFolder(
    folder: string,
    channel: string,
    quality: string,
    shuffle: boolean,
    onOutPath?: (p: string) => void
  ): Promise<{ ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean }> {
    const ffmpeg = resolveFfmpeg()
    if (!ffmpeg) return { ok: false, error: 'ffmpeg is not available, so the videos cannot be stitched.' }
    const files = channelVideos(folder)
    if (files.length < 2) return { ok: false, error: `Only ${files.length} video(s) in ${folder} — need at least 2 to stitch.` }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const outPath = join(folder, `${sanitizeName(channel)} - Full Channel ${stamp}.mp4`)
    onOutPath?.(outPath)
    const tmpDir = join(moduleDir(), `combine-tmp-${Date.now()}`)
    send({
      kind: 'combine',
      done: 0,
      total: files.length,
      label: shuffle
        ? `Stitching ${files.length} videos in random order…`
        : `Stitching ${files.length} videos oldest → newest…`
    })
    const cRes = await combineClips(files, outPath, tmpDir, canvasFor(quality), {
      ffmpeg,
      ffprobe: resolveFfprobe(),
      shuffle,
      onNote: (note) => send({ kind: 'note', note }),
      onStep: (done, total, label) => send({ kind: 'combine', done, total, label }),
      registerChild: (c) => {
        child = c
      },
      shouldCancel: () => cancelRequested
    })
    if (cRes.cancelled) return { ok: false, cancelled: true }
    if (!cRes.ok) return { ok: false, error: cRes.error }
    send({ kind: 'note', note: `Full-channel movie saved: ${cRes.outPath}` })
    return { ok: true, path: cRes.outPath, used: cRes.used, total: cRes.total }
  }

  /** Stitch-only session (deferred/auto-prompt/crash-resume completion). */
  async function performStitch(
    p: { url: string; folder: string; channel: string; quality: string },
    attempts = 0,
    resumed = false
  ): Promise<DownloadOutcome> {
    if (busy) return { ok: false, error: 'A channel job is already running. Cancel it or wait for it to finish.' }
    busy = true
    cancelRequested = false
    writePendingJob({
      mode: 'stitch',
      phase: 'stitch',
      url: p.url,
      quality: p.quality,
      combine: true,
      channel: p.channel,
      folder: p.folder,
      startedAt: Date.now(),
      stitchOut: null,
      attempts
    })
    send({ kind: 'job-start', mode: 'stitch', label: p.channel || 'Channel stitch', resumed })
    try {
      const combined = await stitchFolder(p.folder, p.channel, p.quality, false, (out) => patchPendingJob({ stitchOut: out }))
      if (combined.ok) {
        upsertRecord({
          id: p.url,
          stitchedCount: channelVideos(p.folder).length,
          lastStitchAt: Date.now(),
          lastStitchPath: combined.path ?? null,
          autoDownloadedPending: 0
        })
      }
      const res: DownloadOutcome = combined.cancelled
        ? { ok: false, started: true, cancelled: true }
        : { ok: combined.ok, started: true, combined, error: combined.error }
      send({ kind: 'job-end', mode: 'stitch', ...res })
      return res
    } finally {
      busy = false
      child = null
      clearPendingJob()
    }
  }

  /* ------------------------------- download ------------------------------ */

  /** The whole download (+ optional stitch) session, shared by the manual
   *  handler, the launch-time auto-rescan sweep and crash resume. */
  async function performDownload(opts: {
    url: string
    quality: string
    combine: boolean
    shuffle?: boolean
    channel: string
    folder: string | null
    auto: boolean
    resumed?: boolean
    attempts?: number
  }): Promise<DownloadOutcome> {
    if (busy) return { ok: false, error: 'A channel job is already running. Cancel it or wait for it to finish.' }
    busy = true
    cancelRequested = false
    writePendingJob({
      mode: 'download',
      phase: 'download',
      url: opts.url,
      quality: opts.quality,
      combine: opts.combine,
      shuffle: opts.shuffle === true,
      channel: opts.channel,
      folder: opts.folder,
      startedAt: Date.now(),
      stitchOut: null,
      attempts: opts.attempts ?? 0
    })
    send({
      kind: 'job-start',
      mode: 'download',
      label: opts.channel || 'Channel download',
      resumed: opts.resumed === true
    })
    if (opts.resumed)
      send({ kind: 'note', note: 'Resumed after a restart — finished videos are skipped, partial ones continue.' })

    const finish = (outcome: DownloadOutcome): DownloadOutcome => {
      const res = { ...outcome, started: true }
      send({ kind: 'job-end', mode: 'download', ...res })
      return res
    }

    const ud = userData()
    if (!hasYtDlp(ud)) {
      const dl = await downloadYtDlp(ud)
      if (!dl.ok) {
        busy = false
        clearPendingJob()
        return { ok: false, error: 'yt-dlp is not installed: ' + (dl.error ?? '') }
      }
    }
    const dir = downloadDir()
    mkdirSync(dir, { recursive: true })
    const ffmpeg = resolveFfmpeg()
    const jobStart = Date.now()
    const manifestPath = join(moduleDir(), `combine-manifest-${jobStart}.txt`)
    mkdirSync(dirname(manifestPath), { recursive: true })

    // Oldest → newest: -I ::-1 reverses the /videos tab (site order is newest
    // first). playlist_autonumber counts the download queue in that reversed
    // order, so filenames sort chronologically and re-runs skip cleanly
    // (new uploads only append at the end).
    const args: string[] = [
      ...formatArgs(opts.quality),
      '-o',
      join(dir, '%(channel,uploader)s', '%(playlist_autonumber)04d - %(title)s [%(id)s].%(ext)s'),
      '-I',
      '::-1',
      // save each video's thumbnail alongside it, same basename, as .jpg
      '--write-thumbnail',
      '--convert-thumbnails',
      'jpg',
      '--newline',
      '--no-color',
      '--ignore-errors',
      '--no-mtime',
      '--concurrent-fragments',
      '4',
      '--progress-template',
      `download:${PGRESS}|%(info.playlist_autonumber)s|%(info.n_entries)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.title)s`,
      '--print-to-file',
      'after_move:filepath',
      manifestPath
    ]
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg)
    args.push(opts.url)

    const knownFolder = opts.folder && existsSync(opts.folder) ? opts.folder : null
    const countBefore = knownFolder ? channelVideos(knownFolder).length : 0

    try {
      let completed = 0
      const result = await spawnYtDlp(
        ytDlpCmd(ud),
        args,
        (line) => {
          const p = parseProgressLine(line)
          if (!p) return
          if ('note' in p) {
            if (/Downloading item|Destination|Merging|Extracting/.test(p.note)) send({ kind: 'note', note: p.note })
            if (/has already been downloaded/.test(p.note)) completed++
          } else {
            if (p.percent >= 100) completed++
            send({ kind: 'progress', ...p })
          }
        },
        (c) => {
          child = c
        }
      )

      // treeKill (taskkill) doesn't set child.killed, so check our flag too
      if (result.cancelled || cancelRequested) return finish({ ok: false, cancelled: true })

      // Locate the channel folder: this session's files, the known folder
      // (rescan/auto/resume flow), or nothing (fresh run that downloaded nothing).
      const sessionFiles = collectOutputs(manifestPath, dir, jobStart)
      const folderFromRun = sessionFiles.length > 0 ? dirname(sessionFiles[0]) : null
      const folder = folderFromRun ?? knownFolder
      const channel = (opts.channel && opts.channel.trim()) || (folder ? basename(folder) : 'Channel')

      // ---- ordered complete stitch (whole folder, all sessions) ----
      let combined: DownloadOutcome['combined'] = null
      if (opts.combine && !cancelRequested) {
        if (folder) {
          patchPendingJob({ phase: 'stitch', folder, channel })
          combined = await stitchFolder(folder, channel, opts.quality, opts.shuffle === true, (out) =>
            patchPendingJob({ stitchOut: out })
          )
        } else {
          combined = { ok: false, error: 'Could not locate the channel folder to stitch.' }
        }
      }

      // record the session in history
      const downloadedCount = folder ? channelVideos(folder).length : completed
      const newlyDownloaded = folder ? Math.max(0, downloadedCount - countBefore) : completed
      const prev = readHistory().find((c) => c.id === opts.url)
      upsertRecord({
        id: opts.url,
        url: opts.url,
        channel,
        folder,
        quality: opts.quality,
        downloadedCount,
        lastDownloadAt: Date.now(),
        ...(combined?.ok
          ? { stitchedCount: downloadedCount, lastStitchAt: Date.now(), lastStitchPath: combined.path ?? null, autoDownloadedPending: 0 }
          : opts.auto
            ? { autoDownloadedPending: (prev?.autoDownloadedPending ?? 0) + newlyDownloaded }
            : {})
      })

      if (!result.ok) {
        const tail = result.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
        // members-only / removed videos exit non-zero even with --ignore-errors
        return finish({ ok: completed > 0, warning: completed > 0, error: tail || `yt-dlp exited with code ${result.code}`, completed, combined })
      }
      return finish({ ok: true, completed, combined })
    } finally {
      busy = false
      child = null
      clearPendingJob()
      try {
        rmSync(manifestPath, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /* ----------------------- crash resume at launch ------------------------- */

  const interrupted = readPendingJob()
  if (interrupted) {
    setTimeout(() => {
      void (async () => {
        if (busy) return
        const p = interrupted
        if (p.attempts >= MAX_RESUME_ATTEMPTS) {
          console.error(`[${ID}] giving up on interrupted job after ${p.attempts} resume attempts`)
          clearPendingJob()
          return
        }
        // A half-written stitched movie can't be completed — delete it; the
        // resumed run stitches a fresh one from the (intact) numbered videos.
        if (p.stitchOut && existsSync(p.stitchOut)) {
          try {
            rmSync(p.stitchOut, { force: true })
            console.log(`[${ID}] deleted partial stitched movie: ${p.stitchOut}`)
          } catch {
            /* ignore */
          }
        }
        console.log(`[${ID}] resuming interrupted ${p.phase} for ${p.channel || p.url}`)
        if (p.phase === 'stitch') {
          const folder =
            p.folder && existsSync(p.folder)
              ? p.folder
              : (readHistory().find((c) => c.id === p.url)?.folder ?? null)
          if (!folder || !existsSync(folder)) {
            clearPendingJob()
            return
          }
          await performStitch(
            { url: p.url, folder, channel: p.channel || basename(folder), quality: p.quality },
            p.attempts + 1,
            true
          )
        } else {
          await performDownload({
            url: p.url,
            quality: p.quality,
            combine: p.combine,
            shuffle: p.shuffle === true,
            channel: p.channel,
            folder: p.folder,
            auto: false,
            resumed: true,
            attempts: p.attempts + 1
          })
        }
      })()
    }, RESUME_DELAY_MS)
  }

  /* ----------------------- launch-time auto rescan ------------------------ */

  // Shortly after every app launch, quietly bring auto-rescan channels up to
  // date (downloads only — stitching always waits for the user's go-ahead).
  setTimeout(() => {
    void (async () => {
      const recs = readHistory().filter((r) => r.autoRescan)
      if (recs.length === 0 || !hasYtDlp(userData())) return
      for (const rec of recs) {
        if (busy) break // never fight a job the user started (or a resume)
        try {
          const probe = await probeChannel(rec.url)
          if (!probe.ok) continue
          const newCount = Math.max(0, probe.count - rec.downloadedCount)
          if (newCount === 0) continue
          console.log(`[${ID}] auto-rescan: ${newCount} new upload(s) on ${rec.channel} — downloading`)
          await performDownload({
            url: rec.url,
            quality: rec.quality,
            combine: false,
            channel: probe.channel || rec.channel,
            folder: rec.folder,
            auto: true
          })
        } catch (err) {
          console.error(`[${ID}] auto-rescan failed for ${rec.channel}:`, err)
        }
      }
    })()
  }, AUTO_SWEEP_DELAY_MS)

  /* --------------------------------- ipc --------------------------------- */

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    binReady: hasYtDlp(userData()),
    ffmpegReady: resolveFfmpeg() !== null,
    downloadDir: downloadDir(),
    busy
  }))

  ctx.ipcMain.handle(`${ID}:open-folder`, async () => {
    const dir = downloadDir()
    mkdirSync(dir, { recursive: true })
    await ctx.shell.openPath(dir)
    return { ok: true }
  })

  // Set this tool's default save location (its own folder, independent of the
  // Custom Playlist Downloader). Existing channels keep their saved absolute
  // paths; only new channels use the new location.
  ctx.ipcMain.handle(`${ID}:pick-folder`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Choose where to save downloaded channels',
      properties: ['openDirectory' as const, 'createDirectory' as const],
      defaultPath: downloadDir()
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
    ctx.storeSet(DIR_KEY, res.filePaths[0])
    return { ok: true, downloadDir: res.filePaths[0] }
  })

  ctx.ipcMain.handle(`${ID}:history`, () => ({
    ok: true,
    channels: readHistory().sort((a, b) => b.lastDownloadAt - a.lastDownloadAt)
  }))

  ctx.ipcMain.handle(`${ID}:set-auto`, (_e, raw: unknown) => {
    const r = asRecord(raw)
    const rec = readHistory().find((c) => c.id === r.id)
    if (!rec) return { ok: false, error: 'Channel not found in history.' }
    upsertRecord({ id: rec.id, autoRescan: r.enabled === true })
    return { ok: true }
  })

  /** "Postpone" on the auto-download prompt: stop nagging until more arrive. */
  ctx.ipcMain.handle(`${ID}:ack-auto`, (_e, raw: unknown) => {
    const rec = readHistory().find((c) => c.id === asRecord(raw).id)
    if (!rec) return { ok: false, error: 'Channel not found in history.' }
    upsertRecord({ id: rec.id, autoDownloadedPending: 0 })
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:probe`, async (_e, raw: unknown) => {
    const url = normalizeChannelUrl(asRecord(raw).url)
    if (!url) return { ok: false, error: 'Paste a YouTube channel URL (youtube.com/@handle or /channel/…).' }
    const ud = userData()
    if (!hasYtDlp(ud)) {
      const dl = await downloadYtDlp(ud)
      if (!dl.ok) return { ok: false, error: 'yt-dlp is not installed yet: ' + (dl.error ?? '') }
    }
    return probeChannel(url)
  })

  /**
   * Rescan a saved channel: how many uploads exist now vs what we downloaded,
   * and how many downloaded videos are still missing from the stitched movie.
   * The renderer turns this into the "new uploads found" choice popup.
   */
  ctx.ipcMain.handle(`${ID}:rescan`, async (_e, raw: unknown) => {
    const rec = readHistory().find((c) => c.id === asRecord(raw).id)
    if (!rec) return { ok: false, error: 'Channel not found in history.' }
    const probe = await probeChannel(rec.url)
    if (!probe.ok) return probe
    const newCount = Math.max(0, probe.count - rec.downloadedCount)
    const backlog = Math.max(0, rec.downloadedCount - rec.stitchedCount)
    if (probe.channel && probe.channel !== 'Unknown channel') upsertRecord({ id: rec.id, channel: probe.channel })
    return {
      ok: true,
      id: rec.id,
      channel: probe.channel || rec.channel,
      remoteCount: probe.count,
      downloadedCount: rec.downloadedCount,
      stitchedCount: rec.stitchedCount,
      newCount,
      backlog
    }
  })

  /** Stitch-only for a saved channel (completing a deferred stitch). */
  ctx.ipcMain.handle(`${ID}:stitch`, async (_e, raw: unknown) => {
    const rec = readHistory().find((c) => c.id === asRecord(raw).id)
    if (!rec) return { ok: false, error: 'Channel not found in history.' }
    if (!rec.folder || !existsSync(rec.folder))
      return { ok: false, error: 'The channel folder could not be found — run a download first.' }
    return performStitch({
      url: rec.url,
      folder: rec.folder,
      channel: rec.channel || basename(rec.folder),
      quality: rec.quality
    })
  })

  ctx.ipcMain.handle(`${ID}:download`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const url = normalizeChannelUrl(r.url)
    if (!url) return { ok: false, error: 'Paste a YouTube channel URL first.' }
    const quality = typeof r.quality === 'string' && !isAudioQuality(r.quality) ? r.quality : '1080'
    return performDownload({
      url,
      quality,
      combine: r.combine !== false,
      shuffle: r.shuffle === true,
      channel: typeof r.channel === 'string' ? r.channel : '',
      folder: typeof r.folder === 'string' ? r.folder : null,
      auto: false
    })
  })

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    cancelRequested = true
    if (child) {
      treeKill(child)
      return { ok: true, cancelled: true }
    }
    return { ok: true, cancelled: false }
  })

  // Quitting mid-job must not orphan yt-dlp/ffmpeg. The pending-job journal
  // survives (cancelRequested stays false), so the next launch resumes it.
  ctx.app.on('before-quit', () => {
    if (child) treeKill(child)
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const dir = downloadDir()
    return [
      {
        label: 'Downloads folder',
        path: existsSync(dir) ? dir : null,
        note: 'This tool’s own save location (set it in the app) — each channel gets its own subfolder'
      },
      {
        label: 'Channel history',
        path: existsSync(historyFile()) ? historyFile() : null,
        note: 'Downloaded channels + stitch state (JSON)'
      }
    ]
  })
}

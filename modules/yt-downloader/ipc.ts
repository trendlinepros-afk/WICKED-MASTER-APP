import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  binDir,
  buildDownloadArgs,
  downloadYtDlp,
  hasYtDlp,
  isAudioQuality,
  isBinaryTooOld,
  parseProgressLine,
  parseYtUrl,
  resolveFfmpeg,
  resolveFfprobe,
  spawnYtDlp,
  ytDlpCmd,
  ytDlpPath,
  type DownloadRequest
} from './ipc/ytdlp'
import { canvasFor, collectOutputs, combineClips, sanitizeName } from './ipc/combine'

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
 * ------------------------------------------------------------------------ */

const ID = 'yt-downloader'
const DIR_KEY = `${ID}.downloadDir`
const MUSIC_AUDIO_ONLY_KEY = `${ID}.musicAudioOnly`
const MUSIC_FORMAT_KEY = `${ID}.musicFormat`
const COMBINE_KEY = `${ID}.combineClips`
const PROBE_TIMEOUT_MS = 90_000
const MAX_JOBS = 3

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
  }
  const jobs = new Map<string, Job>()

  const userData = (): string => ctx.app.getPath('userData')

  // Sweep ffmpeg scratch left by interrupted combines (app closed / crashed
  // mid-stitch). These normalized clips can be GIGABYTES, and stale ones once
  // bloated the Cloud Sync snapshot past Node's string limit. No job can be
  // running this early, so anything matching is guaranteed stale.
  try {
    const moduleDir = join(userData(), 'modules', ID)
    for (const name of readdirSync(moduleDir)) {
      if (/^combine-(tmp|manifest-)/.test(name)) {
        rmSync(join(moduleDir, name), { recursive: true, force: true })
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
      downloadDir: downloadDir(),
      busy: jobs.size > 0,
      activeJobs: jobs.size,
      maxJobs: MAX_JOBS
    }
  })

  ctx.ipcMain.handle(`${ID}:ensure`, async () => {
    const ud = userData()
    if (hasYtDlp(ud)) return { ok: true, already: true }
    send(`${ID}:status-msg`, 'Downloading yt-dlp (one-time setup)…')
    const res = await downloadYtDlp(ud)
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })

  ctx.ipcMain.handle(`${ID}:update`, async () => {
    send(`${ID}:status-msg`, 'Updating yt-dlp to the latest release…')
    const res = await downloadYtDlp(userData())
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  })

  /* ------------------------------- prefs --------------------------------- *
   * Persisted module preferences (shell store, `<module-id>.` prefixed).
   * "Audio only for YouTube Music links" is ON by default: a music.youtube.com
   * link is a song, so grabbing video is almost never what's wanted.
   * ---------------------------------------------------------------------- */

  const prefs = (): { musicAudioOnly: boolean; musicFormat: string; combineClips: boolean } => {
    const fmt = ctx.storeGet<string>(MUSIC_FORMAT_KEY, 'audio')
    return {
      musicAudioOnly: ctx.storeGet<boolean>(MUSIC_AUDIO_ONLY_KEY, true) !== false,
      musicFormat: fmt === 'audio-native' ? 'audio-native' : 'audio',
      combineClips: ctx.storeGet<boolean>(COMBINE_KEY, false) === true
    }
  }

  ctx.ipcMain.handle(`${ID}:prefs-get`, () => ({ ok: true, ...prefs() }))

  ctx.ipcMain.handle(`${ID}:prefs-set`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    if (typeof r.musicAudioOnly === 'boolean') ctx.storeSet(MUSIC_AUDIO_ONLY_KEY, r.musicAudioOnly)
    if (r.musicFormat === 'audio' || r.musicFormat === 'audio-native')
      ctx.storeSet(MUSIC_FORMAT_KEY, r.musicFormat)
    if (typeof r.combineClips === 'boolean') ctx.storeSet(COMBINE_KEY, r.combineClips)
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

  ctx.ipcMain.handle(`${ID}:download`, async (_e, rawReq: unknown) => {
    const r = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const jobId =
      typeof r.jobId === 'string' && r.jobId
        ? r.jobId
        : `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return { ok: false, jobId, error: 'A YouTube URL is required.' }
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

    try {
      const ud = userData()
      if (!hasYtDlp(ud)) {
        const dl = await downloadYtDlp(ud)
        if (!dl.ok) return { ok: false, jobId, error: 'yt-dlp is not installed: ' + (dl.error ?? '') }
      }
      const dir = downloadDir()
      mkdirSync(dir, { recursive: true })

      const quality = typeof r.quality === 'string' ? r.quality : 'best'
      const isPlaylist = r.isPlaylist === true
      const ffmpeg = resolveFfmpeg()
      // "Combine clips" only makes sense for a multi-item VIDEO download and needs
      // ffmpeg. It's ignored for single videos and audio jobs.
      const wantCombine = r.combine === true && isPlaylist && !isAudioQuality(quality) && !!ffmpeg
      const jobStart = Date.now()
      const manifestPath = wantCombine ? join(ud, 'modules', ID, `combine-manifest-${jobId}.txt`) : undefined
      if (manifestPath) mkdirSync(dirname(manifestPath), { recursive: true })

      const req: DownloadRequest = { url, quality, isPlaylist, downloadDir: dir, manifestPath }
      const args = buildDownloadArgs(req, ffmpeg)

      let completed = 0
      const result = await spawnYtDlp(
        ytDlpCmd(ud),
        args,
        (line) => {
          const p = parseProgressLine(line)
          if (!p) return
          if ('note' in p) {
            if (/Downloading item|Destination|Merging|Extracting/.test(p.note)) sendP({ kind: 'note', note: p.note })
            if (/has already been downloaded/.test(p.note)) completed++
          } else {
            if (p.percent >= 100) completed++
            sendP({ kind: 'progress', ...p })
          }
        },
        (child) => {
          job.child = child
        }
      )

      if (result.cancelled) return { ok: false, jobId, cancelled: true }

      // ---- combine phase (best-effort; never fails the download itself) ----
      let combined:
        | { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean }
        | null = null
      if (wantCombine && !job.cancelRequested) {
        const files = collectOutputs(manifestPath ?? null, dir, jobStart)
        if (files.length >= 2 && ffmpeg) {
          const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'Playlist'
          const stamp = new Date(jobStart).toISOString().slice(0, 16).replace(/[:T]/g, '-')
          // Save the movie ALONGSIDE the clips (playlist downloads land in their
          // own subfolder), matching what the UI promises.
          const clipDirs = new Set(files.map((f) => dirname(f)))
          const outDir = clipDirs.size === 1 ? [...clipDirs][0] : dir
          const outPath = join(outDir, `${sanitizeName(title)} - Combined ${stamp}.mp4`)
          const tmpDir = join(ud, 'modules', ID, `combine-tmp-${jobId}`)
          sendP({ kind: 'combine', done: 0, total: files.length, label: `Combining ${files.length} clips…` })
          const cRes = await combineClips(files, outPath, tmpDir, canvasFor(quality), {
            ffmpeg,
            ffprobe: resolveFfprobe(),
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

      if (!result.ok) {
        const tail = result.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
        // yt-dlp exits non-zero if ANY item failed even with --ignore-errors;
        // treat as a soft warning when at least something downloaded.
        return { ok: completed > 0, jobId, warning: completed > 0, error: tail || `yt-dlp exited with code ${result.code}`, completed, combined }
      }
      return { ok: true, jobId, completed, combined }
    } finally {
      jobs.delete(jobId)
      const manifest = join(userData(), 'modules', ID, `combine-manifest-${jobId}.txt`)
      if (existsSync(manifest)) {
        try {
          rmSync(manifest, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
  })

  // Cancel one job (jobId) or, with no argument, all running jobs — the latter
  // keeps the MCP cancel tool and any older callers working unchanged.
  ctx.ipcMain.handle(`${ID}:cancel`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const targetId = typeof r.jobId === 'string' && r.jobId ? r.jobId : null
    const targets = targetId ? [jobs.get(targetId)].filter((j): j is Job => !!j) : [...jobs.values()]
    let killed = 0
    for (const j of targets) {
      j.cancelRequested = true
      if (j.child) {
        j.child.kill()
        killed++
      }
    }
    return { ok: true, cancelled: killed > 0 }
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

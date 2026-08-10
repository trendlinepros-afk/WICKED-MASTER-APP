import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join } from 'path'
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
  ytDlpCmd
} from '../yt-downloader/ipc/ytdlp'
import { canvasFor, collectOutputs, combineClips, sanitizeName } from '../yt-downloader/ipc/combine'

/* ------------------------------------------------------------------------ *
 *  TOTAL CHANNEL DOWNLOADER — main process.
 *
 *  Takes a YouTube CHANNEL URL and downloads the creator's entire long-form
 *  library. The channel's /videos tab is used, which inherently excludes
 *  Shorts, community posts and live streams. Download order is reversed
 *  (-I ::-1) so videos arrive OLDEST → NEWEST, numbered in that order, and
 *  the optional combine stitches them into one movie in the same order (no
 *  shuffle). Shares yt-dlp, ffmpeg and the download folder with the Custom
 *  Playlist Downloader. One channel job runs at a time.
 * ------------------------------------------------------------------------ */

const ID = 'yt-channel-downloader'
const PROBE_TIMEOUT_MS = 120_000

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

export default function register(ctx: ModuleIpcContext): void {
  let child: ChildProcess | null = null
  let cancelRequested = false

  const userData = (): string => ctx.app.getPath('userData')
  const moduleDir = (): string => join(userData(), 'modules', ID)

  // Same destination as the Custom Playlist Downloader — one YouTube folder.
  const downloadDir = (): string => {
    const v = ctx.storeGet<string>('yt-downloader.downloadDir', '')
    return v && v.trim() ? v : join(ctx.app.getPath('downloads'), 'WICKED YouTube')
  }

  const send = (payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(`${ID}:progress`, payload)
  }

  // Sweep ffmpeg scratch left by interrupted stitches (names use the combine-
  // prefixes so the backup/sync layer excludes them too).
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

  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    binReady: hasYtDlp(userData()),
    ffmpegReady: resolveFfmpeg() !== null,
    downloadDir: downloadDir(),
    busy: child !== null
  }))

  ctx.ipcMain.handle(`${ID}:open-folder`, async () => {
    const dir = downloadDir()
    mkdirSync(dir, { recursive: true })
    await ctx.shell.openPath(dir)
    return { ok: true }
  })

  /* -------------------------------- probe -------------------------------- */

  ctx.ipcMain.handle(`${ID}:probe`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const url = normalizeChannelUrl(r.url)
    if (!url) return { ok: false, error: 'Paste a YouTube channel URL (youtube.com/@handle or /channel/…).' }
    const ud = userData()
    if (!hasYtDlp(ud)) {
      const dl = await downloadYtDlp(ud)
      if (!dl.ok) return { ok: false, error: 'yt-dlp is not installed yet: ' + (dl.error ?? '') }
    }
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
          const channel = String(j.channel ?? j.uploader ?? '').trim() || String(j.title ?? '').replace(/ - Videos$/i, '')
          resolve({ ok: true, url, channel: channel || 'Unknown channel', count: entries.length })
        } catch (e) {
          resolve({ ok: false, error: 'Could not parse yt-dlp output: ' + errMsg(e) })
        }
      })
    })
  })

  /* ------------------------------- download ------------------------------ */

  ctx.ipcMain.handle(`${ID}:download`, async (_e, raw: unknown) => {
    if (child) return { ok: false, error: 'A channel download is already running. Cancel it or wait for it to finish.' }
    const r = asRecord(raw)
    const url = normalizeChannelUrl(r.url)
    if (!url) return { ok: false, error: 'Paste a YouTube channel URL first.' }
    const quality = typeof r.quality === 'string' && !isAudioQuality(r.quality) ? r.quality : '1080'
    const wantCombine = r.combine !== false
    cancelRequested = false

    const ud = userData()
    if (!hasYtDlp(ud)) {
      const dl = await downloadYtDlp(ud)
      if (!dl.ok) return { ok: false, error: 'yt-dlp is not installed: ' + (dl.error ?? '') }
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
      ...formatArgs(quality),
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
    args.push(url)

    const cleanupManifest = (): void => {
      try {
        rmSync(manifestPath, { force: true })
      } catch {
        /* ignore */
      }
    }

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

      if (result.cancelled) return { ok: false, cancelled: true }

      // ---- ordered combine (oldest → newest), best-effort ----
      let combined:
        | { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean }
        | null = null
      if (wantCombine && !cancelRequested && ffmpeg) {
        const files = collectOutputs(manifestPath, dir, jobStart)
        if (files.length >= 2) {
          const channel = typeof r.channel === 'string' && r.channel.trim() ? r.channel.trim() : 'Channel'
          const stamp = new Date(jobStart).toISOString().slice(0, 16).replace(/[:T]/g, '-')
          const clipDirs = new Set(files.map((f) => dirname(f)))
          const outDir = clipDirs.size === 1 ? [...clipDirs][0] : dir
          const outPath = join(outDir, `${sanitizeName(channel)} - Full Channel ${stamp}.mp4`)
          const tmpDir = join(moduleDir(), `combine-tmp-${jobStart}`)
          send({ kind: 'combine', done: 0, total: files.length, label: `Stitching ${files.length} videos oldest → newest…` })
          const cRes = await combineClips(files, outPath, tmpDir, canvasFor(quality), {
            ffmpeg,
            ffprobe: resolveFfprobe(),
            shuffle: false, // chronological, never shuffled
            onNote: (note) => send({ kind: 'note', note }),
            onStep: (done, total, label) => send({ kind: 'combine', done, total, label }),
            registerChild: (c) => {
              child = c
            },
            shouldCancel: () => cancelRequested
          })
          combined = cRes.cancelled
            ? { ok: false, cancelled: true }
            : cRes.ok
              ? { ok: true, path: cRes.outPath, used: cRes.used, total: cRes.total }
              : { ok: false, error: cRes.error }
          if (cRes.ok && cRes.outPath) send({ kind: 'note', note: `Full-channel movie saved: ${cRes.outPath}` })
        } else {
          combined = { ok: false, error: `Only ${files.length} downloaded file(s) found — need at least 2 to combine.` }
        }
      } else if (wantCombine && !ffmpeg) {
        combined = { ok: false, error: 'ffmpeg is not available, so the videos were not combined.' }
      }

      if (!result.ok) {
        const tail = result.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
        // members-only / removed videos exit non-zero even with --ignore-errors
        return { ok: completed > 0, warning: completed > 0, error: tail || `yt-dlp exited with code ${result.code}`, completed, combined }
      }
      return { ok: true, completed, combined }
    } finally {
      child = null
      cleanupManifest()
    }
  })

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    cancelRequested = true
    if (child) {
      child.kill()
      return { ok: true, cancelled: true }
    }
    return { ok: true, cancelled: false }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const dir = downloadDir()
    return [
      {
        label: 'Downloads folder',
        path: existsSync(dir) ? dir : null,
        note: 'Shared with the Custom Playlist Downloader — each channel gets its own subfolder'
      }
    ]
  })
}

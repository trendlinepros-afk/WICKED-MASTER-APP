/**
 * ffmpeg / ffprobe for ScreenRec (bundled ffmpeg-static / ffprobe-static,
 * unpacked from the asar by electron-builder). Every run is cancellable and
 * reports progress from `-progress pipe:1`.
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'

function resolveBin(mod: string, fallback: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require(mod)
    let p: string | undefined = typeof m === 'string' ? m : m?.path
    if (p) p = p.replace(/\bapp\.asar([\\/])/, 'app.asar.unpacked$1')
    if (p && existsSync(p)) return p
  } catch {
    /* fall back to PATH */
  }
  return fallback
}

export const FFMPEG = resolveBin('ffmpeg-static', 'ffmpeg')
export const FFPROBE = resolveBin('ffprobe-static', 'ffprobe')

export interface RunOpts {
  signal?: AbortSignal
  totalSec?: number
  onProgress?: (fraction: number) => void
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly tail: string
  ) {
    super(message)
  }
}

export function runFfmpeg(args: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-y', ...args]
    if (opts.onProgress) full.splice(3, 0, '-progress', 'pipe:1', '-nostats')
    const child = spawn(FFMPEG, full, { windowsHide: true })
    let stderr = ''
    let partial = ''
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 65536) stderr = stderr.slice(-32768)
    })
    child.stdout.on('data', (d) => {
      const lines = (partial + d.toString()).split('\n')
      partial = lines.pop() ?? ''
      if (partial.length > 4096) partial = ''
      if (!opts.onProgress || !opts.totalSec) return
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(lines[i])
        if (m) {
          opts.onProgress(Math.min(1, Number(m[1]) / 1_000_000 / opts.totalSec))
          break
        }
      }
    })
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(new FfmpegError(`ffmpeg could not start: ${err.message}`, ''))
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new FfmpegError('Cancelled', ''))
      if (code === 0) return resolve(stderr)
      const tail = stderr
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-6)
        .join('\n')
      reject(new FfmpegError(`ffmpeg failed (exit ${code}): ${tail.split('\n').pop() ?? ''}`, tail))
    })
  })
}

export interface ProbeInfo {
  durationSec: number | null
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
}

export function probeMedia(file: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => reject(new Error(`ffprobe could not start: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `ffprobe exit ${code}`))
      try {
        const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] }
        const streams = j.streams ?? []
        const v = streams.find((s) => s.codec_type === 'video')
        const d = Number(j.format?.duration)
        resolve({
          durationSec: Number.isFinite(d) && d > 0 ? d : null,
          hasVideo: !!v,
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
          width: v?.width ?? 0,
          height: v?.height ?? 0
        })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  })
}

/** Duration by decoding (for a file whose container carries none, e.g. a cut-off recording). */
export async function decodeDuration(file: string): Promise<number | null> {
  try {
    const log = await runFfmpeg(['-i', file, '-map', '0', '-f', 'null', '-'])
    const all = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
    const m = all[all.length - 1]
    if (!m) return null
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  } catch {
    return null
  }
}

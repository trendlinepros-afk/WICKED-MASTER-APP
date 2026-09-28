/**
 * Pure ffmpeg argument builders for the session render (tested headless
 * against a real ffmpeg). Two stages:
 *
 *  1. every clip → a normalised segment: crop (taskbar / custom area), fit or
 *     fill 1920×1080, constant frame rate, exact duration, PCM stereo audio
 *     (silence if the clip had none). Identical encoder settings for all.
 *  2. concat the segments (video stream-copied — encoded once) and mix the
 *     voice with the optional music bed at the chosen dB → AAC → MP4.
 */
import type { FitMode, Frac, RenderQuality } from '../types'
import { isFull, normFrac } from './geometry'

export const OUT_W = 1920
export const OUT_H = 1080

export interface PlanClip {
  file: string
  durationSec: number
  hasAudio: boolean
  crop: Frac
}

export interface SegmentOptions {
  fps: number
  fit: FitMode
  quality: RenderQuality
}

export interface MusicOptions {
  path: string
  db: number
  loop: boolean
  fade: boolean
  duck: boolean
}

const num = (v: number, digits = 6): string => {
  const s = (Number.isFinite(v) ? v : 0).toFixed(digits)
  return s.replace(/\.?0+$/, '') || '0'
}

export const CRF: Record<RenderQuality, number> = { standard: 23, high: 20, max: 17 }

export function videoFilter(crop: Frac, fit: FitMode, fps: number, durationSec: number): string {
  const parts: string[] = []
  const c = normFrac(crop)
  if (!isFull(c)) {
    // even sizes/offsets keep yuv420p happy; trunc() never overruns the frame
    parts.push(
      `crop=w='trunc(iw*${num(c.w)}/2)*2':h='trunc(ih*${num(c.h)}/2)*2':x='trunc(iw*${num(c.x)}/2)*2':y='trunc(ih*${num(c.y)}/2)*2'`
    )
  }
  if (fit === 'fill') {
    parts.push(`scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos`, `crop=${OUT_W}:${OUT_H}`)
  } else {
    parts.push(`scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`, `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2:color=black`)
  }
  const d = num(durationSec, 3)
  parts.push(
    'setsar=1',
    // screen capture is variable-frame-rate (no new frames while nothing
    // moves) and may start a hair after the audio: pad the start from 0,
    // fill gaps, hold the last frame, then cut to the exact clip length
    `fps=${fps}:start_time=0`,
    `tpad=stop_mode=clone:stop_duration=${Math.ceil(durationSec) + 2}`,
    `trim=duration=${d}`,
    'setpts=PTS-STARTPTS',
    'format=yuv420p'
  )
  return parts.join(',')
}

export function audioFilter(durationSec: number, fromSilence: boolean): string {
  const d = num(durationSec, 3)
  if (fromSilence) return `atrim=duration=${d},asetpts=PTS-STARTPTS`
  return [
    'aresample=48000:async=1:first_pts=0',
    'aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
    'apad',
    `atrim=duration=${d}`,
    'asetpts=PTS-STARTPTS'
  ].join(',')
}

/** Stage 1 — one clip to a normalised MKV segment (H.264 + PCM). */
export function segmentArgs(clip: PlanClip, o: SegmentOptions, outFile: string): string[] {
  const args = ['-i', clip.file]
  if (!clip.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  args.push(
    '-map',
    '0:v:0',
    '-map',
    clip.hasAudio ? '0:a:0' : '1:a:0',
    '-vf',
    videoFilter(clip.crop, o.fit, o.fps, clip.durationSec),
    '-af',
    audioFilter(clip.durationSec, !clip.hasAudio),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(CRF[o.quality]),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(o.fps * 2),
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    num(clip.durationSec, 3),
    '-f',
    'matroska',
    outFile
  )
  return args
}

/** concat-demuxer list; entries are file names relative to the list's folder. */
export function concatList(fileNames: string[]): string {
  return fileNames.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** Stage 2 — filter graph for the final audio. Input 0 = concatenated segments, 1 = music. */
export function mixGraph(totalSec: number, voiceDb: number, music: MusicOptions | null): string {
  const T = num(totalSec, 3)
  const voice = `[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${num(voiceDb, 2)}dB`
  const limiter = 'alimiter=limit=0.97:level=0'
  if (!music) return `${voice},${limiter}[aout]`
  const fades: string[] = []
  if (music.fade) {
    const fi = Math.min(1.5, totalSec / 4)
    const fo = Math.min(3, totalSec / 3)
    fades.push(`afade=t=in:st=0:d=${num(fi, 3)}`, `afade=t=out:st=${num(Math.max(0, totalSec - fo), 3)}:d=${num(fo, 3)}`)
  }
  const mus = [
    '[1:a]aresample=48000',
    'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
    `volume=${num(music.db, 2)}dB`,
    `atrim=duration=${T}`,
    'asetpts=PTS-STARTPTS',
    ...fades
  ].join(',')
  const mixer = `amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${limiter}[aout]`
  if (music.duck) {
    return [
      `${voice},asplit=2[voice][sc]`,
      `${mus}[mus]`,
      '[mus][sc]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=450[ducked]',
      `[voice][ducked]${mixer}`
    ].join(';')
  }
  return [`${voice}[voice]`, `${mus}[mus]`, `[voice][mus]${mixer}`].join(';')
}

/** Stage 2 — concat + mix → MP4. */
export function finalArgs(listFile: string, totalSec: number, voiceDb: number, music: MusicOptions | null, outFile: string): string[] {
  const args = ['-f', 'concat', '-safe', '0', '-i', listFile]
  if (music) {
    if (music.loop) args.push('-stream_loop', '-1')
    args.push('-i', music.path)
  }
  args.push(
    '-filter_complex',
    mixGraph(totalSec, voiceDb, music),
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    num(totalSec, 3),
    '-movflags',
    '+faststart',
    outFile
  )
  return args
}

/** Frame grab for a clip's thumbnail, already cropped the way it will render. */
export function thumbArgs(file: string, crop: Frac, atSec: number, outFile: string): string[] {
  const c = normFrac(crop)
  const vf = isFull(c)
    ? 'scale=480:-2'
    : `crop=w='trunc(iw*${num(c.w)}/2)*2':h='trunc(ih*${num(c.h)}/2)*2':x='trunc(iw*${num(c.x)}/2)*2':y='trunc(ih*${num(c.y)}/2)*2',scale=480:-2`
  return ['-ss', num(Math.max(0, atSec), 3), '-i', file, '-frames:v', '1', '-vf', vf, '-q:v', '4', outFile]
}

/** A safe output file name ("ScreenRec 2026-09-28 1412.mp4"). */
export function outputName(raw: string, at = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`
  let base = String(raw || '')
    .replace(/\.mp4$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  if (!base || /^\.+$/.test(base)) base = `ScreenRec ${stamp}`
  return `${base}.mp4`
}

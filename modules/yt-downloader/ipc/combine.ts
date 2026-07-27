import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'

/**
 * COMBINE CLIPS — stitch a downloaded playlist into ONE video.
 *
 * Playlist clips come in wildly different resolutions, frame rates, codecs and
 * some may have no audio at all, so a fast `concat` demuxer with `-c copy`
 * would fail or desync. Instead we NORMALIZE every clip to identical parameters
 * (same canvas via scale+pad, same fps, yuv420p, AAC 48k stereo — synthesizing
 * silence when a clip has no audio) and THEN concat the normalized copies with
 * `-c copy`, which is fast and glitch-free.
 *
 * Everything here is pure/argument-level except the two spawn helpers, so the
 * command construction and file selection are unit-tested directly.
 */

export const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.ts', '.mpg', '.mpeg']

export function isVideoFile(p: string): boolean {
  return VIDEO_EXTS.includes(extname(p).toLowerCase())
}

/** Fisher–Yates shuffle with an injectable RNG (default Math.random). */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Filesystem-safe filename fragment from a (possibly messy) title. */
export function sanitizeName(name: string): string {
  const clean = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim()
  return clean || 'Combined'
}

/** Common 16:9 canvas (even dims) for a quality preset height; 1080 default. */
export function canvasFor(quality: string): { w: number; h: number } {
  const n = Number(quality)
  let h = Number.isFinite(n) && n > 0 ? n : 1080
  h = Math.min(2160, Math.max(240, h))
  let w = Math.round((h * 16) / 9)
  if (w % 2) w++
  if (h % 2) h++
  return { w, h }
}

/** yt-dlp writes each final path here (via --print-to-file); parse it back. */
export function parseManifest(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

function walkVideos(dir: string, sinceMs: number, out: Set<string>, depth = 0): void {
  if (depth > 6) return
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walkVideos(p, sinceMs, out, depth + 1)
    else if (isVideoFile(p) && st.mtimeMs >= sinceMs) out.add(p)
  }
}

/**
 * The exact files this job produced. Prefer yt-dlp's manifest (precise); fall
 * back to scanning the download folder for video files written during the job
 * (yt-dlp runs with --no-mtime, so freshly downloaded files carry "now").
 */
export function collectOutputs(manifestPath: string | null, downloadDir: string, sinceMs: number): string[] {
  const set = new Set<string>()
  if (manifestPath && existsSync(manifestPath)) {
    for (const p of parseManifest(readFileSync(manifestPath, 'utf8'))) {
      if (isVideoFile(p) && existsSync(p)) set.add(p)
    }
  }
  if (set.size === 0) walkVideos(downloadDir, sinceMs - 5000, set)
  return [...set]
}

/* ------------------------------ ffmpeg args ------------------------------ */

/** ffprobe argv that prints audio stream indexes (empty output = no audio). */
export function buildProbeAudioArgs(input: string): string[] {
  return ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', input]
}

/**
 * Re-encode one clip to the shared canvas/fps/codec so the copies are
 * byte-compatible for concat. Missing audio is replaced with generated silence
 * (anullsrc) so every normalized clip has exactly one video + one audio stream.
 */
export function buildNormalizeArgs(
  input: string,
  output: string,
  canvas: { w: number; h: number },
  hasAudio: boolean,
  fps = 30
): string[] {
  const vf =
    `scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=decrease,` +
    `pad=${canvas.w}:${canvas.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`
  const args = ['-y', '-i', input]
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  args.push(
    '-map', '0:v:0',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '192k'
  )
  // Only bound to video length when we synthesized an endless silent track.
  if (!hasAudio) args.push('-shortest')
  args.push('-movflags', '+faststart', output)
  return args
}

/** One line per input for the concat demuxer, with safe single-quote escaping. */
export function concatListContent(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** Concat the (already-normalized) clips with a stream copy — fast, lossless. */
export function buildConcatArgs(listFile: string, output: string): string[] {
  return ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', output]
}

/* -------------------------------- runners -------------------------------- */

export interface CombineDeps {
  ffmpeg: string
  ffprobe: string | null
  onNote: (note: string) => void
  onStep: (done: number, total: number, label: string) => void
  registerChild: (c: ChildProcess | null) => void
  shouldCancel: () => boolean
  rng?: () => number
}

function runProc(
  cmd: string,
  args: string[],
  register: (c: ChildProcess | null) => void
): Promise<{ ok: boolean; cancelled: boolean; stdout: string; stderrTail: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (err) {
      resolve({ ok: false, cancelled: false, stdout: '', stderrTail: String(err) })
      return
    }
    register(child)
    let stdout = ''
    let stderrTail = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderrTail = (stderrTail + d.toString()).slice(-4000)))
    child.on('error', (err) => {
      register(null)
      resolve({ ok: false, cancelled: false, stdout, stderrTail: stderrTail + '\n' + String(err) })
    })
    child.on('close', (code) => {
      const cancelled = child.killed
      register(null)
      resolve({ ok: code === 0, cancelled, stdout, stderrTail })
    })
  })
}

async function probeHasAudio(ffprobe: string, file: string, register: (c: ChildProcess | null) => void): Promise<boolean> {
  const r = await runProc(ffprobe, buildProbeAudioArgs(file), register)
  // On any probe failure, assume audio is present (the normal case) and let the
  // normalize step map 0:a:0 — safer than wrongly synthesizing silence.
  if (!r.ok && !r.stdout.trim()) return true
  return r.stdout.trim().length > 0
}

/**
 * Shuffle → normalize each clip → concat. Returns the final path. Any clip that
 * fails to normalize is skipped (with a note) rather than aborting the movie.
 */
export async function combineClips(
  files: string[],
  outPath: string,
  tmpDir: string,
  canvas: { w: number; h: number },
  deps: CombineDeps
): Promise<{ ok: boolean; outPath?: string; used?: number; total?: number; error?: string; cancelled?: boolean }> {
  const inputs = files.filter((f) => existsSync(f))
  if (inputs.length < 2) return { ok: false, error: 'Need at least 2 downloaded clips to combine into a movie.' }

  mkdirSync(tmpDir, { recursive: true })
  const order = shuffle(inputs, deps.rng ?? Math.random)
  const normalized: string[] = []

  try {
    for (let i = 0; i < order.length; i++) {
      if (deps.shouldCancel()) return { ok: false, cancelled: true }
      const f = order[i]
      deps.onStep(i, order.length, `Preparing clip ${i + 1} of ${order.length}: ${basename(f)}`)
      const hasAudio = deps.ffprobe ? await probeHasAudio(deps.ffprobe, f, deps.registerChild) : true
      const outp = join(tmpDir, `norm_${String(i + 1).padStart(4, '0')}.mp4`)
      const r = await runProc(deps.ffmpeg, buildNormalizeArgs(f, outp, canvas, hasAudio), deps.registerChild)
      if (r.cancelled) return { ok: false, cancelled: true }
      if (r.ok && existsSync(outp)) normalized.push(outp)
      else deps.onNote(`Skipped a clip that couldn't be prepared: ${basename(f)}`)
    }

    if (normalized.length < 2) return { ok: false, error: 'Could not prepare enough clips to combine (they may be unreadable).' }
    if (deps.shouldCancel()) return { ok: false, cancelled: true }

    deps.onStep(order.length, order.length, `Stitching ${normalized.length} clips into the final video…`)
    const listFile = join(tmpDir, 'concat.txt')
    writeFileSync(listFile, concatListContent(normalized))
    const r = await runProc(deps.ffmpeg, buildConcatArgs(listFile, outPath), deps.registerChild)
    if (r.cancelled) return { ok: false, cancelled: true }
    if (!r.ok || !existsSync(outPath)) {
      const tail = r.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400)
      return { ok: false, error: tail || 'ffmpeg could not stitch the clips.' }
    }
    return { ok: true, outPath, used: normalized.length, total: order.length }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * The session render: normalise each clip to a 1920×1080 segment, concat
 * (video copied), mix voice + music at the chosen dB → MP4. Pure ffmpeg; the
 * argument builders live in lib/render-plan.ts and are tested headless.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Clip, RenderPrefs } from '../types'
import { concatList, finalArgs, segmentArgs, type PlanClip } from '../lib/render-plan'
import { probeMedia, runFfmpeg } from './ffmpeg'

export interface RenderProgress {
  phase: 'clips' | 'mixing'
  progress: number
  clipIndex: number
  message: string
}

export interface RenderInput {
  clips: Clip[]
  prefs: RenderPrefs
  outFile: string
  workDir: string
  signal: AbortSignal
  onProgress: (p: RenderProgress) => void
}

export async function renderSession(o: RenderInput): Promise<{ durationSec: number; bytes: number }> {
  rmSync(o.workDir, { recursive: true, force: true })
  mkdirSync(o.workDir, { recursive: true })
  try {
    // plan: the measured recording time is the truth (a probe can over-report
    // when one stream runs long); the file's own audio decides silence padding
    const plan: PlanClip[] = []
    for (const c of o.clips) {
      if (!existsSync(c.file)) throw new Error(`Clip ${c.n} is missing on disk (${c.file})`)
      const p = await probeMedia(c.file)
      if (!p.hasVideo) throw new Error(`Clip ${c.n} has no video`)
      const durationSec = c.durationMs > 200 ? c.durationMs / 1000 : (p.durationSec ?? 0)
      if (!(durationSec > 0)) throw new Error(`Clip ${c.n} has no length`)
      plan.push({ file: c.file, durationSec, hasAudio: p.hasAudio, crop: c.crop })
    }
    const total = plan.reduce((a, c) => a + c.durationSec, 0)
    const CLIP_SHARE = 0.94
    let done = 0
    const segs: string[] = []
    for (let i = 0; i < plan.length; i++) {
      if (o.signal.aborted) throw new Error('Cancelled')
      const c = plan[i]
      const name = `seg-${String(i + 1).padStart(3, '0')}.mkv`
      o.onProgress({ phase: 'clips', progress: (CLIP_SHARE * done) / total, clipIndex: i, message: `Processing clip ${i + 1} of ${plan.length}` })
      await runFfmpeg(segmentArgs(c, { fps: o.prefs.fps, fit: o.prefs.fit, quality: o.prefs.quality }, join(o.workDir, name)), {
        signal: o.signal,
        totalSec: c.durationSec,
        onProgress: (f) => o.onProgress({ phase: 'clips', progress: (CLIP_SHARE * (done + f * c.durationSec)) / total, clipIndex: i, message: `Processing clip ${i + 1} of ${plan.length}` })
      })
      done += c.durationSec
      segs.push(name)
    }
    const list = join(o.workDir, 'list.txt')
    writeFileSync(list, concatList(segs), 'utf8')
    const music =
      o.prefs.musicPath && existsSync(o.prefs.musicPath)
        ? { path: o.prefs.musicPath, db: o.prefs.musicDb, loop: o.prefs.musicLoop, fade: o.prefs.musicFade, duck: o.prefs.musicDuck }
        : null
    if (o.prefs.musicPath && !music) throw new Error(`The music file is missing: ${o.prefs.musicPath}`)
    const tmpOut = join(o.workDir, 'final.mp4')
    o.onProgress({ phase: 'mixing', progress: CLIP_SHARE, clipIndex: plan.length - 1, message: music ? 'Joining clips and mixing the music' : 'Joining clips' })
    await runFfmpeg(finalArgs(list, total, o.prefs.voiceDb, music, tmpOut), {
      signal: o.signal,
      totalSec: total,
      onProgress: (f) => o.onProgress({ phase: 'mixing', progress: CLIP_SHARE + (1 - CLIP_SHARE) * f, clipIndex: plan.length - 1, message: music ? 'Joining clips and mixing the music' : 'Joining clips' })
    })
    try {
      renameSync(tmpOut, o.outFile)
    } catch {
      // different drive — copy then remove
      copyFileSync(tmpOut, o.outFile)
      try {
        unlinkSync(tmpOut)
      } catch {
        /* cleaned with the work dir */
      }
    }
    return { durationSec: total, bytes: statSync(o.outFile).size }
  } finally {
    try {
      rmSync(o.workDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * "Fix missing song info" — the per-job queue and the review list (main only).
 *
 * Every finished audio file goes through TagFixer one at a time (MusicBrainz
 * allows one request a second): read its tags → decide trusted/complete →
 * look it up → on a confident match fill the missing/wrong fields (+ genre)
 * and, if chosen, swap in the official album cover. Then `onReady` hands it on
 * (to the Google Drive uploader, or nowhere for a local download).
 *
 * A song with missing info and no confident match is HELD: it goes on the
 * ReviewStore list (review.json) for the user to fill in or save as is, and
 * is not uploaded until they do. If MusicBrainz can't be reached at all, the
 * song is passed on unchanged (counted as skipped) rather than held — an
 * outage shouldn't park a whole playlist.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, resolve } from 'path'
import { assessTags, mergeMatch, tagsEqual, type ReviewItem, type SongCandidate, type SongTags, type TagSummary } from '../lib/songinfo'
import { MbUnavailable } from './musicbrainz'
import type { Art, ProbedSong } from './tagio'

export interface TagFixDeps {
  probe: (path: string) => Promise<ProbedSong>
  find: (q: { title: string; artist: string }, durationMs: number | null) => Promise<SongCandidate | null>
  genre: (releaseGroupId: string) => Promise<string>
  cover: (releaseId: string, releaseGroupId: string) => Promise<Art | null>
  write: (path: string, probed: ProbedSong, tags: SongTags, art: Art | null) => Promise<void>
}

export interface ReadyInfo {
  tags: SongTags
  /** as downloaded, before any fix */
  original: SongTags
  recordingId?: string
  durationMs: number | null
}

export interface TagFixOpts {
  officialArt: boolean
  isHeld: (path: string) => boolean
  hold: (path: string, info: Pick<ReviewItem, 'current' | 'guess' | 'hasArt' | 'durationMs'>) => void
  /** the song is done (fixed, complete, skipped) — pass it on, with its final tags when known */
  onReady: (path: string, info?: ReadyInfo) => void
  onProgress: (s: TagSummary) => void
  /** persisted list of handled paths, so a resumed job doesn't redo them */
  processedFile?: string
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

export class TagFixer {
  private queue: string[] = []
  private seen = new Set<string>()
  private done = new Set<string>()
  private running = false
  private idle: (() => void)[] = []
  private aborted = false
  private s: TagSummary = { fixed: 0, complete: 0, needsInfo: 0, skipped: 0, pending: 0, current: null }

  constructor(
    private deps: TagFixDeps,
    private opts: TagFixOpts
  ) {
    if (opts.processedFile && existsSync(opts.processedFile))
      for (const l of readFileSync(opts.processedFile, 'utf8').split(/\r?\n/)) if (l.trim()) this.done.add(l.trim())
  }

  summary(): TagSummary {
    return { ...this.s, pending: this.queue.length + (this.s.current ? 1 : 0) }
  }

  add(path: string): void {
    if (this.aborted || this.seen.has(path) || !existsSync(path)) return
    this.seen.add(path)
    if (this.opts.isHeld(path)) return // already waiting for the user
    if (this.done.has(path)) {
      // handled before a crash/quit — just pass it on again
      this.opts.onReady(path)
      return
    }
    this.queue.push(path)
    this.emit()
    void this.pump()
  }

  drain(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve()
    return new Promise((r) => this.idle.push(r))
  }

  abort(): void {
    this.aborted = true
    this.queue = []
    this.flush()
  }

  private emit(): void {
    this.opts.onProgress(this.summary())
  }

  private flush(): void {
    const w = this.idle
    this.idle = []
    for (const r of w) r()
  }

  private markDone(path: string): void {
    this.done.add(path)
    if (this.opts.processedFile)
      try {
        mkdirSync(dirname(this.opts.processedFile), { recursive: true })
        appendFileSync(this.opts.processedFile, path + '\n')
      } catch {
        /* resume just redoes it */
      }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.aborted) {
        const p = this.queue.shift()!
        this.s.current = basename(p)
        this.emit()
        await this.fixOne(p)
        this.s.current = null
      }
    } finally {
      this.running = false
      this.s.current = null
      if (!this.aborted) this.emit()
      this.flush()
    }
  }

  private async fixOne(path: string): Promise<void> {
    if (!existsSync(path)) return
    let probed: ProbedSong
    try {
      probed = await this.deps.probe(path)
    } catch (err) {
      this.s.skipped++
      this.s.note = err instanceof Error ? err.message : String(err)
      this.markDone(path)
      this.opts.onReady(path)
      return
    }
    const a = assessTags(probed.tags)
    const asIs: ReadyInfo = { tags: probed.tags, original: probed.tags, durationMs: probed.durationMs }
    if (a.complete && !this.opts.officialArt) {
      this.s.complete++
      this.markDone(path)
      this.opts.onReady(path, asIs)
      return
    }

    let best: SongCandidate | null
    try {
      best = await this.deps.find(a.query, probed.durationMs)
    } catch (err) {
      // MusicBrainz down / offline: don't hold the song hostage
      this.s.skipped++
      this.s.note = err instanceof MbUnavailable ? err.message : `Lookup failed: ${err instanceof Error ? err.message : String(err)}`
      this.opts.onReady(path, asIs) // not marked done — a resume tries again
      return
    }
    if (this.aborted) return

    if (!best) {
      this.markDone(path)
      if (a.complete) {
        this.s.complete++
        this.opts.onReady(path, asIs)
      } else {
        this.s.needsInfo++
        this.opts.hold(path, { current: probed.tags, guess: a.guess, hasArt: probed.hasArt, durationMs: probed.durationMs })
      }
      return
    }

    let next = mergeMatch(probed.tags, best, a.trusted)
    if (!next.genre && best.releaseGroupId)
      try {
        const g = await this.deps.genre(best.releaseGroupId)
        if (g) next = { ...next, genre: g }
      } catch {
        /* genre is a nice-to-have */
      }
    let art: Art | null = null
    if (this.opts.officialArt)
      try {
        art = await this.deps.cover(best.releaseId, best.releaseGroupId)
      } catch {
        /* keep YouTube's cover */
      }
    if (this.aborted) return
    let final = next
    if (!art && tagsEqual(probed.tags, next)) this.s.complete++
    else
      try {
        await this.deps.write(path, probed, next, art)
        this.s.fixed++
      } catch (err) {
        this.s.skipped++
        this.s.note = err instanceof Error ? err.message : String(err)
        final = probed.tags
      }
    this.markDone(path)
    this.opts.onReady(path, { tags: final, original: probed.tags, recordingId: best.recordingId, durationMs: probed.durationMs })
  }
}

/* ------------------------------ review list ------------------------------ */

export class ReviewStore {
  private items: ReviewItem[] = []

  constructor(
    private file: string,
    private onChange: (items: ReviewItem[]) => void
  ) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { items?: ReviewItem[] }
      this.items = Array.isArray(j.items) ? j.items : []
    } catch {
      this.items = []
    }
  }

  list(): ReviewItem[] {
    return this.items.map((i) => ({ ...i, missing: !existsSync(i.path) }))
  }

  get(id: string): ReviewItem | undefined {
    return this.items.find((i) => i.id === id)
  }

  forJob(jobId: string): ReviewItem[] {
    return this.items.filter((i) => i.jobId === jobId)
  }

  isHeld(path: string): boolean {
    return this.items.some((i) => samePath(i.path, path))
  }

  add(item: Omit<ReviewItem, 'id' | 'createdAt'>): ReviewItem {
    const existing = this.items.find((i) => samePath(i.path, item.path))
    if (existing) return existing
    const full: ReviewItem = { ...item, id: randomUUID(), createdAt: Date.now() }
    this.items.push(full)
    this.save()
    return full
  }

  update(id: string, patch: Partial<ReviewItem>): void {
    const i = this.items.findIndex((x) => x.id === id)
    if (i < 0) return
    this.items[i] = { ...this.items[i], ...patch }
    this.save()
  }

  remove(id: string): void {
    const n = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    if (this.items.length !== n) this.save()
  }

  removeJob(jobId: string): void {
    const n = this.items.length
    this.items = this.items.filter((i) => i.jobId !== jobId)
    if (this.items.length !== n) this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      /* best-effort; the in-memory list still works this session */
    }
    this.onChange(this.list())
  }
}

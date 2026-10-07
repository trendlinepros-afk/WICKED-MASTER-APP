/**
 * The list of every song this module has downloaded (main only) — so a song
 * that's already been downloaded (from any playlist, to this PC or to Google
 * Drive) is never downloaded again.
 *
 *  - Keyed by YouTube video id (in every audio file name: "… [<id>].mp3"). The
 *    ids become a yt-dlp --download-archive file for each job, so known songs are
 *    skipped BEFORE anything is downloaded.
 *  - The same song under a different video (official audio vs lyric video, a
 *    re-upload) is caught after its tags are known: same MusicBrainz recording,
 *    or same title + main artist + length within 3 s. The extra video id is kept
 *    as an alias so the next playlist skips it up front too.
 *  - Each entry keeps the name it was downloaded as AND the name it was saved as
 *    (after "Fix missing song info" or a manual edit), so renamed songs still
 *    count as the same song.
 *
 * Travelling between PCs: the list lives in the module data folder, so it's in
 * every Backup and Cloud Sync snapshot. Those replace the whole file, so the
 * list is MERGEABLE instead: every song has `updatedAt`, removals leave a dated
 * tombstone (`forgotten`), and `mergeDocs` unions two copies (newest wins per
 * song; a removal beats anything older). A machine-local twin
 * (`*.local.json`, never backed up) is merged back in on load, so a restore or
 * sync pull from another PC never wipes this PC's downloads. The same doc is
 * also shared live through Google Drive (see ipc.ts).
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { cleanTitle, normalize, searchTitle } from '../lib/songinfo'

export interface LibrarySong {
  videoId: string
  /** other video ids found to be this same song */
  aliases: string[]
  title: string
  artist: string
  album: string
  /** as it was downloaded (YouTube's title/artist) */
  originalTitle: string
  originalArtist: string
  recordingId: string
  durationMs: number | null
  fileName: string
  /** 'pending' = downloaded, not finished yet (uploading, or waiting for song info) */
  location: 'local' | 'drive' | 'pending'
  path: string
  driveFileId: string
  playlist: string
  jobId: string
  downloadedAt: number
  /** when its title/artist were changed from the original (0 = never) */
  renamedAt: number
  /** last change to this entry — newest wins when two PCs' lists merge */
  updatedAt: number
}

/** What's stored (and shared between PCs). */
export interface ListDoc {
  version: 2
  songs: LibrarySong[]
  /** removed video ids → when (a removal wins over anything older) */
  forgotten: Record<string, number>
}

const TOMBSTONE_KEEP_MS = 400 * 24 * 3600 * 1000

/** Union of two lists: newest entry per song wins, aliases are combined, removals win over older entries. */
export function mergeDocs(a: ListDoc, b: ListDoc): ListDoc {
  const songs = new Map<string, LibrarySong>()
  for (const s of [...(a.songs ?? []), ...(b.songs ?? [])]) {
    if (!s?.videoId) continue
    const prev = songs.get(s.videoId)
    const aliases = [...new Set([...(prev?.aliases ?? []), ...(Array.isArray(s.aliases) ? s.aliases : [])])]
    if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) songs.set(s.videoId, { ...s, aliases })
    else prev.aliases = aliases
  }
  const forgotten: Record<string, number> = {}
  const cutoff = Date.now() - TOMBSTONE_KEEP_MS
  for (const src of [a.forgotten ?? {}, b.forgotten ?? {}])
    for (const [id, at] of Object.entries(src)) if (at > cutoff) forgotten[id] = Math.max(forgotten[id] ?? 0, at)
  for (const [id, at] of Object.entries(forgotten)) {
    const s = songs.get(id)
    if (s && (s.updatedAt || 0) <= at) songs.delete(id)
  }
  return { version: 2, songs: [...songs.values()], forgotten }
}

/** Stable fingerprint of a doc (to tell whether two copies differ). */
export function docSignature(d: ListDoc): string {
  const h = createHash('sha1')
  for (const s of [...(d.songs ?? [])].sort((x, y) => x.videoId.localeCompare(y.videoId))) h.update(`${s.videoId}:${s.updatedAt || 0}:${[...(s.aliases ?? [])].sort().join(',')};`)
  for (const [id, at] of Object.entries(d.forgotten ?? {}).sort()) h.update(`-${id}:${at};`)
  return h.digest('hex')
}

export function readDoc(file: string): ListDoc | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<ListDoc>
    // v1 (no updatedAt / tombstones) reads fine: missing fields default
    return { version: 2, songs: Array.isArray(j.songs) ? j.songs.map((s) => ({ ...s, updatedAt: s.updatedAt || s.downloadedAt || 0, aliases: Array.isArray(s.aliases) ? s.aliases : [] })) : [], forgotten: j.forgotten && typeof j.forgotten === 'object' ? j.forgotten : {} }
  } catch {
    return null
  }
}

export const AUDIO_EXT = new Set(['.mp3', '.m4a', '.opus', '.ogg', '.oga', '.webm', '.flac', '.wav', '.aac'])

/** YouTube video id from a downloaded file name ("… [dQw4w9WgXcQ].mp3"). */
export const videoIdOf = (fileName: string): string => /\[([0-9A-Za-z_-]{11})\]\.[A-Za-z0-9]+$/.exec(fileName)?.[1] ?? ''

/** "0003 - Artist - Title [id].mp3" / "Artist - Title [id].mp3" → artist + title. */
export function parseSongFileName(fileName: string): { artist: string; title: string } {
  const stem = basename(fileName, extname(fileName))
    .replace(/\s*\[[0-9A-Za-z_-]{11}\]$/, '')
    .replace(/^\d{2,4}\s+-\s+/, '')
  const m = /^(.+?)\s+-\s+(.+)$/.exec(stem)
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: stem.trim() }
}

const primaryArtist = (a: string): string => normalize((a.split(/\s+(?:feat\.?|ft\.?|featuring|x|&|and|with|vs\.?)\s+|[,;/]/i)[0] ?? '').trim())
export const songKey = (title: string, artist: string): string => {
  const t = normalize(searchTitle(cleanTitle(title)))
  const a = primaryArtist(artist)
  return t && a ? `${t}|${a}` : ''
}

export class SongLibrary {
  private songs = new Map<string, LibrarySong>()
  private alias = new Map<string, string>()
  private forgotten: Record<string, number> = {}
  private timer: ReturnType<typeof setTimeout> | null = null
  /** true when there was no list on disk yet (first run → scan existing downloads) */
  readonly fresh: boolean
  /** this PC's own copy — never backed up or synced, so a restore can't overwrite it */
  private localFile: string

  constructor(
    private file: string,
    private onChange: (total: number) => void
  ) {
    this.localFile = file.replace(/\.json$/, '') + '.local.json'
    this.fresh = !existsSync(file) && !existsSync(this.localFile)
    const main = readDoc(file)
    const local = readDoc(this.localFile)
    const doc = main && local ? mergeDocs(main, local) : (main ?? local ?? { version: 2 as const, songs: [], forgotten: {} })
    this.load(doc)
    // a restore/pull replaced the list with another PC's copy → our downloads were merged back in; save that
    if (main && local && docSignature(doc) !== docSignature(main)) this.flush()
  }

  private load(doc: ListDoc): void {
    this.songs.clear()
    this.alias.clear()
    this.forgotten = { ...doc.forgotten }
    for (const s of doc.songs) if (s?.videoId) this.put({ ...s, aliases: Array.isArray(s.aliases) ? s.aliases : [] })
  }

  toDoc(): ListDoc {
    return { version: 2, songs: [...this.songs.values()], forgotten: { ...this.forgotten } }
  }

  signature(): string {
    return docSignature(this.toDoc())
  }

  /** Merge another PC's copy in. True if this list changed. */
  mergeIn(other: ListDoc): boolean {
    const before = this.signature()
    const merged = mergeDocs(this.toDoc(), other)
    if (docSignature(merged) === before) return false
    this.load(merged)
    this.changed()
    return true
  }

  get size(): number {
    return this.songs.size
  }

  private put(s: LibrarySong): void {
    this.songs.set(s.videoId, s)
    for (const a of s.aliases) this.alias.set(a, s.videoId)
  }

  /** removed from the list on purpose (here or on another PC) */
  isForgotten(videoId: string): boolean {
    return !!this.forgotten[videoId] && !this.has(videoId)
  }

  has(videoId: string): boolean {
    return this.songs.has(videoId) || this.alias.has(videoId)
  }

  get(videoId: string): LibrarySong | undefined {
    return this.songs.get(videoId) ?? this.songs.get(this.alias.get(videoId) ?? '')
  }

  /** Another entry that is the same song (not `videoId` itself), or null. */
  findSame(t: { title: string; artist: string; recordingId?: string; durationMs: number | null }, videoId: string): LibrarySong | null {
    const key = songKey(t.title, t.artist)
    for (const s of this.songs.values()) {
      if (s.videoId === videoId || s.aliases.includes(videoId)) continue
      if (t.recordingId && s.recordingId && t.recordingId === s.recordingId) return s
      if (!key || !t.durationMs || !s.durationMs || Math.abs(t.durationMs - s.durationMs) > 3000) continue
      if (songKey(s.title, s.artist) === key || songKey(s.originalTitle, s.originalArtist) === key) return s
    }
    return null
  }

  /** Add or update a song (aliases and the first download time are kept). */
  record(s: Omit<LibrarySong, 'aliases' | 'renamedAt' | 'updatedAt'> & { aliases?: string[]; renamedAt?: number; updatedAt?: number }): LibrarySong {
    const prev = this.songs.get(s.videoId)
    const next: LibrarySong = {
      ...s,
      aliases: [...new Set([...(prev?.aliases ?? []), ...(s.aliases ?? [])])],
      downloadedAt: prev?.downloadedAt ?? s.downloadedAt,
      // the first real download's name wins; a scan entry (no jobId) only guessed it from the file name
      originalTitle: (prev?.jobId ? prev.originalTitle : '') || s.originalTitle,
      originalArtist: (prev?.jobId ? prev.originalArtist : '') || s.originalArtist,
      renamedAt: s.renamedAt ?? prev?.renamedAt ?? 0,
      updatedAt: Date.now()
    }
    delete this.forgotten[s.videoId]
    if (next.originalTitle && (normalize(next.title) !== normalize(next.originalTitle) || normalize(next.artist) !== normalize(next.originalArtist)) && !next.renamedAt)
      next.renamedAt = Date.now()
    this.put(next)
    this.changed()
    return next
  }

  update(videoId: string, patch: Partial<LibrarySong>): void {
    const s = this.get(videoId)
    if (!s) return
    this.record({ ...s, ...patch, videoId: s.videoId })
  }

  addAlias(videoId: string, aliasId: string): void {
    const s = this.get(videoId)
    if (!s || !aliasId || s.videoId === aliasId || s.aliases.includes(aliasId)) return
    s.aliases.push(aliasId)
    s.updatedAt = Date.now()
    this.alias.set(aliasId, s.videoId)
    this.changed()
  }

  /** Remove songs (by video id or alias) so they can be downloaded again. */
  forget(ids: string[]): number {
    let n = 0
    for (const id of ids) {
      const s = this.get(id)
      if (!s) continue
      this.songs.delete(s.videoId)
      const now = Date.now()
      this.forgotten[s.videoId] = now // so the removal reaches your other PCs too
      for (const a of s.aliases) this.alias.delete(a)
      n++
    }
    if (n) this.changed()
    return n
  }

  forgetAll(): number {
    const n = this.songs.size
    const now = Date.now()
    for (const id of this.songs.keys()) this.forgotten[id] = now
    this.songs.clear()
    this.alias.clear()
    if (n) this.changed()
    return n
  }

  /** Newest first; `query` matches title, artist, album, original name, playlist, file. */
  list(query = '', limit = 200, offset = 0): { total: number; matched: number; items: LibrarySong[] } {
    const q = normalize(query)
    const all = [...this.songs.values()].sort((a, b) => b.downloadedAt - a.downloadedAt)
    const hits = q ? all.filter((s) => normalize([s.title, s.artist, s.album, s.originalTitle, s.originalArtist, s.playlist, s.fileName].join(' ')).includes(q)) : all
    return { total: all.length, matched: hits.length, items: hits.slice(offset, offset + limit) }
  }

  /** yt-dlp --download-archive lines for every known video id. */
  archiveLines(): string[] {
    const out: string[] = []
    for (const s of this.songs.values()) {
      out.push(`youtube ${s.videoId}`)
      for (const a of s.aliases) out.push(`youtube ${a}`)
    }
    return out
  }

  private changed(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
    this.onChange(this.songs.size)
  }

  /** Write now (pending changes are otherwise written ~0.4 s later). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const text = JSON.stringify(this.toDoc())
    for (const f of [this.file, this.localFile])
      try {
        mkdirSync(dirname(f), { recursive: true })
        const tmp = `${f}.tmp`
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, f)
      } catch {
        /* next change retries */
      }
  }
}

/** Every audio file with a video id under `dir` (recursive). */
export function findDownloadedSongs(dir: string): { path: string; fileName: string; videoId: string }[] {
  const out: { path: string; fileName: string; videoId: string }[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 6) return
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1)
        else if (AUDIO_EXT.has(extname(n).toLowerCase())) {
          const id = videoIdOf(n)
          if (id) out.push({ path: p, fileName: n, videoId: id })
        }
      } catch {
        /* vanished */
      }
    }
  }
  walk(dir, 0)
  return out
}

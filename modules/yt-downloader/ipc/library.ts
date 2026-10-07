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
 */
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
  private timer: ReturnType<typeof setTimeout> | null = null
  /** true when there was no list on disk yet (first run → scan existing downloads) */
  readonly fresh: boolean

  constructor(
    private file: string,
    private onChange: (total: number) => void
  ) {
    this.fresh = !existsSync(file)
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { songs?: LibrarySong[] }
      for (const s of j.songs ?? []) if (s?.videoId) this.put({ ...s, aliases: Array.isArray(s.aliases) ? s.aliases : [] })
    } catch {
      /* empty list */
    }
  }

  get size(): number {
    return this.songs.size
  }

  private put(s: LibrarySong): void {
    this.songs.set(s.videoId, s)
    for (const a of s.aliases) this.alias.set(a, s.videoId)
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
  record(s: Omit<LibrarySong, 'aliases' | 'renamedAt'> & { aliases?: string[]; renamedAt?: number }): LibrarySong {
    const prev = this.songs.get(s.videoId)
    const next: LibrarySong = {
      ...s,
      aliases: [...new Set([...(prev?.aliases ?? []), ...(s.aliases ?? [])])],
      downloadedAt: prev?.downloadedAt ?? s.downloadedAt,
      // the first real download's name wins; a scan entry (no jobId) only guessed it from the file name
      originalTitle: (prev?.jobId ? prev.originalTitle : '') || s.originalTitle,
      originalArtist: (prev?.jobId ? prev.originalArtist : '') || s.originalArtist,
      renamedAt: s.renamedAt ?? prev?.renamedAt ?? 0
    }
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
      for (const a of s.aliases) this.alias.delete(a)
      n++
    }
    if (n) this.changed()
    return n
  }

  forgetAll(): number {
    const n = this.songs.size
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
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ songs: [...this.songs.values()] }), 'utf8')
      renameSync(tmp, this.file)
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

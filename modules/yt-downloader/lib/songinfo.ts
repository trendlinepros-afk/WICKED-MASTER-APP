/**
 * Song info ("tags") — types and pure helpers shared by main and the renderer.
 *
 * YouTube Music tracks usually arrive with clean title/artist/album; regular
 * uploads arrive as "Artist - Song (Official Video)" by "ArtistVEVO" with the
 * upload date as the date. `assessTags` decides which case a file is (trusted
 * or not), whether it's complete, and what to search MusicBrainz for;
 * `mergeMatch` fills a file's tags from a confident match.
 */

export interface SongTags {
  title: string
  artist: string
  album: string
  albumArtist: string
  /** 'YYYY' or 'YYYY-MM-DD' */
  date: string
  /** '3' or '3/12' */
  track: string
  genre: string
}

export const TAG_FIELDS: { key: keyof SongTags; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Song title' },
  { key: 'artist', label: 'Artist', placeholder: 'Artist (e.g. "A feat. B")' },
  { key: 'album', label: 'Album', placeholder: 'Album or single name' },
  { key: 'albumArtist', label: 'Album artist', placeholder: 'Usually the main artist' },
  { key: 'date', label: 'Release date', placeholder: 'YYYY or YYYY-MM-DD' },
  { key: 'track', label: 'Track #', placeholder: '3 or 3/12' },
  { key: 'genre', label: 'Genre', placeholder: 'e.g. Hip Hop' }
]

export const emptyTags = (): SongTags => ({ title: '', artist: '', album: '', albumArtist: '', date: '', track: '', genre: '' })

/** A MusicBrainz match offered for a song. */
export interface SongCandidate extends SongTags {
  recordingId: string
  releaseId: string
  releaseGroupId: string
  durationMs: number | null
  /** 0–1: how well it matches what was searched for */
  confidence: number
  /** e.g. "Album · 2010 · US" */
  releaseLabel: string
}

/** Running totals for one download job's "Fix missing song info" step. */
export interface TagSummary {
  fixed: number
  complete: number
  needsInfo: number
  skipped: number
  /** waiting + in progress */
  pending: number
  current: string | null
  /** e.g. why songs were skipped */
  note?: string
}

/** A song MusicBrainz couldn't identify, waiting for the user. */
export interface ReviewItem {
  id: string
  jobId: string
  jobTitle: string
  path: string
  fileName: string
  /** upload to Google Drive once saved (it's held in the job's staging folder) */
  toDrive: boolean
  createdAt: number
  current: SongTags
  /** cleaned-up best guesses to prefill the form */
  guess: SongTags
  hasArt: boolean
  durationMs: number | null
  error?: string
  /** the file is gone (moved/deleted outside the app) */
  missing?: boolean
}

export type ArtChoice = { kind: 'keep' } | { kind: 'release'; releaseId: string; releaseGroupId: string } | { kind: 'file'; path: string }

/* ------------------------------- cleaning -------------------------------- */

const NOISE_WORDS =
  'official\\s*(?:music\\s*|lyrics?\\s*|hd\\s*|4k\\s*)?(?:video|audio|visuali[sz]er|clip)|music\\s*video|lyrics?(?:\\s*video)?|audio(?:\\s*only)?|visuali[sz]er|video\\s*oficial|videoclip|m/?v|hd|hq|4k|8k|1080p|720p|explicit|clean(?:\\s*version)?|remaster(?:ed)?(?:\\s*\\d{4})?|\\d{4}\\s*remaster(?:ed)?|full\\s*album|out\\s*now|free\\s*download|official'
/** "(Official Video)", "[4K]", "{Lyrics}" … */
const NOISE_BRACKETS = new RegExp(`\\s*[([{]\\s*(?:${NOISE_WORDS})\\s*[)\\]}]`, 'gi')
/** same, without the g flag — RegExp.test on a /g regex keeps state between calls */
const NOISE_BRACKETS_ONE = new RegExp(NOISE_BRACKETS.source, 'i')
/** trailing " - Official Video" / " | Lyrics" without brackets */
const NOISE_TAIL = new RegExp(`\\s*[-|–—]\\s*(?:${NOISE_WORDS})\\s*$`, 'i')
const FEAT = /\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i

export function cleanTitle(title: string): string {
  let t = title.replace(NOISE_BRACKETS, '')
  for (let i = 0; i < 3 && NOISE_TAIL.test(t); i++) t = t.replace(NOISE_TAIL, '')
  return t.replace(/\s{2,}/g, ' ').replace(/^[\s\-|–—]+|[\s\-|–—]+$/g, '').trim()
}

/** "Artist - Song" → {artist, title} (first dash-like separator only). */
export function splitArtistTitle(title: string): { artist: string; title: string } | null {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title.trim())
  if (!m) return null
  const artist = m[1].trim()
  const t = m[2].trim()
  return artist && t ? { artist, title: t } : null
}

export function isJunkyTitle(title: string): boolean {
  return NOISE_BRACKETS_ONE.test(title) || NOISE_TAIL.test(title)
}

/** A YouTube channel name rather than an artist name. */
export function isChannelArtist(artist: string): boolean {
  return /vevo$/i.test(artist) || /\s-\s*topic$/i.test(artist) || /\bofficial(?:\s+(?:channel|music))?$/i.test(artist) || /\b(?:records?|recordings|entertainment)$/i.test(artist)
}

export function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s*\bofficial(?:\s+(?:channel|music))?$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // "TaylorSwift" (from TaylorSwiftVEVO) → "Taylor Swift"
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Title without "(feat. X)" — for searching only. */
export const searchTitle = (title: string): string => title.replace(FEAT, '').trim()

/* ------------------------------ comparison ------------------------------- */

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 0–1: identical 1, one inside the other 0.9, else bigram Dice. */
export function similarity(a: string, b: string): number {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if ((x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))) return 0.9
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    const t = s.replace(/ /g, '')
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let inter = 0
  let total = 0
  for (const [g, n] of gx) {
    inter += Math.min(n, gy.get(g) ?? 0)
    total += n
  }
  for (const n of gy.values()) total += n
  return total ? (2 * inter) / total : 0
}

export const yearOf = (date: string): string => /^(\d{4})/.exec(date.trim())?.[1] ?? ''

/** "20190312" (yt-dlp's upload date) → "2019-03-12"; anything else as is. */
export function normalizeDate(date: string): string {
  const d = date.trim()
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d
}

export function tagsEqual(a: SongTags, b: SongTags): boolean {
  return TAG_FIELDS.every(({ key }) => (a[key] ?? '').trim() === (b[key] ?? '').trim())
}

/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' with a real month/day. */
export function validDate(d: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(d)
  if (!m) return false
  const mo = m[2] ? Number(m[2]) : 1
  const day = m[3] ? Number(m[3]) : 1
  return Number(m[1]) >= 1000 && mo >= 1 && mo <= 12 && day >= 1 && day <= 31
}

/** Trim + validate what a user (or Claude) typed before it's written to a file. */
export function sanitizeTags(t: Partial<SongTags>): SongTags {
  const s = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/[\r\n\0]+/g, ' ').trim().slice(0, max) : '')
  const date = s(t.date, 10)
  const track = s(t.track, 7)
  return {
    title: s(t.title),
    artist: s(t.artist),
    album: s(t.album),
    albumArtist: s(t.albumArtist),
    date: validDate(date) ? date : '',
    track: /^\d{1,3}(\/\d{1,3})?$/.test(track) ? track : '',
    genre: s(t.genre, 80)
  }
}

/* ------------------------------- decisions -------------------------------- */

export interface Assessment {
  /** tags look like proper music metadata (YouTube Music style), not a video upload */
  trusted: boolean
  /** title, artist, album and a year are all there and trusted */
  complete: boolean
  query: { title: string; artist: string }
  /** what to prefill if the user has to fill it in */
  guess: SongTags
}

export function assessTags(cur: SongTags): Assessment {
  const rawTitle = cur.title.trim()
  const rawArtist = cur.artist.trim()
  const junk = isJunkyTitle(rawTitle)
  const cleaned = cleanTitle(rawTitle)
  const split = splitArtistTitle(cleaned)
  const channel = !rawArtist || isChannelArtist(rawArtist)
  const artistClean = cleanArtist(rawArtist)

  let title = cleaned
  let artist = artistClean
  // "Artist - Song" in the title wins when the artist tag is a channel / missing
  // or names the same artist
  if (split && (channel || !artistClean || similarity(split.artist, artistClean) >= 0.6)) {
    title = split.title
    artist = split.artist
  }
  const trusted = !junk && !channel && !(split && similarity(split.artist, artistClean) >= 0.6)
  const complete = trusted && !!title && !!artist && !!cur.album.trim() && !!yearOf(cur.date)
  return {
    trusted,
    complete,
    query: { title: searchTitle(title) || title, artist },
    guess: {
      title,
      artist,
      album: cur.album.trim(),
      albumArtist: cur.albumArtist.trim(),
      // a video's date is its upload date, not the release date — offer the year only
      date: trusted ? normalizeDate(cur.date) : yearOf(cur.date),
      track: cur.track.trim(),
      genre: cur.genre.trim()
    }
  }
}

/**
 * Tags after a confident match. Untrusted (video-style) title/artist/album are
 * replaced; trusted ones are only filled where empty. The release date always
 * comes from the match — the file's date is YouTube's upload date.
 */
export function mergeMatch(cur: SongTags, m: SongTags, trusted: boolean): SongTags {
  const out: SongTags = { ...cur }
  const set = (k: keyof SongTags, replace: boolean): void => {
    if (m[k] && (replace || !out[k].trim())) out[k] = m[k]
  }
  set('title', !trusted)
  set('artist', !trusted)
  set('album', !trusted)
  set('albumArtist', !trusted)
  set('date', true)
  set('track', !trusted)
  set('genre', false)
  return out
}

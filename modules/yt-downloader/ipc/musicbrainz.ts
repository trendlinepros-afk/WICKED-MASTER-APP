/**
 * MusicBrainz lookups for "Fix missing song info" (main only; fetch injectable).
 *
 * MusicBrainz is a free, open music database — no account or key, but it asks
 * for a descriptive User-Agent and at most ONE request per second per client.
 * One instance is shared by every job in the process so the limit holds even
 * with three downloads running. Album art comes from the Cover Art Archive
 * (MusicBrainz's sister service, not rate limited the same way).
 */
import { normalizeDate, similarity, yearOf, type SongCandidate } from '../lib/songinfo'

const MB = 'https://musicbrainz.org/ws/2'
const CAA = 'https://coverartarchive.org'
const SPACING_MS = 1100
const TIMEOUT_MS = 20_000
const MAX_ART_BYTES = 8 * 1024 * 1024

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** MusicBrainz / Cover Art Archive couldn't be reached (offline, outage). */
export class MbUnavailable extends Error {}

export const mbUserAgent = (appVersion: string): string => `WICKED-Suite/${appVersion || '0'} ( https://github.com/trendlinepros-afk/WICKED-MASTER-APP )`

/* --------------------------- response shapes ---------------------------- */

interface Credit {
  name?: string
  joinphrase?: string
  artist?: { name?: string }
}
interface MbRelease {
  id: string
  title?: string
  status?: string
  date?: string
  country?: string
  'artist-credit'?: Credit[]
  'release-group'?: { id?: string; title?: string; 'primary-type'?: string; 'secondary-types'?: string[] }
  media?: { position?: number; 'track-count'?: number; track?: { number?: string; position?: number }[] }[]
}
interface MbRecording {
  id: string
  score?: number
  title?: string
  length?: number
  'artist-credit'?: Credit[]
  'first-release-date'?: string
  releases?: MbRelease[]
}

export const joinCredit = (c: Credit[] | undefined): string => (c ?? []).map((x) => `${x.name ?? x.artist?.name ?? ''}${x.joinphrase ?? ''}`).join('').trim()

/** Lucene phrase / terms for the MusicBrainz search syntax. */
const phrase = (s: string): string => `"${s.replace(/["\\]/g, '\\$&')}"`
const terms = (s: string): string =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1'))
    .join(' ')

/** Prefer the official, original studio album; then EP, single; compilations/live last; earliest first. */
export function releaseRank(r: MbRelease): number {
  let s = 0
  if ((r.status ?? '').toLowerCase() === 'official') s += 4
  const pt = r['release-group']?.['primary-type']
  s += pt === 'Album' ? 3 : pt === 'EP' ? 2 : pt === 'Single' ? 1.5 : 0
  const sec = r['release-group']?.['secondary-types'] ?? []
  if (!sec.length) s += 3
  else if (sec.includes('Compilation')) s -= 2
  else s -= 1 // live, soundtrack, remix, DJ-mix …
  if (r.date) s += 1
  return s
}

export function bestRelease(rs: MbRelease[] | undefined): MbRelease | null {
  if (!rs?.length) return null
  return [...rs].sort((a, b) => releaseRank(b) - releaseRank(a) || (a.date || '9999').localeCompare(b.date || '9999'))[0]
}

/** One recording → a candidate (its best release), with confidence vs. what was searched. */
export function toCandidate(rec: MbRecording, q: { title: string; artist: string }, durationMs: number | null): SongCandidate {
  const rel = bestRelease(rec.releases)
  const artist = joinCredit(rec['artist-credit'])
  const medium = rel?.media?.[0]
  const t = medium?.track?.[0]
  const num = t?.number && /^\d+$/.test(t.number) ? t.number : t?.position ? String(t.position) : ''
  const count = medium?.['track-count']
  const title = rec.title ?? ''
  const date = normalizeDate(rel?.date || rec['first-release-date'] || '')
  const tSim = similarity(q.title, title)
  const aSim = q.artist ? Math.max(similarity(q.artist, artist), ...(rec['artist-credit'] ?? []).map((c) => similarity(q.artist, c.name ?? c.artist?.name ?? ''))) : 0.5
  const durDiff = durationMs && rec.length ? Math.abs(rec.length - durationMs) / 1000 : null
  const durScore = durDiff === null ? 0.5 : Math.max(0, 1 - durDiff / 12)
  const confidence = Math.max(0, Math.min(1, tSim * 0.45 + aSim * 0.35 + durScore * 0.15 + ((rec.score ?? 0) / 100) * 0.05))
  const rg = rel?.['release-group']
  return {
    title,
    artist,
    album: rel?.title ?? rg?.title ?? '',
    albumArtist: joinCredit(rel?.['artist-credit']) || artist,
    date,
    track: num ? (count ? `${num}/${count}` : num) : '',
    genre: '',
    recordingId: rec.id,
    releaseId: rel?.id ?? '',
    releaseGroupId: rg?.id ?? '',
    durationMs: rec.length ?? null,
    confidence,
    releaseLabel: [rel?.title ?? rg?.title, yearOf(date), rg?.['primary-type'], ...(rg?.['secondary-types'] ?? []), rel?.country].filter(Boolean).join(' · ')
  }
}

/**
 * Good enough to write without asking? Title must match; artist must match when
 * we know it; with no artist, the duration has to agree closely instead.
 */
export function isConfident(c: SongCandidate, q: { title: string; artist: string }, durationMs: number | null, mbScore = 100): boolean {
  if (similarity(q.title, c.title) < 0.82) return false
  const durDiff = durationMs && c.durationMs ? Math.abs(c.durationMs - durationMs) / 1000 : null
  if (durDiff !== null && durDiff > 12) return false
  if (q.artist) {
    const a = similarity(q.artist, c.artist)
    const partial = normalizeIncludes(c.artist, q.artist)
    if (a < 0.6 && !partial) return false
  } else if (durDiff === null || durDiff > 4 || mbScore < 90) return false
  return true
}

const normalizeIncludes = (a: string, b: string): boolean => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return !!x && !!y && (x.includes(y) || y.includes(x))
}

export class MusicBrainz {
  private chain: Promise<void> = Promise.resolve()
  private last = 0

  constructor(
    private userAgent: string,
    private fetchFn: Fetch = fetch,
    private wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  /** GET JSON from the MusicBrainz API, ≤ 1 request/second across all callers.
   *  Requests (retries included) run one at a time through a single queue. */
  private mbJson<T>(path: string): Promise<T> {
    const run = this.chain.then(() => this.request<T>(path))
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async request<T>(path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const gap = this.last + SPACING_MS - Date.now()
      if (gap > 0) await this.wait(gap)
      this.last = Date.now()
      let r: Response
      try {
        r = await this.fetchFn(`${MB}${path}`, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (err) {
        if (attempt >= 2) throw new MbUnavailable(`Couldn’t reach MusicBrainz: ${err instanceof Error ? err.message : String(err)}`)
        await this.wait(2000 * (attempt + 1))
        continue
      }
      if (r.status === 503 || r.status === 429) {
        // MusicBrainz's "slow down" — back off and retry
        if (attempt >= 3) throw new MbUnavailable('MusicBrainz is busy right now — try again in a minute.')
        await this.wait(2000 * (attempt + 1))
        continue
      }
      if (r.status === 404) return {} as T
      if (!r.ok) throw new MbUnavailable(`MusicBrainz error (HTTP ${r.status})`)
      return (await r.json()) as T
    }
  }

  /** Recordings matching title/artist, as ranked candidates (best first). */
  async search(q: { title: string; artist: string }, durationMs: number | null, loose = false): Promise<(SongCandidate & { mbScore: number })[]> {
    if (!q.title.trim()) return []
    const query = loose
      ? `recording:(${terms(q.title)})${q.artist ? ` AND artist:(${terms(q.artist)})` : ''}`
      : `recording:${phrase(q.title)}${q.artist ? ` AND artist:${phrase(q.artist)}` : ''}`
    const res = await this.mbJson<{ recordings?: MbRecording[] }>(`/recording?query=${encodeURIComponent(query)}&fmt=json&limit=15`)
    return (res.recordings ?? [])
      .map((rec) => ({ ...toCandidate(rec, q, durationMs), mbScore: rec.score ?? 0 }))
      .sort((a, b) => b.confidence - a.confidence)
  }

  /** The best confident match: exact phrase search first, then a looser one. */
  async find(q: { title: string; artist: string }, durationMs: number | null): Promise<SongCandidate | null> {
    for (const loose of [false, true]) {
      const list = await this.search(q, durationMs, loose)
      const hit = list.find((c) => isConfident(c, q, durationMs, c.mbScore))
      if (hit) return hit
    }
    return null
  }

  /** Most-voted genre of a release group ('' if none). */
  async genre(releaseGroupId: string): Promise<string> {
    if (!releaseGroupId) return ''
    const res = await this.mbJson<{ genres?: { name?: string; count?: number }[] }>(`/release-group/${encodeURIComponent(releaseGroupId)}?inc=genres&fmt=json`)
    const top = [...(res.genres ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0]?.name ?? ''
    return top.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  /** Front cover of the release (or its release group), or null if there is none. */
  async coverArt(releaseId: string, releaseGroupId: string, size: 250 | 500 = 500): Promise<{ data: Buffer; mime: string } | null> {
    const urls = [releaseId && `${CAA}/release/${releaseId}/front-${size}`, releaseGroupId && `${CAA}/release-group/${releaseGroupId}/front-${size}`].filter(Boolean) as string[]
    for (const url of urls) {
      let r: Response
      try {
        r = await this.fetchFn(url, { headers: { 'User-Agent': this.userAgent }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (err) {
        throw new MbUnavailable(`Couldn’t reach the Cover Art Archive: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (r.status === 404) continue
      if (!r.ok) continue
      const mime = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      const data = Buffer.from(await r.arrayBuffer())
      if (!/^image\/(jpeg|png)$/.test(mime) || !data.length || data.length > MAX_ART_BYTES) continue
      return { data, mime }
    }
    return null
  }
}

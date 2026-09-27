/**
 * YouTube URL parsing + thumbnail discovery for training personas/themes from
 * a channel or a video (main only; no API key — reads public pages).
 */
import type { YtLookup, YtThumb } from '../types'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 15_000

export type YtRef = { kind: 'video'; id: string } | { kind: 'channel'; path: string; label: string }

/** watch / youtu.be / shorts / embed / live → video; @handle / channel / c / user → channel. */
export function parseYouTubeUrl(input: string): YtRef | null {
  const s = input.trim()
  if (!s) return null
  if (/^[0-9A-Za-z_-]{11}$/.test(s)) return { kind: 'video', id: s }
  if (/^@[\w.-]{2,}$/.test(s)) return { kind: 'channel', path: `/${s}`, label: s }
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1]
    return id && /^[0-9A-Za-z_-]{11}$/.test(id) ? { kind: 'video', id } : null
  }
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null
  const v = u.searchParams.get('v')
  if (v && /^[0-9A-Za-z_-]{11}$/.test(v)) return { kind: 'video', id: v }
  const m = /^\/(shorts|embed|live|v)\/([0-9A-Za-z_-]{11})/.exec(u.pathname)
  if (m) return { kind: 'video', id: m[2] }
  const c = /^\/(@[\w.-]+|channel\/UC[0-9A-Za-z_-]{22}|c\/[^/]+|user\/[^/]+)/.exec(u.pathname)
  if (c) return { kind: 'channel', path: `/${c[1]}`, label: c[1].startsWith('@') ? c[1] : c[1].split('/')[1] }
  return null
}

export const thumbCandidates = (id: string): string[] => [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/sddefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`]

async function fetchText(url: string, fetchFn: typeof fetch): Promise<string> {
  const resp = await fetchFn(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!resp.ok) throw new Error(`YouTube returned HTTP ${resp.status}`)
  return resp.text()
}

/** The first candidate that actually exists (maxres is missing on many older videos). */
export async function resolveThumb(id: string, fetchFn: typeof fetch = fetch): Promise<string> {
  for (const url of thumbCandidates(id)) {
    try {
      const r = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      if (r.ok) return url
    } catch {
      /* try the next size */
    }
  }
  return thumbCandidates(id)[2]
}

const unescapeJson = (s: string): string => {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

/** Video ids + titles from a channel page's ytInitialData (pure). */
export function parseChannelVideos(html: string, limit = 24): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = []
  const seen = new Set<string>()
  const re = /"videoId":"([0-9A-Za-z_-]{11})"(?:(?!"videoId").){0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < limit) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ id: m[1], title: unescapeJson(m[2]) })
  }
  if (!out.length) {
    // fallback: ids only
    const re2 = /"videoId":"([0-9A-Za-z_-]{11})"/g
    while ((m = re2.exec(html)) && out.length < limit) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      out.push({ id: m[1], title: '' })
    }
  }
  return out
}

/** og:title / <title> of a watch page (pure). */
export function parseVideoTitle(html: string): string {
  const og = /<meta property="og:title" content="([^"]*)"/.exec(html)
  if (og) return og[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  const t = /<title>([^<]*)<\/title>/.exec(html)
  return t ? t[1].replace(/ - YouTube$/, '') : ''
}

export async function lookupYouTube(input: string, fetchFn: typeof fetch = fetch): Promise<YtLookup> {
  const ref = parseYouTubeUrl(input)
  if (!ref) throw new Error('That doesn’t look like a YouTube video or channel link.')
  if (ref.kind === 'video') {
    let title = ''
    try {
      title = parseVideoTitle(await fetchText(`https://www.youtube.com/watch?v=${ref.id}`, fetchFn))
    } catch {
      /* title is optional */
    }
    const url = await resolveThumb(ref.id, fetchFn)
    return { kind: 'video', label: title || ref.id, items: [{ videoId: ref.id, title, url }] }
  }
  const html = await fetchText(`https://www.youtube.com${ref.path}/videos`, fetchFn)
  const vids = parseChannelVideos(html, 30)
  if (!vids.length) throw new Error('Couldn’t read any videos from that channel page (private, empty, or YouTube changed its layout).')
  // resolve real thumbnail URLs a few at a time
  const items: YtThumb[] = []
  for (let i = 0; i < vids.length; i += 6) {
    const chunk = vids.slice(i, i + 6)
    const urls = await Promise.all(chunk.map((v) => resolveThumb(v.id, fetchFn)))
    chunk.forEach((v, j) => items.push({ videoId: v.id, title: v.title, url: urls[j] }))
  }
  return { kind: 'channel', label: ref.label, items }
}

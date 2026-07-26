/**
 * Pure YouTube / YouTube Music URL + quality helpers.
 *
 * Lives in lib/ (not ipc/) because BOTH sides need it: the main process uses it
 * to drive yt-dlp, and the renderer uses it to recognise a music link the moment
 * you paste one (tsconfig excludes modules/*\/ipc/** from the web project, so the
 * renderer cannot import from there).
 */

/* ----------------------------- URL analysis ------------------------------ *
 * YouTube Music (music.youtube.com) is served by the same yt-dlp extractor as
 * youtube.com, so it works — but its URLs need care:
 *   - Clicking a song in YT Music yields `watch?v=<track>&list=RDAMVM<track>`,
 *     i.e. the track PLUS an auto-generated (effectively endless) radio mix.
 *     yt-dlp's default for a v+list URL is to take the PLAYLIST, so a naive
 *     download grabs the whole radio instead of the one song. We detect that
 *     and let the user choose.
 *   - Album URLs use `list=OLAK5uy_…`, radio/mix use `list=RD…`, and personal
 *     library lists (LM / liked music) need a signed-in session we don't have.
 * ------------------------------------------------------------------------- */

export type PlaylistKind = 'album' | 'mix' | 'playlist' | 'library'

export interface YtUrlInfo {
  isMusic: boolean
  videoId: string | null
  listId: string | null
  playlistKind: PlaylistKind | null
  /** URL carries BOTH a track and a list → the user must pick which to fetch */
  hasBoth: boolean
  /** list needs a signed-in account (personal library) — unsupported */
  needsAuth: boolean
}

function classifyList(listId: string | null): PlaylistKind | null {
  if (!listId) return null
  if (listId.startsWith('OLAK5uy_')) return 'album' // YT Music album
  if (/^RD|^RDAMVM|^RDCLAK/.test(listId)) return 'mix' // radio / auto-mix
  if (listId === 'LM' || listId.startsWith('LL')) return 'library' // liked music
  return 'playlist'
}

/** Parse a YouTube / YouTube Music URL (pure). Never throws. */
export function parseYtUrl(raw: string): YtUrlInfo {
  const empty: YtUrlInfo = {
    isMusic: false,
    videoId: null,
    listId: null,
    playlistKind: null,
    hasBoth: false,
    needsAuth: false
  }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return empty
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const isMusic = host === 'music.youtube.com'
  let videoId = u.searchParams.get('v')
  const listId = u.searchParams.get('list')

  // youtu.be/<id>, /shorts/<id>, /live/<id> carry the id in the path
  if (!videoId) {
    if (host === 'youtu.be') videoId = u.pathname.replace(/^\//, '').split('/')[0] || null
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/)
      if (m) videoId = m[1]
    }
  }
  const playlistKind = classifyList(listId)
  return {
    isMusic,
    videoId: videoId || null,
    listId: listId || null,
    playlistKind,
    hasBoth: !!videoId && !!listId,
    needsAuth: playlistKind === 'library'
  }
}

export function isAudioQuality(quality: string): boolean {
  return quality === 'audio' || quality === 'audio-native'
}

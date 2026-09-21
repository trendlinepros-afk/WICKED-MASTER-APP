/**
 * YouTube channel resolution + live-status for the Live TV panel (MAIN ONLY).
 *
 * The evergreen embed the panel uses — https://www.youtube.com/embed/live_stream?channel=<UCID>
 * — needs the channel's UC… id, which the user only gives us as an @handle.
 * We resolve handle→id by fetching the channel's /live page (the trick the user
 * hinted at: "/live at the end of the url"). That SAME page also tells us
 * whether the channel is live RIGHT NOW, so one fetch powers both the embed URL
 * and the little LIVE dot. Everything here is fail-soft: any network/parse
 * problem returns null/false and the caller falls back gracefully.
 *
 * This runs in the Electron main process on the user's machine (which can reach
 * YouTube), never in the sandbox and never in the renderer.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const TIMEOUT_MS = 12_000

async function fetchText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        // ask YouTube to skip the EU consent interstitial (US app)
        Cookie: 'CONSENT=YES+1'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!resp.ok) return null
    return await resp.text()
  } catch {
    return null
  }
}

/** Pull the UC… channel id out of a channel/watch page's HTML. */
export function parseChannelId(html: string): string | null {
  // "channelId":"UC…" / "externalId":"UC…" (ytInitialData + microformat), or a
  // /channel/UC… canonical/og:url — whichever appears first.
  const m = /(?:"(?:channelId|externalId)"\s*:\s*"|\/channel\/)(UC[0-9A-Za-z_-]{22})/.exec(html)
  return m ? m[1] : null
}

/**
 * Is this /live page a CURRENTLY-LIVE broadcast? When a channel is live, its
 * /live URL resolves to the live watch page whose microformat carries
 * "isLiveNow":true. When it's offline, /live redirects to the channel home
 * (no such flag); an UPCOMING/scheduled stream has isLiveNow:false — so keying
 * on isLiveNow:true avoids counting "offline" or "starting soon" as live.
 */
export function parseIsLive(html: string): boolean {
  if (/"isLiveNow"\s*:\s*true/.test(html)) return true
  // fallback: a live watch page canonical + a live HLS manifest present
  const onWatch = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=[0-9A-Za-z_-]{11}">/.test(html)
  return onWatch && /"hlsManifestUrl"\s*:\s*"/.test(html)
}

export interface LiveResolve {
  /** UC… id, or null if it couldn't be resolved */
  channelId: string | null
  /** whether the channel is live right now */
  live: boolean
}

/**
 * Resolve an @handle to its channelId AND its live status in as few fetches as
 * possible: the /live page usually yields both; if the id isn't in it (rare
 * redirect shapes) we fall back to the plain channel page for the id only.
 */
export async function resolveHandle(handle: string): Promise<LiveResolve> {
  const h = encodeURIComponent(handle.replace(/^@/, '').trim())
  if (!h) return { channelId: null, live: false }
  const liveHtml = await fetchText(`https://www.youtube.com/@${h}/live`)
  let channelId = liveHtml ? parseChannelId(liveHtml) : null
  const live = liveHtml ? parseIsLive(liveHtml) : false
  if (!channelId) {
    const homeHtml = await fetchText(`https://www.youtube.com/@${h}`)
    channelId = homeHtml ? parseChannelId(homeHtml) : null
  }
  return { channelId, live }
}

/** Live-only check for a channel whose id we already know. */
export async function channelIsLive(channelId: string): Promise<boolean> {
  const html = await fetchText(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`)
  return html ? parseIsLive(html) : false
}

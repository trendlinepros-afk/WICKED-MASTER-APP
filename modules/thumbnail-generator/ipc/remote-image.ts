/**
 * Remote image → small data: URL for on-screen previews (main only).
 *
 * The shell's Content-Security-Policy only lets the window load images from
 * itself / data: / blob:, so web images (YouTube thumbnails, pasted image
 * links) are fetched here and handed over inline — the same route local files
 * already take. `shrink` (nativeImage in ipc.ts) scales them down so a grid of
 * 30 channel thumbnails stays light.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_BYTES = 15 * 1024 * 1024
/** used as-is when it can't be decoded/shrunk (e.g. WebP) */
const MAX_RAW_BYTES = 5 * 1024 * 1024

/** Image type from the first bytes, or null if it isn't a known image. */
export function sniffImage(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

export interface Shrunk {
  data: Buffer
  mime: string
}

export async function fetchRemotePreview(url: string, opts: { fetchFn?: Fetch; shrink?: (buf: Buffer, mime: string) => Shrunk | null } = {}): Promise<string> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('Not a valid image link')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) image links can be previewed')
  const resp = await (opts.fetchFn ?? fetch)(u.toString(), { headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
  if (!resp.ok) throw new Error(`Image returned HTTP ${resp.status}`)
  const len = Number(resp.headers.get('content-length'))
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('Image is too large to preview')
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('Image is too large to preview')
  const ct = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mime = sniffImage(buf) ?? (ct.startsWith('image/') && ct !== 'image/svg+xml' ? ct : null)
  if (!mime) throw new Error('That link isn’t an image')
  const small = opts.shrink?.(buf, mime) ?? null
  if (small) return `data:${small.mime};base64,${small.data.toString('base64')}`
  if (buf.length > MAX_RAW_BYTES) throw new Error('Image is too large to preview')
  return `data:${mime};base64,${buf.toString('base64')}`
}

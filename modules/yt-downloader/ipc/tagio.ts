/**
 * Read / write a song file's tags + cover art with the bundled ffprobe/ffmpeg
 * (main only). Writes are lossless (-c copy) into a hidden temp file that then
 * replaces the original, so a failed write never damages the song.
 *
 *  - MP3: ID3v2.3 (what Windows Explorer / most players read best); a full
 *    YYYY-MM-DD date is kept (TYER + TDAT). Cover = attached picture.
 *  - M4A: iTunes atoms; cover = attached picture.
 *  - Opus/Ogg: tags live on the audio stream (Vorbis comments) and the cover is
 *    a METADATA_BLOCK_PICTURE comment. ffmpeg drops that comment on a plain
 *    re-mux, so every write rebuilds the full comment set (old tags + new +
 *    the picture) from an ffmetadata file mapped onto the audio stream.
 */
import { spawn } from 'child_process'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { emptyTags, normalizeDate, type SongTags } from '../lib/songinfo'

const TIMEOUT_MS = 90_000

export interface ProbedSong {
  tags: SongTags
  /** every tag as read (lower-cased keys) — kept on rewrite */
  raw: Record<string, string>
  hasArt: boolean
  artCodec: string | null
  durationMs: number | null
  container: 'mp3' | 'mp4' | 'ogg' | 'other'
}

export interface Art {
  data: Buffer
  mime: string
}

function run(cmd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: String(err) })
      return
    }
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-3000)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: err + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: err })
    })
  })
}

export function containerOf(path: string): ProbedSong['container'] {
  const e = extname(path).toLowerCase()
  if (e === '.mp3') return 'mp3'
  if (e === '.m4a' || e === '.mp4' || e === '.aac' || e === '.m4b') return 'mp4'
  if (e === '.opus' || e === '.ogg' || e === '.oga') return 'ogg'
  return 'other'
}

/** Tag dict (any case) → SongTags. */
export function tagsFromRaw(raw: Record<string, string>): SongTags {
  const g = (...keys: string[]): string => {
    for (const k of keys) if (raw[k]?.trim()) return raw[k].trim()
    return ''
  }
  const track = g('track', 'tracknumber')
  const total = g('tracktotal', 'totaltracks')
  return {
    ...emptyTags(),
    title: g('title'),
    artist: g('artist'),
    album: g('album'),
    albumArtist: g('album_artist', 'albumartist', 'album artist'),
    date: normalizeDate(g('date', 'year', 'originaldate')),
    track: track && total && !track.includes('/') ? `${track}/${total}` : track,
    genre: g('genre')
  }
}

export async function probeSong(ffprobe: string, path: string): Promise<ProbedSong> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:format_tags:stream=index,codec_name,codec_type:stream_tags:stream_disposition=attached_pic', '-of', 'json', path], 30_000)
  if (r.code !== 0) throw new Error(`Couldn’t read the file’s tags: ${r.stderr.split('\n').filter(Boolean).pop() ?? `ffprobe exited ${r.code}`}`)
  const j = JSON.parse(r.stdout.toString('utf8') || '{}') as {
    format?: { duration?: string; tags?: Record<string, string> }
    streams?: { codec_type?: string; codec_name?: string; tags?: Record<string, string>; disposition?: { attached_pic?: number } }[]
  }
  const raw: Record<string, string> = {}
  const addAll = (t?: Record<string, string>): void => {
    for (const [k, v] of Object.entries(t ?? {})) if (typeof v === 'string') raw[k.toLowerCase()] = v
  }
  addAll(j.format?.tags)
  addAll(j.streams?.find((s) => s.codec_type === 'audio')?.tags) // Ogg keeps its tags here
  const pic = j.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1) ?? j.streams?.find((s) => s.codec_type === 'video')
  const dur = Number(j.format?.duration)
  return {
    tags: tagsFromRaw(raw),
    raw,
    hasArt: !!pic,
    artCodec: pic?.codec_name ?? null,
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null,
    container: containerOf(path)
  }
}

/** The embedded cover. maxWidth > 0 re-encodes a small JPEG preview; 0 = original bytes. */
export async function extractArt(ffmpeg: string, path: string, maxWidth = 0): Promise<Art | null> {
  const args = maxWidth > 0 ? ['-v', 'error', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, '-c:v', 'mjpeg', '-f', 'image2pipe', '-'] : ['-v', 'error', '-i', path, '-map', '0:v:0', '-frames:v', '1', '-c:v', 'copy', '-f', 'image2pipe', '-']
  const r = await run(ffmpeg, args, 30_000)
  if (r.code !== 0 || !r.stdout.length) return null
  const b = r.stdout
  const mime = b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : 'image/jpeg'
  return { data: b, mime }
}

/** A FLAC picture block (what Vorbis comments carry as METADATA_BLOCK_PICTURE), base64. */
export function flacPictureBlock(art: Art): string {
  const mime = Buffer.from(art.mime)
  const desc = Buffer.from('Cover (front)')
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(desc.length), desc, u32(0), u32(0), u32(0), u32(0), u32(art.data.length), art.data]).toString('base64')
}

const ffmetaEscape = (s: string): string => s.replace(/[\\=;#\n]/g, (c) => `\\${c}`)

/** Generic tag names → each container's keys. */
const ID3_KEYS: Record<keyof SongTags, string> = { title: 'title', artist: 'artist', album: 'album', albumArtist: 'album_artist', date: 'date', track: 'track', genre: 'genre' }
const VORBIS_KEYS: Record<keyof SongTags, string> = { title: 'TITLE', artist: 'ARTIST', album: 'ALBUM', albumArtist: 'ALBUMARTIST', date: 'DATE', track: 'TRACKNUMBER', genre: 'GENRE' }

/**
 * Write `tags` (empty fields are left as they are) and, when `art` is given,
 * replace the cover. Throws on failure; the original file is untouched then.
 */
export async function writeSongTags(ffmpeg: string, path: string, probed: ProbedSong, tags: SongTags, art: Art | null): Promise<void> {
  const ext = extname(path)
  const tmp = join(dirname(path), `.${basename(path, ext)}.wktag${ext}`) // hidden: never picked up as a finished song
  const scratch: string[] = [tmp]
  const args: string[] = ['-y', '-v', 'error', '-i', path]
  try {
    if (probed.container === 'ogg') {
      // full Vorbis comment set: everything already there, overridden by the new values
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(probed.raw)) {
        if (/^(encoder|metadata_block_picture|tracktotal|totaltracks)$/.test(k)) continue
        out[k.toUpperCase()] = v
      }
      for (const key of Object.keys(VORBIS_KEYS) as (keyof SongTags)[]) {
        const v = tags[key].trim()
        if (!v) continue
        if (key === 'track') {
          const [n, total] = v.split('/')
          out.TRACKNUMBER = n
          if (total) out.TRACKTOTAL = total
          delete out.TRACK
        } else out[VORBIS_KEYS[key]] = v
      }
      const pic = art ?? (probed.hasArt ? await extractArt(ffmpeg, path) : null)
      let meta = ';FFMETADATA1\n'
      for (const [k, v] of Object.entries(out)) meta += `${ffmetaEscape(k)}=${ffmetaEscape(v)}\n`
      if (pic) meta += `METADATA_BLOCK_PICTURE=${ffmetaEscape(flacPictureBlock(pic))}\n`
      const metaFile = join(dirname(path), `.${basename(path, ext)}.wkmeta.txt`)
      scratch.push(metaFile)
      writeFileSync(metaFile, meta, 'utf8')
      args.push('-i', metaFile, '-map', '0:a', '-c', 'copy', '-map_metadata:s:a:0', '1:g', tmp)
    } else {
      let artFile = ''
      if (art) {
        artFile = join(dirname(path), `.${basename(path, ext)}.wkart${art.mime === 'image/png' ? '.png' : '.jpg'}`)
        scratch.push(artFile)
        writeFileSync(artFile, art.data)
        args.push('-i', artFile, '-map', '0:a', '-map', '1:0')
      } else args.push('-map', '0:a', '-map', '0:v?')
      args.push('-c', 'copy', '-map_metadata', '0')
      if (probed.container === 'mp3') args.push('-id3v2_version', '3')
      for (const key of Object.keys(ID3_KEYS) as (keyof SongTags)[]) {
        const v = tags[key].trim()
        if (v) args.push('-metadata', `${ID3_KEYS[key]}=${v}`)
      }
      if (art) {
        args.push('-disposition:v:0', 'attached_pic')
        if (probed.container === 'mp3') args.push('-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)')
      }
      args.push(tmp)
    }
    const r = await run(ffmpeg, args)
    if (r.code !== 0 || !existsSync(tmp) || statSync(tmp).size === 0)
      throw new Error(`Couldn’t write tags: ${r.stderr.split('\n').filter(Boolean).pop() ?? `ffmpeg exited ${r.code}`}`)
    renameSync(tmp, path)
  } finally {
    for (const f of scratch) rmSync(f, { force: true })
  }
}

export const readImage = (path: string): Art => {
  const data = readFileSync(path)
  if (data.length > 10 * 1024 * 1024) throw new Error('That image is over 10 MB — pick a smaller one.')
  const png = data[0] === 0x89 && data[1] === 0x50
  const jpg = data[0] === 0xff && data[1] === 0xd8
  if (!png && !jpg) throw new Error('Pick a JPG or PNG image.')
  return { data, mime: png ? 'image/png' : 'image/jpeg' }
}

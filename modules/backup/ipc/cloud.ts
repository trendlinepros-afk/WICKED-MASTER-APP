/**
 * Offsite copy of backup versions in Google Drive (reusing File Vault's
 * connection). Drive layout:
 *
 *   My Drive/WICKED Backups/<plan folder>/
 *     plan.json
 *     <versionId>.p001.wkpack …   — the version's NEW file bytes, concatenated
 *                                    in storePath order, split into ≤1 GiB parts
 *     <versionId>.manifest.json.gz — identical to the local manifest
 *     <versionId>.info.json        — written LAST: its presence = version complete
 *
 * Why packs instead of mirroring every file: Drive sustains only a few file
 * creations per second, so 100k small files would take many hours. A pack is a
 * handful of big resumable uploads, each MD5-verified against Drive's own
 * checksum. Single files still restore cheaply: the manifest gives each file's
 * byte offset, and restores use HTTP Range requests for just those bytes.
 */
import { createHash, randomBytes } from 'crypto'
import { once } from 'events'
import { createWriteStream } from 'fs'
import { mkdir, open, type FileHandle } from 'fs/promises'
import { dirname } from 'path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import {
  DriveApiError,
  findOrCreateSubfolder,
  listFolder,
  trashFile,
  type DriveFileRaw
} from '../../file-vault/ipc/gdrive'
import type { BackupPlan, Manifest, VersionInfo } from '../types'
import { CancelledError, dataPath, decodeManifest, encodeManifest, errText, readManifest, type JobIO, type RestoreItem, type RestoreSource } from './engine'

export const CLOUD_ROOT_NAME = 'WICKED Backups'
export const PART_SIZE = 1024 ** 3
const UPLOAD_CHUNK = 16 * 1024 * 1024
const MAX_RETRIES = 5
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FIELDS = 'id,name,size,mimeType,md5Checksum,modifiedTime'
/** merge neighbouring files into one ranged read when the gap is this small */
const RANGE_GAP = 1024 * 1024

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ Drive client ------------------------------ */

export interface SliceUpload {
  name: string
  folderId: string
  size: number
  /** fill buf[0..len) with bytes at `offset` of the slice; returns bytes read */
  read: (offset: number, buf: Buffer, len: number) => Promise<number>
  signal: AbortSignal
  onProgress: (sent: number) => void
}

/** What the replica needs from Drive (a fake implements this in tests). */
export interface DriveClient {
  listFolder(folderId: string): Promise<DriveFileRaw[]>
  folder(name: string, parentId: string): Promise<string>
  trash(fileId: string): Promise<void>
  uploadBuffer(name: string, folderId: string, data: Buffer, existingId?: string): Promise<DriveFileRaw>
  /** resumable upload; resolves with the created file (md5Checksum included) */
  uploadSlice(o: SliceUpload): Promise<DriveFileRaw & { localMd5: string }>
  downloadBuffer(fileId: string): Promise<Buffer>
  /** bytes [start, endExcl) of a file */
  range(fileId: string, start: number, endExcl: number, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
}

function driveError(status: number, text: string): Error {
  if (/storageQuotaExceeded/.test(text)) return new Error('Your Google Drive is full — free up space or turn off the Drive copy for this plan.')
  if (/uploadLimitExceeded|userRateLimitExceeded|dailyLimitExceeded/.test(text))
    return new Error("Google Drive's daily upload limit (750 GB) was reached — the copy continues on the next run.")
  return new Error(`Google Drive error (HTTP ${status}): ${text.slice(0, 240)}`)
}

export function realDriveClient(getToken: () => Promise<string>): DriveClient {
  const authed = async (url: string, init: RequestInit = {}, attempt = 0): Promise<Response> => {
    const token = await getToken()
    let r: Response
    try {
      r = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
    } catch (err) {
      if ((init.signal as AbortSignal | undefined)?.aborted) throw new CancelledError()
      if (attempt >= MAX_RETRIES) throw err
      await sleep(1000 * 2 ** attempt)
      return authed(url, init, attempt + 1)
    }
    if ((r.status >= 500 || r.status === 429) && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt)
      return authed(url, init, attempt + 1)
    }
    return r
  }

  return {
    async listFolder(folderId) {
      return listFolder(await getToken(), folderId)
    },
    async folder(name, parentId) {
      return findOrCreateSubfolder(await getToken(), name, parentId)
    },
    async trash(fileId) {
      try {
        await trashFile(await getToken(), fileId)
      } catch (err) {
        if (err instanceof DriveApiError && err.status === 404) return // already gone
        throw err
      }
    },
    async uploadBuffer(name, folderId, data, existingId) {
      const b = `wkb${randomBytes(8).toString('hex')}`
      const meta = existingId ? {} : { name, parents: [folderId] }
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${b}--`)
      ])
      const url = existingId
        ? `${UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=${FIELDS}`
        : `${UPLOAD_API}/files?uploadType=multipart&fields=${FIELDS}`
      const r = await authed(url, {
        method: existingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${b}` },
        body
      })
      if (!r.ok) throw driveError(r.status, await r.text())
      return (await r.json()) as DriveFileRaw
    },
    async uploadSlice(o) {
      const md5 = createHash('md5')
      let hashedTo = 0
      const init = async (): Promise<string> => {
        const r = await authed(`${UPLOAD_API}/files?uploadType=resumable&fields=${FIELDS}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(o.size) },
          body: JSON.stringify({ name: o.name, parents: [o.folderId] }),
          signal: o.signal
        })
        if (!r.ok) throw driveError(r.status, await r.text())
        const loc = r.headers.get('location')
        if (!loc) throw new Error('Google Drive did not return an upload session')
        return loc
      }
      const probe = async (session: string): Promise<{ offset: number; file?: DriveFileRaw } | null> => {
        try {
          const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${o.size}` }, signal: o.signal })
          if (r.status === 308) {
            const range = r.headers.get('range')
            return { offset: range ? Number(range.split('-')[1]) + 1 : 0 }
          }
          if (r.ok) return { offset: o.size, file: (await r.json()) as DriveFileRaw }
        } catch {
          /* keep our own offset */
        }
        return null
      }
      const done = (f: DriveFileRaw): DriveFileRaw & { localMd5: string } => ({ ...f, localMd5: md5.digest('hex') })

      let session = await init()
      if (o.size === 0) {
        const r = await fetch(session, { method: 'PUT', headers: { 'Content-Length': '0' }, body: new Uint8Array(0), signal: o.signal })
        if (!r.ok) throw driveError(r.status, await r.text())
        return done((await r.json()) as DriveFileRaw)
      }
      const buf = Buffer.allocUnsafe(Math.min(UPLOAD_CHUNK, o.size))
      let offset = 0
      let attempts = 0
      let restarted = false
      for (;;) {
        if (o.signal.aborted) throw new CancelledError()
        const len = Math.min(UPLOAD_CHUNK, o.size - offset)
        const got = await o.read(offset, buf, len)
        if (got !== len) throw new Error('Local backup data changed while uploading — run Validate on this version.')
        // hash each byte exactly once, even when a retry rewinds the offset
        if (offset + len > hashedTo) {
          md5.update(buf.subarray(hashedTo - offset, len))
          hashedTo = offset + len
        }
        let r: Response
        try {
          r = await fetch(session, {
            method: 'PUT',
            headers: { 'Content-Range': `bytes ${offset}-${offset + len - 1}/${o.size}` },
            body: buf.subarray(0, len),
            signal: o.signal
          })
        } catch (err) {
          if (o.signal.aborted) throw new CancelledError()
          if (++attempts > MAX_RETRIES) throw err
          await sleep(1000 * 2 ** attempts)
          const p = await probe(session)
          if (p?.file) return done(p.file)
          if (p) offset = p.offset
          continue
        }
        if (r.status === 308) {
          const range = r.headers.get('range')
          offset = range ? Number(range.split('-')[1]) + 1 : offset + len
          attempts = 0
          o.onProgress(offset)
          continue
        }
        if (r.ok) {
          o.onProgress(o.size)
          return done((await r.json()) as DriveFileRaw)
        }
        if (r.status === 404 && !restarted) {
          restarted = true
          session = await init()
          offset = 0
          o.onProgress(0)
          continue
        }
        if (r.status >= 500 && ++attempts <= MAX_RETRIES) {
          await sleep(1000 * 2 ** attempts)
          const p = await probe(session)
          if (p?.file) return done(p.file)
          if (p) offset = p.offset
          continue
        }
        throw driveError(r.status, await r.text())
      }
    },
    async downloadBuffer(fileId) {
      const r = await authed(`${API}/files/${encodeURIComponent(fileId)}?alt=media`)
      if (!r.ok) throw driveError(r.status, await r.text())
      return Buffer.from(await r.arrayBuffer())
    },
    async range(fileId, start, endExcl, signal) {
      const r = await authed(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Range: `bytes=${start}-${endExcl - 1}` },
        signal
      })
      if (!r.ok) throw driveError(r.status, await r.text())
      if (!r.body) throw new Error('Google Drive returned no data')
      const body = Readable.fromWeb(r.body as unknown as import('stream/web').ReadableStream<Uint8Array>)
      if (r.status === 206 || start === 0) return body
      // server ignored the Range header: skip ahead ourselves
      return (async function* () {
        let skip = start
        let left = endExcl - start
        for await (const c of body) {
          let chunk = c as Buffer
          if (skip > 0) {
            if (chunk.length <= skip) {
              skip -= chunk.length
              continue
            }
            chunk = chunk.subarray(skip)
            skip = 0
          }
          if (chunk.length >= left) {
            yield chunk.subarray(0, left)
            return
          }
          left -= chunk.length
          yield chunk
        }
      })()
    }
  }
}

/* --------------------------------- layout --------------------------------- */

export interface PackEntry {
  sp: string
  offset: number
  size: number
}

/** Byte layout of a version's pack: the files stored IN it, in storePath order. */
export function packLayout(m: Manifest): { entries: PackEntry[]; total: number } {
  const own = Object.keys(m.files)
    .filter((sp) => m.files[sp].v === m.versionId)
    .sort()
  let offset = 0
  const entries = own.map((sp) => {
    const e = { sp, offset, size: m.files[sp].size }
    offset += e.size
    return e
  })
  return { entries, total: offset }
}

export const partName = (vid: string, n: number): string => `${vid}.p${String(n + 1).padStart(3, '0')}.wkpack`
const NAME_RE = /^(.+?)\.(p(\d{3})\.wkpack|manifest\.json\.gz|info\.json)$/

/** Reads a pack's bytes straight from the local version's data files. */
function packReader(root: string, vid: string, entries: PackEntry[]): { read: (off: number, buf: Buffer, len: number, bufOff?: number) => Promise<number>; close: () => Promise<void> } {
  const nz = entries.filter((e) => e.size > 0)
  let fh: FileHandle | null = null
  let fhIdx = -1
  const find = (pos: number): number => {
    let lo = 0
    let hi = nz.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const e = nz[mid]
      if (pos < e.offset) hi = mid - 1
      else if (pos >= e.offset + e.size) lo = mid + 1
      else return mid
    }
    return -1
  }
  return {
    async read(off, buf, len, bufOff = 0) {
      let done = 0
      while (done < len) {
        const pos = off + done
        const i = find(pos)
        if (i < 0) break
        const e = nz[i]
        if (fhIdx !== i) {
          await fh?.close()
          fh = null
          fh = await open(dataPath(root, vid, e.sp), 'r')
          fhIdx = i
        }
        const want = Math.min(len - done, e.offset + e.size - pos)
        const { bytesRead } = await fh!.read(buf, bufOff + done, want, pos - e.offset)
        if (bytesRead !== want) throw new Error(`Local backup data for ${e.sp} is shorter than recorded — run Validate on this version.`)
        done += want
      }
      return done
    },
    async close() {
      await fh?.close()
      fh = null
    }
  }
}

/* ---------------------------------- sync ---------------------------------- */

export async function ensurePlanFolder(drive: DriveClient, planFolder: string): Promise<string> {
  const rootId = await drive.folder(CLOUD_ROOT_NAME, 'root')
  return drive.folder(planFolder, rootId)
}

export interface CloudListing {
  files: DriveFileRaw[]
  byName: Map<string, DriveFileRaw>
  complete: Set<string>
  partial: Set<string>
}

export async function cloudListing(drive: DriveClient, folderId: string): Promise<CloudListing> {
  const files = await drive.listFolder(folderId)
  const byName = new Map(files.map((f) => [f.name, f]))
  const complete = new Set<string>()
  const partial = new Set<string>()
  for (const f of files) {
    const m = NAME_RE.exec(f.name)
    if (!m) continue
    if (m[2] === 'info.json') complete.add(m[1])
    else partial.add(m[1])
  }
  for (const v of complete) partial.delete(v)
  return { files, byName, complete, partial }
}

export interface SyncResult {
  uploaded: string[]
  bytes: number
}

/** Upload every local version that isn't complete in Drive yet (oldest first). */
export async function syncToCloud(o: {
  drive: DriveClient
  root: string
  plan: BackupPlan
  folderId: string
  versions: VersionInfo[]
  io: JobIO
  partSize?: number
}): Promise<SyncResult> {
  const { drive, root, plan, folderId, io } = o
  const partSize = o.partSize ?? PART_SIZE
  const listing = await cloudListing(drive, folderId)
  const res: SyncResult = { uploaded: [], bytes: 0 }

  // plan.json first: lets "open existing backup" work from Drive alone
  const planJson = Buffer.from(JSON.stringify({ ...plan, nextRun: null }, null, 2))
  await drive.uploadBuffer('plan.json', folderId, planJson, listing.byName.get('plan.json')?.id)

  const todo = [...o.versions].sort((a, b) => a.createdAt - b.createdAt).filter((v) => !listing.complete.has(v.id))
  if (!todo.length) return res

  const manifests = new Map<string, Manifest>()
  let total = 0
  for (const v of todo) {
    const m = await readManifest(root, v.id)
    manifests.set(v.id, m)
    total += packLayout(m).total
  }
  let doneBytes = 0
  io.onProgress({ phase: 'cloud', message: 'Copying to Google Drive…', cloudBytesTotal: total, cloudBytesDone: 0 })

  for (const v of todo) {
    const m = manifests.get(v.id)!
    const { entries, total: packTotal } = packLayout(m)
    const parts = Math.ceil(packTotal / partSize)
    const reader = packReader(root, v.id, entries)
    try {
      for (let n = 0; n < parts; n++) {
        if (io.signal.aborted) throw new CancelledError()
        const start = n * partSize
        const size = Math.min(partSize, packTotal - start)
        const name = partName(v.id, n)
        const existing = listing.byName.get(name)
        if (existing && Number(existing.size) === size) {
          doneBytes += size
          continue // finished on an earlier run
        }
        if (existing) await drive.trash(existing.id)
        io.onProgress({ current: `${plan.name} · ${v.id} · part ${n + 1} of ${parts}` })
        const base = doneBytes
        const f = await drive.uploadSlice({
          name,
          folderId,
          size,
          read: (off, buf, len) => reader.read(start + off, buf, len),
          signal: io.signal,
          onProgress: (sent) => io.onProgress({ cloudBytesDone: base + sent })
        })
        if (f.md5Checksum && f.md5Checksum !== f.localMd5) {
          await drive.trash(f.id).catch(() => undefined)
          throw new Error(`Google Drive's copy of ${name} does not match (checksum) — it will be re-sent next run.`)
        }
        doneBytes += size
        res.bytes += size
      }
    } finally {
      await reader.close()
    }
    await drive.uploadBuffer(`${v.id}.manifest.json.gz`, folderId, encodeManifest(m), listing.byName.get(`${v.id}.manifest.json.gz`)?.id)
    const info: VersionInfo = { ...v, cloud: 'complete' }
    await drive.uploadBuffer(`${v.id}.info.json`, folderId, Buffer.from(JSON.stringify(info, null, 2)))
    res.uploaded.push(v.id)
    io.onProgress({ cloudBytesDone: doneBytes })
  }
  return res
}

/** Move a set of versions' Drive files to the trash (recoverable for 30 days). */
export async function trashCloudVersions(drive: DriveClient, folderId: string, vids: string[]): Promise<number> {
  const want = new Set(vids)
  let n = 0
  for (const f of await drive.listFolder(folderId)) {
    const m = NAME_RE.exec(f.name)
    if (m && want.has(m[1])) {
      await drive.trash(f.id)
      n++
    }
  }
  return n
}

/** Info for versions that are complete in Drive (skipping ids already known locally). */
export async function cloudVersionInfos(drive: DriveClient, listing: CloudListing, skip: Set<string> = new Set()): Promise<VersionInfo[]> {
  const out: VersionInfo[] = []
  for (const vid of listing.complete) {
    if (skip.has(vid)) continue
    const f = listing.byName.get(`${vid}.info.json`)
    if (!f) continue
    try {
      const info = JSON.parse((await drive.downloadBuffer(f.id)).toString('utf8')) as VersionInfo
      out.push({ ...info, id: vid, local: false, cloud: 'complete' })
    } catch {
      /* unreadable — skip */
    }
  }
  return out
}

export async function cloudManifest(drive: DriveClient, listing: CloudListing, vid: string): Promise<Manifest> {
  const f = listing.byName.get(`${vid}.manifest.json.gz`)
  if (!f) throw new Error(`Version ${vid} is not in the Google Drive copy.`)
  return decodeManifest(await drive.downloadBuffer(f.id))
}

/* --------------------------------- restore -------------------------------- */

type Item = RestoreItem & { tmp: string }
interface Located {
  it: Item
  start: number
  end: number
}

const EMPTY_SHA256 = createHash('sha256').digest('hex')

/**
 * Restore source that pulls file bytes from the Drive copy with ranged reads,
 * coalescing neighbouring files into one request.
 */
export function cloudSource(drive: DriveClient, listing: CloudListing, getManifest: (vid: string) => Promise<Manifest>): RestoreSource {
  return {
    async fetch(items, cb, signal) {
      const groups = new Map<string, Item[]>()
      for (const it of items) {
        const list = groups.get(it.file.v) ?? []
        list.push(it)
        groups.set(it.file.v, list)
      }
      for (const [vid, group] of groups) {
        if (signal.aborted) throw new CancelledError()
        const parts = listing.files
          .filter((f) => f.name.startsWith(`${vid}.p`) && f.name.endsWith('.wkpack'))
          .sort((a, b) => a.name.localeCompare(b.name))
        let layout: Map<string, PackEntry>
        let lower: Map<string, PackEntry>
        try {
          if (!listing.complete.has(vid)) throw new Error(`Version ${vid} was never fully copied to Google Drive.`)
          const entries = packLayout(await getManifest(vid)).entries
          layout = new Map(entries.map((e) => [e.sp, e]))
          lower = new Map(entries.map((e) => [e.sp.toLowerCase(), e]))
        } catch (err) {
          for (const it of group) await cb.onDone(it, null, err)
          continue
        }
        const partSize = parts.length > 1 ? Number(parts[0].size) : Number.MAX_SAFE_INTEGER

        const located: Located[] = []
        for (const it of group) {
          const e = layout.get(it.sp) ?? lower.get(it.sp.toLowerCase())
          if (!e) {
            await cb.onDone(it, null, new Error('Not found in the Google Drive copy'))
            continue
          }
          if (e.size === 0) {
            await mkdir(dirname(it.tmp), { recursive: true })
            const ws = createWriteStream(it.tmp)
            ws.end()
            await finished(ws)
            await cb.onDone(it, EMPTY_SHA256)
            continue
          }
          located.push({ it, start: e.offset, end: e.offset + e.size })
        }
        located.sort((a, b) => a.start - b.start)

        // coalesce into runs
        const runs: Located[][] = []
        for (const l of located) {
          const run = runs[runs.length - 1]
          if (run && l.start - run[run.length - 1].end <= RANGE_GAP) run.push(l)
          else runs.push([l])
        }

        /** stream run[from..] and return the index reached (== run.length when done) */
        const streamRun = async (run: Located[], from: number): Promise<number> => {
          let idx = from
          const a = run[from].start
          const b = run[run.length - 1].end
          let pos = a
          let ws: ReturnType<typeof createWriteStream> | null = null
          let hash = createHash('sha256')
          try {
            for (let n = Math.floor(a / partSize); n * partSize < b; n++) {
              const part = parts[n]
              if (!part) throw new Error('A part of this version is missing from Google Drive.')
              const ps = n * partSize
              const rs = Math.max(pos, ps)
              const re = Math.min(b, ps + partSize)
              const stream = await drive.range(part.id, rs - ps, re - ps, signal)
              for await (const c of stream) {
                const chunk = c as Buffer
                let off = 0
                while (off < chunk.length && idx < run.length) {
                  const cur = run[idx]
                  if (pos < cur.start) {
                    const skip = Math.min(cur.start - pos, chunk.length - off)
                    off += skip
                    pos += skip
                    continue
                  }
                  if (!ws) {
                    await mkdir(dirname(cur.it.tmp), { recursive: true })
                    ws = createWriteStream(cur.it.tmp)
                    hash = createHash('sha256')
                  }
                  const take = Math.min(cur.end - pos, chunk.length - off)
                  const piece = chunk.subarray(off, off + take)
                  hash.update(piece)
                  if (!ws.write(piece)) await once(ws, 'drain')
                  cb.onBytes(take)
                  off += take
                  pos += take
                  if (pos === cur.end) {
                    ws.end()
                    await finished(ws)
                    ws = null
                    await cb.onDone(cur.it, hash.digest('hex'))
                    idx++
                  }
                }
              }
            }
            if (idx < run.length) throw new Error('Google Drive returned less data than expected')
            return idx
          } catch (err) {
            ;(ws as ReturnType<typeof createWriteStream> | null)?.destroy()
            // tell the caller which item to resume from
            throw Object.assign(err instanceof Error ? err : new Error(errText(err)), { reached: idx })
          }
        }
        // retry a failed run from the item it was in the middle of
        const fetchRun = async (run: Located[]): Promise<void> => {
          let idx = 0
          for (let attempt = 0; idx < run.length; attempt++) {
            try {
              idx = await streamRun(run, idx)
            } catch (err) {
              if (signal.aborted) throw new CancelledError()
              idx = (err as { reached?: number }).reached ?? idx
              if (idx >= run.length) return
              if (attempt >= 4) {
                for (; idx < run.length; idx++) await cb.onDone(run[idx].it, null, err)
                return
              }
              await sleep(1000 * 2 ** attempt)
            }
          }
        }
        let next = 0
        const worker = async (): Promise<void> => {
          while (next < runs.length && !signal.aborted) await fetchRun(runs[next++])
        }
        await Promise.all(Array.from({ length: Math.min(3, runs.length) }, worker))
      }
      if (signal.aborted) throw new CancelledError()
    }
  }
}

/**
 * Minimal Google Drive v3 client for File Vault (main process only).
 *
 * Hand-rolled over global fetch — the googleapis SDK is tens of MB and none of
 * it is needed for what this module does: OAuth for a desktop app (loopback
 * redirect + PKCE), chunked RESUMABLE uploads (survive network blips, no file
 * size limit), streamed downloads with Range-resume, and a handful of JSON
 * endpoints (list / find / trash / rename / about).
 *
 * The Drive API has no usage billing — only rate quotas a personal vault never
 * approaches — so everything here is $0 on top of the user's Drive plan.
 */
import { createHash, randomBytes } from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream } from 'fs'
import { open } from 'fs/promises'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { Readable } from 'stream'
import { finished } from 'stream/promises'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

/**
 * Full-drive scope so files the user drops into the vault folder from
 * drive.google.com / their phone / another PC still show up in WICKED
 * (drive.file would only see files this app created). The module still only
 * ever touches its own "WICKED Vault" folder.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

/** Chunk size for resumable uploads — must be a multiple of 256 KiB. */
const UPLOAD_CHUNK = 16 * 1024 * 1024
const MAX_RETRIES = 5
const OAUTH_TIMEOUT_MS = 5 * 60_000

const FILE_FIELDS = 'id,name,size,mimeType,md5Checksum,modifiedTime,createdTime,webViewLink'

export interface DriveFileRaw {
  id: string
  name: string
  size?: string
  mimeType: string
  md5Checksum?: string
  modifiedTime?: string
  createdTime?: string
  webViewLink?: string
}

export class DriveApiError extends Error {
  status: number
  reason: string
  constructor(status: number, reason: string, message: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

export class DriveAuthError extends Error {
  invalidGrant: boolean
  constructor(message: string, invalidGrant: boolean) {
    super(message)
    this.invalidGrant = invalidGrant
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/* --------------------------------- OAuth --------------------------------- */

/**
 * Desktop-app OAuth: spin up a one-shot loopback HTTP server on a random
 * localhost port, send the user's browser to Google's consent screen (PKCE +
 * state), catch the redirect, and exchange the code for tokens. Google's
 * recommended flow for installed apps — no client-side secret assumptions.
 */
export async function oauthAuthorize(
  clientId: string,
  clientSecret: string,
  openInBrowser: (url: string) => void
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}`

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Sign-in timed out after 5 minutes — click Connect to try again.'))
    }, OAUTH_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      server.close()
    }
    const page = (title: string, body: string): string =>
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#111;color:#eee">` +
      `<div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body></html>`
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri)
      if (u.pathname !== '/') {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const err = u.searchParams.get('error')
      const got = u.searchParams.get('code')
      if (err) {
        res.end(page('Sign-in failed', 'You can close this tab and try again from WICKED.'))
        cleanup()
        reject(new Error(`Google sign-in failed: ${err}`))
        return
      }
      if (!got || u.searchParams.get('state') !== state) {
        res.end(page('Sign-in failed', 'The response did not match this sign-in attempt. Close this tab and try again.'))
        cleanup()
        reject(new Error('Google sign-in returned an invalid response — try again.'))
        return
      }
      res.end(page('Connected ✓', 'WICKED is now connected to your Google Drive. You can close this tab.'))
      cleanup()
      resolve(got)
    })

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent', // force a refresh token even on re-consent
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    })
    openInBrowser(`${AUTH_URL}?${params.toString()}`)
  })

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
  })
  const j = (await r.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!r.ok || !j.access_token)
    throw new Error(`Google rejected the sign-in: ${j.error_description || j.error || `HTTP ${r.status}`}`)
  if (!j.refresh_token)
    throw new Error(
      'Google did not return a refresh token. Remove WICKED under myaccount.google.com → Security → Third-party access, then Connect again.'
    )
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresIn: j.expires_in ?? 3600 }
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  })
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!r.ok || !j.access_token)
    throw new DriveAuthError(
      `Could not refresh Google access: ${j.error_description || j.error || `HTTP ${r.status}`}`,
      j.error === 'invalid_grant'
    )
  return { accessToken: j.access_token, expiresIn: j.expires_in ?? 3600 }
}

/** Best-effort revoke on disconnect; failures are ignored (token dies unused). */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' })
  } catch {
    /* best-effort */
  }
}

/* ------------------------------ JSON endpoints ----------------------------- */

async function driveJson<T>(accessToken: string, method: string, pathAndQuery: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  let j: unknown = {}
  try {
    j = text ? JSON.parse(text) : {}
  } catch {
    /* non-JSON error body */
  }
  if (!r.ok) {
    const e = (j as { error?: { message?: string; errors?: { reason?: string }[] } }).error
    throw new DriveApiError(r.status, e?.errors?.[0]?.reason ?? '', e?.message || `Drive API error (HTTP ${r.status})`)
  }
  return j as T
}

/** Escape a value for a Drive query string literal. */
function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function findOrCreateFolder(token: string, name: string): Promise<string> {
  const query = encodeURIComponent(
    `name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
  )
  const res = await driveJson<{ files: { id: string }[] }>(token, 'GET', `/files?q=${query}&fields=files(id)&pageSize=1`)
  if (res.files.length > 0) return res.files[0].id
  const created = await driveJson<{ id: string }>(token, 'POST', '/files?fields=id', {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root']
  })
  return created.id
}

export async function listFolder(token: string, folderId: string): Promise<DriveFileRaw[]> {
  const files: DriveFileRaw[] = []
  let pageToken = ''
  do {
    const query = encodeURIComponent(`'${q(folderId)}' in parents and trashed = false`)
    const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)
    const res = await driveJson<{ files: DriveFileRaw[]; nextPageToken?: string }>(
      token,
      'GET',
      `/files?q=${query}&fields=${fields}&pageSize=1000&orderBy=name${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    )
    files.push(...res.files)
    pageToken = res.nextPageToken ?? ''
  } while (pageToken)
  return files
}

export async function findByName(token: string, folderId: string, name: string): Promise<DriveFileRaw | null> {
  const query = encodeURIComponent(`name = '${q(name)}' and '${q(folderId)}' in parents and trashed = false`)
  const fields = encodeURIComponent(`files(${FILE_FIELDS})`)
  const res = await driveJson<{ files: DriveFileRaw[] }>(token, 'GET', `/files?q=${query}&fields=${fields}&pageSize=1`)
  return res.files[0] ?? null
}

export function getFileMeta(token: string, fileId: string): Promise<DriveFileRaw> {
  return driveJson<DriveFileRaw>(token, 'GET', `/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`)
}

/** Move to Drive's trash (recoverable for ~30 days) — never a hard delete. */
export function trashFile(token: string, fileId: string): Promise<unknown> {
  return driveJson(token, 'PATCH', `/files/${encodeURIComponent(fileId)}`, { trashed: true })
}

export function renameFile(token: string, fileId: string, name: string): Promise<unknown> {
  return driveJson(token, 'PATCH', `/files/${encodeURIComponent(fileId)}`, { name })
}

export async function about(token: string): Promise<{ email: string; usage: number; limit: number }> {
  const res = await driveJson<{
    user?: { emailAddress?: string }
    storageQuota?: { usage?: string; limit?: string }
  }>(token, 'GET', '/about?fields=user(emailAddress),storageQuota(usage,limit)')
  return {
    email: res.user?.emailAddress ?? '',
    usage: Number(res.storageQuota?.usage ?? 0),
    limit: Number(res.storageQuota?.limit ?? 0)
  }
}

/* ------------------------------ resumable upload --------------------------- */

export interface UploadOpts {
  localPath: string
  size: number
  name: string
  folderId: string
  /** replace this existing vault file's content (Drive keeps the old version ~30 days) */
  existingFileId?: string
  getToken: () => Promise<string>
  signal: AbortSignal
  onProgress: (sentBytes: number) => void
}

/**
 * Chunked resumable upload: 16 MB chunks, retry with exponential backoff, and
 * a `bytes *\/total` probe to re-sync the committed offset after a network
 * blip. No file size limit — Drive itself caps at 5 TB per file.
 */
export async function resumableUpload(opts: UploadOpts): Promise<DriveFileRaw> {
  const { localPath, size, name, folderId, existingFileId, getToken, signal, onProgress } = opts

  const initSession = async (): Promise<string> => {
    const token = await getToken()
    const url = existingFileId
      ? `${UPLOAD_API}/files/${encodeURIComponent(existingFileId)}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`
      : `${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`
    const r = await fetch(url, {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size)
      },
      body: JSON.stringify(existingFileId ? {} : { name, parents: [folderId] }),
      signal
    })
    if (!r.ok) throw new Error(`Could not start the upload (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`)
    const loc = r.headers.get('location')
    if (!loc) throw new Error('Drive did not return an upload session URL')
    return loc
  }

  /** Where does the server think we are? (also detects a finished upload) */
  const probe = async (session: string): Promise<{ offset: number; file?: DriveFileRaw } | null> => {
    try {
      const r = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, signal })
      if (r.status === 308) {
        const range = r.headers.get('range') // "bytes=0-N"
        return { offset: range ? Number(range.split('-')[1]) + 1 : 0 }
      }
      if (r.ok) return { offset: size, file: (await r.json()) as DriveFileRaw }
    } catch {
      /* fall through to null — caller keeps its own offset */
    }
    return null
  }

  let session = await initSession()

  // Zero-byte file: a single empty finalizing PUT.
  if (size === 0) {
    const r = await fetch(session, { method: 'PUT', headers: { 'Content-Length': '0' }, body: new Uint8Array(0), signal })
    if (!r.ok) throw new Error(`Upload failed (HTTP ${r.status})`)
    return (await r.json()) as DriveFileRaw
  }

  const fh = await open(localPath, 'r')
  try {
    let offset = 0
    let attempts = 0
    let restarted = false
    const buf = Buffer.allocUnsafe(Math.min(UPLOAD_CHUNK, size))
    for (;;) {
      if (signal.aborted) throw new Error('cancelled')
      const len = Math.min(UPLOAD_CHUNK, size - offset)
      const { bytesRead } = await fh.read(buf, 0, len, offset)
      if (bytesRead <= 0) throw new Error('The file changed on disk while uploading — try again.')

      let r: Response
      try {
        // Chunk PUTs go to the (already-authorized) session URL — no auth
        // header needed, so an access token expiring mid-file can't 401 us.
        r = await fetch(session, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${offset + bytesRead - 1}/${size}` },
          body: buf.subarray(0, bytesRead),
          signal
        })
      } catch (err) {
        if (signal.aborted) throw new Error('cancelled')
        if (++attempts > MAX_RETRIES) throw err
        await sleep(1000 * 2 ** attempts)
        const p = await probe(session)
        if (p?.file) return p.file
        if (p) offset = p.offset
        continue
      }

      if (r.status === 308) {
        const range = r.headers.get('range')
        offset = range ? Number(range.split('-')[1]) + 1 : offset + bytesRead
        attempts = 0
        onProgress(offset)
        continue
      }
      if (r.ok) {
        onProgress(size)
        return (await r.json()) as DriveFileRaw
      }
      if (r.status === 404 && !restarted) {
        // session expired (kept idle > a week) — start over once
        restarted = true
        session = await initSession()
        offset = 0
        onProgress(0)
        continue
      }
      if (r.status >= 500) {
        if (++attempts > MAX_RETRIES) throw new Error(`Upload failed (HTTP ${r.status}) after ${MAX_RETRIES} retries`)
        await sleep(1000 * 2 ** attempts)
        const p = await probe(session)
        if (p?.file) return p.file
        if (p) offset = p.offset
        continue
      }
      throw new Error(`Upload failed (HTTP ${r.status}): ${(await r.text()).slice(0, 300)}`)
    }
  } finally {
    await fh.close()
  }
}

/* -------------------------------- download -------------------------------- */

export interface DownloadOpts {
  fileId: string
  /** temp file to stream into (caller renames after verification) */
  destPart: string
  getToken: () => Promise<string>
  signal: AbortSignal
  onProgress: (doneBytes: number) => void
}

/**
 * Streamed download with Range-resume across retries. Handles Drive's
 * "abusive file" gate for executables: retried once with acknowledgeAbuse
 * (fine — it's the user's own file).
 */
export async function downloadToFile(opts: DownloadOpts): Promise<void> {
  const { fileId, destPart, getToken, signal, onProgress } = opts
  let written = 0
  let acknowledgeAbuse = false
  let attempts = 0

  for (;;) {
    if (signal.aborted) throw new Error('cancelled')
    const token = await getToken()
    const url = `${API}/files/${encodeURIComponent(fileId)}?alt=media${acknowledgeAbuse ? '&acknowledgeAbuse=true' : ''}`

    let res: Response
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, ...(written > 0 ? { Range: `bytes=${written}-` } : {}) },
        signal
      })
    } catch (err) {
      if (signal.aborted) throw new Error('cancelled')
      if (++attempts > MAX_RETRIES) throw err
      await sleep(1000 * 2 ** attempts)
      continue
    }

    if (res.status === 403) {
      const text = await res.text()
      if (!acknowledgeAbuse && /cannotDownloadAbusiveFile/i.test(text)) {
        // Drive flags many legit executables; the owner may bypass explicitly.
        acknowledgeAbuse = true
        continue
      }
      throw new Error(`Drive refused the download (HTTP 403): ${text.slice(0, 300)}`)
    }
    if (res.status === 416) return // requested past EOF — everything is already on disk
    if (!res.ok && res.status !== 206) {
      const retriable = res.status >= 500 || res.status === 429
      if (retriable && ++attempts <= MAX_RETRIES) {
        await sleep(1000 * 2 ** attempts)
        continue
      }
      throw new Error(`Download failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`)
    }
    if (res.status !== 206) written = 0 // server ignored our Range — restart the file
    if (!res.body) throw new Error('Download returned no data stream')

    const ws = createWriteStream(destPart, { flags: written > 0 ? 'a' : 'w' })
    try {
      const body = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream<Uint8Array>)
      for await (const chunk of body) {
        const c = chunk as Buffer
        if (!ws.write(c)) await once(ws, 'drain')
        written += c.length
        onProgress(written)
      }
      ws.end()
      await finished(ws)
      return
    } catch (err) {
      ws.destroy()
      if (signal.aborted) throw new Error('cancelled')
      if (++attempts > MAX_RETRIES) throw err
      await sleep(1000 * 2 ** attempts)
      // `written` survives — the next request resumes with a Range header
    }
  }
}

/* --------------------------------- hashing --------------------------------- */

/** Streaming MD5 of a local file (matches Drive's md5Checksum). */
export function md5File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c as Buffer))
    rs.on('error', reject)
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

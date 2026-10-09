/**
 * "Download to Google Drive" — main only.
 *
 * yt-dlp has to write real files (it merges streams and embeds tags + cover
 * art in place), so a Drive job downloads into a per-job STAGING folder in the
 * OS temp dir. Every item is handed to this sink the moment yt-dlp finishes it
 * (`--print-to-file after_move:filepath`), uploaded through File Vault's Drive
 * connection into `WICKED Vault/YouTube Downloads/<same sub-folders a local
 * download would get>`, MD5-verified against Drive's checksum, and deleted
 * locally — so staging only ever holds the item(s) in flight.
 *
 * Drive calls are injected (DriveDeps) so this is testable without Electron.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'path'
import type { DriveFileRaw } from '../../file-vault/ipc/gdrive'

/** top-level folder inside the vault */
export const DRIVE_ROOT_NAME = 'YouTube Downloads'
const ATTEMPTS = 3
const FOLDER_URL = (id: string): string => `https://drive.google.com/drive/folders/${id}`

/** yt-dlp scratch / sidecars that never go to Drive */
const SKIP_EXT = new Set(['.part', '.ytdl', '.txt', '.json', '.jpg', '.jpeg', '.png', '.webp', '.temp', '.tmp', '.vtt', '.srt', '.description'])
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

export interface DriveDeps {
  getToken: () => Promise<string>
  vaultFolderId: () => Promise<string>
  findOrCreateSubfolder: (token: string, name: string, parentId: string) => Promise<string>
  findByName: (token: string, folderId: string, name: string) => Promise<DriveFileRaw | null>
  upload: (o: { localPath: string; size: number; name: string; folderId: string; existingFileId?: string; signal: AbortSignal; onProgress: (sent: number) => void }) => Promise<DriveFileRaw>
  md5File: (path: string) => Promise<string>
}

export interface DriveProgress {
  uploaded: number
  failed: number
  /** waiting + in flight */
  pending: number
  current: string | null
  percent: number
  bytes: number
  folderUrl: string | null
}

/** True for a finished media file worth uploading (not scratch, sidecar or our own lists). */
export function isUploadable(path: string): boolean {
  const name = basename(path)
  if (name.startsWith('.')) return false
  if (/\.part-Frag\d+/i.test(name) || /\.f\d+\.\w+$/i.test(name)) return false // unmerged format pieces
  return !SKIP_EXT.has(extname(name).toLowerCase())
}

/** Every uploadable file left under `dir` (recursive). */
export function leftoverMedia(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (isUploadable(p)) out.push(p)
      } catch {
        /* vanished */
      }
    }
  }
  walk(dir)
  return out.sort()
}

/** Lines of yt-dlp's `--print-to-file` list (final paths), in order. */
export function readDoneList(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export class DriveSink {
  private queue: string[] = []
  private seen = new Set<string>()
  private running = false
  private idle: (() => void)[] = []
  private ctl = new AbortController()
  /** staging-relative dir ('' = root) → Drive folder id */
  private folders = new Map<string, string>()
  private current: string | null = null
  private percent = 0
  private bytes = 0
  private topFolderId: string | null = null
  /** music is filed <Artist>/… — "Open in Drive" shows YouTube Downloads itself, not the first artist */
  openRoot = false
  readonly uploaded: { path: string; name: string; id: string }[] = []
  readonly failed: { path: string; error: string }[] = []

  constructor(
    private stagingDir: string,
    private deps: DriveDeps,
    private onProgress: (p: DriveProgress) => void,
    private wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  get aborted(): boolean {
    return this.ctl.signal.aborted
  }

  /** Queue a finished file (ignored if already queued, already uploaded + removed, or not media). */
  add(path: string): void {
    if (this.aborted || this.seen.has(path) || !isUploadable(path) || !existsSync(path)) return
    this.seen.add(path)
    this.queue.push(path)
    this.emit()
    void this.pump()
  }

  /** Resolves once everything queued so far is uploaded (or failed). */
  drain(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise((r) => this.idle.push(r))
  }

  abort(): void {
    this.ctl.abort()
    this.queue = []
    this.flushIdle()
  }

  progress(): DriveProgress {
    return {
      uploaded: this.uploaded.length,
      failed: this.failed.length,
      pending: this.queue.length + (this.current ? 1 : 0),
      current: this.current,
      percent: this.percent,
      bytes: this.bytes,
      folderUrl: this.topFolderId && !this.openRoot ? FOLDER_URL(this.topFolderId) : this.folders.has('') ? FOLDER_URL(this.folders.get('')!) : null
    }
  }

  private emit(): void {
    this.onProgress(this.progress())
  }

  private flushIdle(): void {
    const w = this.idle
    this.idle = []
    for (const r of w) r()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.aborted) await this.uploadOne(this.queue.shift()!)
    } finally {
      this.running = false
      this.current = null
      this.percent = 0
      if (!this.aborted) this.emit()
      this.flushIdle()
    }
  }

  private relDir(path: string): string[] {
    const rel = relative(this.stagingDir, dirname(path))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return []
    return rel.split(sep).filter(Boolean)
  }

  private async folderFor(token: string, parts: string[]): Promise<string> {
    let key = ''
    let id = this.folders.get('')
    if (!id) {
      id = await this.deps.findOrCreateSubfolder(token, DRIVE_ROOT_NAME, await this.deps.vaultFolderId())
      this.folders.set('', id)
    }
    for (const part of parts) {
      key = key ? `${key}/${part}` : part
      let next = this.folders.get(key)
      if (!next) {
        next = await this.deps.findOrCreateSubfolder(token, part, id)
        this.folders.set(key, next)
      }
      id = next
    }
    // the playlist/album folder is what "Open in Drive" should show
    if (parts.length && !this.topFolderId) this.topFolderId = this.folders.get(parts[0]) ?? null
    return id
  }

  private async uploadOne(path: string): Promise<void> {
    const name = basename(path)
    for (let attempt = 1; ; attempt++) {
      if (this.aborted) return
      try {
        const size = statSync(path).size
        const token = await this.deps.getToken()
        const folderId = await this.folderFor(token, this.relDir(path))
        // a resumed job may re-send a file that made it up before a crash —
        // replace it in place instead of creating "name (1)"
        const existing = await this.deps.findByName(token, folderId, name)
        this.current = name
        this.percent = 0
        this.emit()
        const file = await this.deps.upload({
          localPath: path,
          size,
          name,
          folderId,
          existingFileId: existing?.id,
          signal: this.ctl.signal,
          onProgress: (sent) => {
            this.percent = size > 0 ? Math.min(100, (sent / size) * 100) : 100
            this.emit()
          }
        })
        if (file.md5Checksum && (await this.deps.md5File(path)) !== file.md5Checksum)
          throw new Error('Checksum mismatch — the copy on Drive does not match the downloaded file.')
        this.uploaded.push({ path, name, id: file.id })
        this.bytes += size
        this.removeLocal(path)
        return
      } catch (err) {
        if (this.aborted) return
        if ((err as { status?: number }).status === 404) this.folders.clear() // folder deleted in Drive meanwhile
        if (attempt >= ATTEMPTS || !existsSync(path)) {
          this.failed.push({ path, error: err instanceof Error ? err.message : String(err) })
          return
        }
        await this.wait(2000 * attempt)
      }
    }
  }

  /** The uploaded file plus its same-name sidecars (cover-art thumbnail). */
  private removeLocal(path: string): void {
    rmSync(path, { force: true })
    const stem = basename(path, extname(path))
    try {
      for (const n of readdirSync(dirname(path)))
        if (n.startsWith(`${stem}.`) && IMAGE_EXT.has(extname(n).toLowerCase())) rmSync(join(dirname(path), n), { force: true })
    } catch {
      /* staging is removed at the end anyway */
    }
  }
}

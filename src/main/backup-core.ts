import AdmZip from 'adm-zip'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join, resolve, sep } from 'path'

/**
 * Pure / boot-time half of Backup & Restore — deliberately free of any
 * `electron-store` (settings) import so it can run at the EARLIEST point of
 * startup (paths.ts) without constructing the settings store before a staged
 * restore has been applied. The settings-aware half lives in backup.ts.
 *
 * These functions take a root/dest dir as an argument (no Electron `app`), so
 * they're unit-testable outside Electron.
 */

export const BACKUP_PREFIX = 'WICKED-Backup-'
export const BACKUP_EXT = '.zip'
export const MANIFEST_NAME = 'wicked-backup.json'
export const MANIFEST_MAGIC = 'wicked-suite-backup'
export const PENDING_MARKER = '.wicked-pending-restore'
export const STAGED_ZIP = '.wicked-restore-staged.zip'
/** Password-encrypted, portable copy of the API-key vault, stored inside a backup zip. */
export const PORTABLE_KEYS_NAME = 'wicked-keys-portable.json'
/** Machine-B-re-encrypted key vault staged at restore time; moved into place on boot. */
export const RESTORED_KEYS_STAGE = '.wicked-keys-restored.json'

/** Top-level userData entries to include (files or directories). */
export const INCLUDE_TOP = new Set([
  'wicked-settings.json',
  'wicked-modules.json',
  'wicked-keys.json',
  'module-codelens.json', // codelens' private store — the one module store outside wicked-modules.json
  'modules',
  'IndexedDB',
  'Local Storage'
])

/** Paths (relative to userData, '/'-joined) whose subtree is never backed up. */
export const EXCLUDE_RELPATHS = new Set([
  'modules/web-browser/chrome-profile', // full Chrome profile: huge, Chrome-sync owned
  'modules/yt-downloader/bin', // yt-dlp binary: ~20 MB, machine-local, refetched on demand
  'modules/file-vault/auth.json' // Google OAuth secrets: DPAPI-bound to this PC/user, must never travel in a snapshot
])

/**
 * Basenames (file or directory) that are never backed up, wherever they appear.
 * Guards against transient scratch data: yt-downloader's ffmpeg combine scratch
 * can be GIGABYTES if a combine was interrupted, and once made the sync snapshot
 * exceed Node's max string length ("Cannot create a string longer than …").
 */
export const EXCLUDE_NAME_PATTERNS: RegExp[] = [/^combine-tmp/, /^combine-manifest-/, /\.tmp$/i]

/**
 * Files bigger than this are skipped (with a console note). Settings + module
 * data are small; anything this big in userData is transient media that has no
 * business inside a backup/sync snapshot.
 */
export const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024

export interface BackupEntry {
  /** absolute path on disk */
  abs: string
  /** forward-slash path stored inside the zip (relative to userData) */
  rel: string
}

export interface BackupManifest {
  magic: string
  version: number
  createdUtc: string
  appVersion: string
  fileCount: number
  /** rel paths that were dropped from this backup (oversized) — shown to the user */
  skipped?: string[]
}

function relKey(rel: string): string {
  return rel.replace(/\\/g, '/')
}

/**
 * Walk `root` and return the files to back up. Include/exclude are applied by
 * name so this is fully testable with a fake root dir. Oversized files are
 * dropped but RECORDED into `skippedOut` — a backup that silently omits data
 * while reporting success is worse than no backup.
 */
export function collectEntries(
  root: string,
  includeTop: Set<string> = INCLUDE_TOP,
  excludeRel: Set<string> = EXCLUDE_RELPATHS,
  skippedOut?: string[]
): BackupEntry[] {
  const out: BackupEntry[] = []
  const walk = (abs: string, rel: string): void => {
    if (excludeRel.has(relKey(rel))) return
    const base = relKey(rel).split('/').pop() ?? rel
    if (EXCLUDE_NAME_PATTERNS.some((p) => p.test(base))) return
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      return // vanished / unreadable
    }
    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = readdirSync(abs)
      } catch {
        return
      }
      for (const name of entries) walk(join(abs, name), rel ? `${rel}/${name}` : name)
    } else if (st.isFile()) {
      if (st.size > MAX_BACKUP_FILE_BYTES) {
        console.warn(`[wicked] backup: skipping oversized file (${Math.round(st.size / 1048576)} MB): ${relKey(rel)}`)
        skippedOut?.push(`${relKey(rel)} (${Math.round(st.size / 1048576)} MB)`)
        return
      }
      out.push({ abs, rel: relKey(rel) })
    }
  }
  for (const top of includeTop) {
    const abs = join(root, top)
    if (existsSync(abs)) walk(abs, top)
  }
  return out
}

/**
 * Build the zip in memory and write it to `outFile` atomically (.tmp+rename).
 * `extraFiles` are in-memory virtual entries (e.g. the portable key blob).
 */
export function writeBackupZip(
  entries: BackupEntry[],
  outFile: string,
  appVersion: string,
  extraFiles: { rel: string; data: string }[] = [],
  skipped: string[] = []
): number {
  const zip = new AdmZip()
  let count = 0
  for (const e of entries) {
    try {
      zip.addFile(e.rel, readFileSync(e.abs))
      count++
    } catch {
      // a single unreadable/locked file must not fail the whole backup
      skipped.push(`${e.rel} (unreadable)`)
    }
  }
  for (const ex of extraFiles) {
    zip.addFile(ex.rel, Buffer.from(ex.data, 'utf8'))
    count++
  }
  const manifest: BackupManifest = {
    magic: MANIFEST_MAGIC,
    version: 1,
    createdUtc: new Date().toISOString(),
    appVersion,
    fileCount: count,
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 50) } : {})
  }
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  const tmp = outFile + '.tmp'
  zip.writeZip(tmp)
  renameSync(tmp, outFile)
  return count
}

/**
 * Build the same backup zip as writeBackupZip but return it as an in-memory
 * Buffer (used by Cloud Sync, which encrypts the bytes and uploads them rather
 * than writing a .zip to disk).
 */
export function buildBackupZipBuffer(
  entries: BackupEntry[],
  appVersion: string,
  extraFiles: { rel: string; data: string }[] = [],
  skipped: string[] = []
): Buffer {
  const zip = new AdmZip()
  let count = 0
  for (const e of entries) {
    try {
      zip.addFile(e.rel, readFileSync(e.abs))
      count++
    } catch {
      // a single unreadable/locked file must not fail the whole snapshot
      skipped.push(`${e.rel} (unreadable)`)
    }
  }
  for (const ex of extraFiles) {
    zip.addFile(ex.rel, Buffer.from(ex.data, 'utf8'))
    count++
  }
  const manifest: BackupManifest = {
    magic: MANIFEST_MAGIC,
    version: 1,
    createdUtc: new Date().toISOString(),
    appVersion,
    fileCount: count,
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 50) } : {})
  }
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  return zip.toBuffer()
}

/** Read+validate a backup's manifest, or null if it isn't one of ours. */
export function readManifest(zipFile: string): BackupManifest | null {
  try {
    const zip = new AdmZip(zipFile)
    const entry = zip.getEntry(MANIFEST_NAME)
    if (!entry) return null
    const parsed = JSON.parse(zip.readAsText(entry)) as BackupManifest
    return parsed && parsed.magic === MANIFEST_MAGIC ? parsed : null
  } catch {
    return null
  }
}

/** Read one text entry from a backup zip (e.g. the portable key blob), or null. */
export function readZipTextEntry(zipFile: string, name: string): string | null {
  try {
    const zip = new AdmZip(zipFile)
    const entry = zip.getEntry(name)
    return entry ? zip.readAsText(entry) : null
  } catch {
    return null
  }
}

/**
 * Extract a validated backup zip into `destRoot`. Path-traversal safe: any entry
 * whose resolved target escapes destRoot is skipped. The manifest file itself is
 * not written back out.
 */
export function extractZipTo(zipFile: string, destRoot: string): number {
  const zip = new AdmZip(zipFile)
  const rootResolved = resolve(destRoot)
  let count = 0
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (entry.entryName === MANIFEST_NAME) continue
    // the portable key blob is handled separately at restore time, never written to disk
    if (entry.entryName === PORTABLE_KEYS_NAME) continue
    const target = resolve(destRoot, entry.entryName)
    if (target !== rootResolved && !target.startsWith(rootResolved + sep)) continue // traversal guard
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, entry.getData())
    count++
  }
  return count
}

/**
 * Apply a staged restore (called from paths.ts at the earliest point of
 * startup — before any store or renderer/IndexedDB opens). No-op if none.
 */
export function applyPendingRestore(userData: string): void {
  try {
    const marker = join(userData, PENDING_MARKER)
    if (!existsSync(marker)) return
    const staged = join(userData, STAGED_ZIP)
    const clearStaging = (): void => {
      rmSync(staged, { force: true })
      rmSync(marker, { force: true })
      rmSync(join(userData, RESTORED_KEYS_STAGE), { force: true })
    }
    if (!existsSync(staged) || !readManifest(staged)) {
      console.error('[wicked] pending restore marker found but staged backup was missing/invalid')
      clearStaging()
      return
    }
    try {
      const n = extractZipTo(staged, userData)
      // If a portable key set was unlocked at restore time, it was re-encrypted
      // for THIS machine and staged; move it in AFTER extraction so it wins over
      // the (machine-A, un-decryptable) wicked-keys.json inside the backup.
      const restoredKeys = join(userData, RESTORED_KEYS_STAGE)
      if (existsSync(restoredKeys)) {
        renameSync(restoredKeys, join(userData, 'wicked-keys.json'))
        console.log('[wicked] applied portable API keys from backup')
      }
      console.log(`[wicked] applied pending restore: ${n} file(s) from backup`)
      clearStaging()
    } catch (err) {
      // A FAILED extract (disk full, AV lock, power loss) leaves userData mixed
      // old/new — keep the staged zip so the next boot RETRIES instead of
      // booting half-restored with the only copy deleted. Give up after 3 tries
      // so a genuinely bad zip can't wedge every launch.
      let attempts = 0
      try {
        attempts = Number((JSON.parse(readFileSync(marker, 'utf8')) as { attempts?: number }).attempts) || 0
      } catch {
        /* marker unreadable → treat as first attempt */
      }
      if (attempts + 1 >= 3) {
        console.error('[wicked] restore failed 3 times — clearing staging:', err)
        clearStaging()
      } else {
        try {
          const prev = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>
          writeFileSync(marker, JSON.stringify({ ...prev, attempts: attempts + 1 }, null, 2), 'utf8')
        } catch {
          writeFileSync(marker, JSON.stringify({ attempts: attempts + 1 }, null, 2), 'utf8')
        }
        console.error(`[wicked] restore extract failed (attempt ${attempts + 1}/3) — will retry next launch:`, err)
      }
    }
  } catch (err) {
    console.error('[wicked] applyPendingRestore failed (non-fatal):', err)
  }
}

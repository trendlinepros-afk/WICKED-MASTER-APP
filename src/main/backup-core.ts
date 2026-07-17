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

/** Top-level userData entries to include (files or directories). */
export const INCLUDE_TOP = new Set([
  'wicked-settings.json',
  'wicked-modules.json',
  'wicked-keys.json',
  'modules',
  'IndexedDB',
  'Local Storage'
])

/** Paths (relative to userData, '/'-joined) whose subtree is never backed up. */
export const EXCLUDE_RELPATHS = new Set([
  'modules/web-browser/chrome-profile' // full Chrome profile: huge, Chrome-sync owned
])

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
}

function relKey(rel: string): string {
  return rel.replace(/\\/g, '/')
}

/**
 * Walk `root` and return the files to back up. Include/exclude are applied by
 * name so this is fully testable with a fake root dir.
 */
export function collectEntries(
  root: string,
  includeTop: Set<string> = INCLUDE_TOP,
  excludeRel: Set<string> = EXCLUDE_RELPATHS
): BackupEntry[] {
  const out: BackupEntry[] = []
  const walk = (abs: string, rel: string): void => {
    if (excludeRel.has(relKey(rel))) return
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
      out.push({ abs, rel: relKey(rel) })
    }
  }
  for (const top of includeTop) {
    const abs = join(root, top)
    if (existsSync(abs)) walk(abs, top)
  }
  return out
}

/** Build the zip in memory and write it to `outFile` atomically (.tmp+rename). */
export function writeBackupZip(entries: BackupEntry[], outFile: string, appVersion: string): number {
  const zip = new AdmZip()
  let count = 0
  for (const e of entries) {
    try {
      zip.addFile(e.rel, readFileSync(e.abs))
      count++
    } catch {
      // a single unreadable/locked file must not fail the whole backup
    }
  }
  const manifest: BackupManifest = {
    magic: MANIFEST_MAGIC,
    version: 1,
    createdUtc: new Date().toISOString(),
    appVersion,
    fileCount: count
  }
  zip.addFile(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'))
  const tmp = outFile + '.tmp'
  zip.writeZip(tmp)
  renameSync(tmp, outFile)
  return count
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
    try {
      if (existsSync(staged) && readManifest(staged)) {
        const n = extractZipTo(staged, userData)
        console.log(`[wicked] applied pending restore: ${n} file(s) from backup`)
      } else {
        console.error('[wicked] pending restore marker found but staged backup was missing/invalid')
      }
    } finally {
      // Always clear staging so a bad backup can't wedge every launch.
      rmSync(staged, { force: true })
      rmSync(marker, { force: true })
    }
  } catch (err) {
    console.error('[wicked] applyPendingRestore failed (non-fatal):', err)
  }
}

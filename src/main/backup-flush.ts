/**
 * Pre-backup flush registry. Modules that hold OPEN write handles (WAL-mode
 * SQLite databases above all) register a flush callback via
 * ctx.onBackupFlush(); Backup and Cloud Sync run every callback immediately
 * before collecting files, so the on-disk state is consistent when it is read.
 * Callbacks must be synchronous and cheap (e.g. `PRAGMA wal_checkpoint`).
 */

const flushes: Array<() => void> = []

export function onBackupFlush(fn: () => void): void {
  flushes.push(fn)
}

/** Run every registered flush; one failing module must not block the backup. */
export function runBackupFlushes(): void {
  for (const fn of flushes) {
    try {
      fn()
    } catch (err) {
      console.warn('[wicked] pre-backup flush failed (continuing):', err)
    }
  }
}

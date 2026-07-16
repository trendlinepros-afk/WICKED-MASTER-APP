import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import { cpSync, existsSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import {
  SHELL_IPC,
  type RecoveryCandidate,
  type RecoveryResult,
  type RecoveryScan
} from '@shared/types'

/**
 * "Restore data from a previous version" (Settings → Data & Recovery).
 *
 * Older builds stored userData at %APPDATA%\WICKED before it was pinned to
 * %APPDATA%\WICKED-Suite; updating across that rename orphaned the user's
 * settings, nav/menu order and per-module data at the old path. paths.ts
 * recovers this automatically on a FRESH install, but once the user has started
 * reconfiguring we must not silently overwrite their work — so this feature lets
 * them restore deliberately, with the current data backed up first.
 *
 * Only the WICKED shell's own artifacts are ever touched:
 *   wicked-settings.json, wicked-modules.json, modules/
 * gated on the settings marker so we never adopt unrelated data that happened to
 * share the old folder name (the standalone chat app used %APPDATA%\Wicked).
 */

const ARTIFACTS = ['wicked-settings.json', 'wicked-modules.json', 'modules'] as const
const SETTINGS_MARKER = 'wicked-settings.json'

/**
 * Canonical, comparable form of a path. Windows filesystems are case-insensitive
 * (so `...\wicked-suite` and `...\WICKED-Suite` are the SAME folder), and a path
 * may differ only by case or short-name; realpath + lowercase collapses those so
 * we never mistake the current data folder for an old one and try to copy it
 * onto itself.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase()
  } catch {
    return path.toLowerCase()
  }
}

function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b)
}

function inspectCandidate(path: string): RecoveryCandidate | null {
  try {
    if (!existsSync(join(path, SETTINGS_MARKER))) return null
    let moduleIds: string[] = []
    const modulesDir = join(path, 'modules')
    if (existsSync(modulesDir)) {
      moduleIds = readdirSync(modulesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    }
    return { path, hasSettings: true, moduleCount: moduleIds.length, moduleIds }
  } catch {
    return null
  }
}

function scan(extraPath?: string): RecoveryScan {
  const currentPath = app.getPath('userData')
  const appData = app.getPath('appData')
  const candidates: RecoveryCandidate[] = []
  // Exclude the current data folder up front, by canonical path — so a different
  // casing of the same folder can never be offered as a restore source.
  const seen = new Set<string>([canonical(currentPath)])

  const consider = (path: string): void => {
    if (!path) return
    const canon = canonical(path)
    if (seen.has(canon)) return
    seen.add(canon)
    const c = inspectCandidate(path)
    if (c) candidates.push(c)
  }

  // A user-picked folder is considered as-is.
  if (extraPath) consider(extraPath)

  // Find a previous version's data by its marker file, under ANY folder name in
  // %APPDATA% — earlier builds may have used a different name, so don't guess.
  try {
    for (const entry of readdirSync(appData, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(join(appData, entry.name))
    }
  } catch {
    /* appData unreadable — just return whatever we have */
  }

  return {
    currentPath,
    currentHasSettings: existsSync(join(currentPath, SETTINGS_MARKER)),
    candidates
  }
}

/** timestamp like 20260716-193342 (local time), for backup folder names. */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function registerRecoveryIpc(getWin: () => BrowserWindow | null): void {
  ipcMain.handle(SHELL_IPC.recoveryScan, (): RecoveryScan => scan())

  ipcMain.handle(SHELL_IPC.recoveryPick, async (): Promise<RecoveryScan> => {
    const win = getWin()
    const opts = {
      title: 'Choose a previous WICKED data folder',
      properties: ['openDirectory' as const],
      defaultPath: app.getPath('appData')
    }
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return scan()
    return scan(res.filePaths[0])
  })

  ipcMain.handle(
    SHELL_IPC.recoveryRestore,
    async (_e, sourcePathRaw: unknown): Promise<RecoveryResult> => {
      const sourcePath = String(sourcePathRaw ?? '')
      const currentPath = app.getPath('userData')

      if (!sourcePath || !isDirSafe(sourcePath))
        return { ok: false, error: 'That folder no longer exists.' }
      // Compare by real path: on Windows `wicked-suite` and `WICKED-Suite` are
      // the same folder, and copying it onto itself throws "src and dest cannot
      // be the same".
      if (samePath(sourcePath, currentPath))
        return { ok: false, error: 'That is the current data folder — nothing to restore.' }
      if (!existsSync(join(sourcePath, SETTINGS_MARKER)))
        return { ok: false, error: 'That folder has no WICKED settings to restore.' }

      const win = getWin()
      const backupDir = join(currentPath, `_pre-restore-backup-${stamp()}`)

      // Confirm destructively-adjacent action with the user (native dialog).
      const confirmOpts = {
        type: 'warning' as const,
        buttons: ['Restore & Restart', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Restore previous data',
        message: 'Restore your settings and app data from the previous version?',
        detail:
          `From:  ${sourcePath}\n` +
          `Into:   ${currentPath}\n\n` +
          `Your current settings, nav order and module data will be replaced with the ` +
          `previous version's. A backup of the current data is saved first to:\n${backupDir}\n\n` +
          `WICKED will restart to load the restored data.`
      }
      const confirm = win
        ? await dialog.showMessageBox(win, confirmOpts)
        : await dialog.showMessageBox(confirmOpts)
      if (confirm.response !== 0) return { ok: false, canceled: true }

      const restored: string[] = []
      try {
        // 1) Back up whatever the current install has, so this is reversible.
        for (const item of ARTIFACTS) {
          const from = join(currentPath, item)
          if (existsSync(from))
            cpSync(from, join(backupDir, item), { recursive: true, errorOnExist: false })
        }
        // 2) Overwrite current artifacts with the previous version's.
        for (const item of ARTIFACTS) {
          const from = join(sourcePath, item)
          if (existsSync(from)) {
            cpSync(from, join(currentPath, item), { recursive: true, force: true })
            restored.push(item)
          }
        }
      } catch (err) {
        return {
          ok: false,
          error:
            'Restore failed: ' +
            (err instanceof Error ? err.message : String(err)) +
            (existsSync(backupDir) ? ` (current data backed up to ${backupDir})` : '')
        }
      }

      // 3) Relaunch so every store reloads from the restored files (avoids any
      //    in-memory settings being written back over what we just restored).
      app.relaunch()
      app.exit(0)
      return { ok: true, backupPath: backupDir, restored }
    }
  )
}

import { app } from 'electron'
import { cpSync, existsSync } from 'fs'
import { join } from 'path'

// Must run before anything (electron-store, modules) touches userData.
//
// userData is PINNED to a fixed, version-independent folder so it never moves
// between app updates — the settings, module data, API-key vault and per-module
// databases all live here and must survive every update. Do not derive this
// from app name/version. The default would be %APPDATA%\wicked, which also
// collides case-insensitively with the old standalone chat app's %APPDATA%\Wicked.
const appData = app.getPath('appData')
const userData = join(appData, 'WICKED-Suite')
app.setPath('userData', userData)

/**
 * One-time, NON-DESTRUCTIVE recovery of user data orphaned by an older build.
 *
 * Before userData was pinned above, Electron stored it at %APPDATA%\WICKED
 * (from the productName). Updating across that rename left a user's settings,
 * nav/menu order and per-module data (AI Chat vault path, DBs, …) stranded at
 * the old path — the app looked "reset". This copies those artifacts forward
 * the first time the pinned folder has no shell settings yet.
 *
 * Safety: gated on a WICKED-only marker file (so we never touch the unrelated
 * standalone chat app that shared %APPDATA%\WICKED), copy-only with
 * force:false (an already-configured install is never overwritten), and fully
 * wrapped so a failure can never block startup.
 */
try {
  const alreadyConfigured = existsSync(join(userData, 'wicked-settings.json'))
  if (!alreadyConfigured) {
    // Legacy userData locations from earlier builds, most likely first. The
    // marker below ensures we only adopt a dir the WICKED shell actually wrote.
    const legacyDirs = ['WICKED', 'wicked-suite', 'wicked']
      .map((name) => join(appData, name))
      .filter((dir) => dir !== userData && existsSync(join(dir, 'wicked-settings.json')))

    const source = legacyDirs[0]
    if (source) {
      // Only the shell's own artifacts — not arbitrary files that may belong to
      // the old standalone app that shared the WICKED folder name.
      for (const item of ['wicked-settings.json', 'wicked-modules.json', 'modules']) {
        const from = join(source, item)
        if (existsSync(from)) {
          cpSync(from, join(userData, item), {
            recursive: true,
            force: false, // never overwrite anything already present
            errorOnExist: false
          })
        }
      }
      console.log(`[wicked] recovered user data from previous location: ${source}`)
    }
  }
} catch (err) {
  // Recovery is best-effort; never let it stop the app from launching.
  console.error('[wicked] user-data recovery skipped (non-fatal):', err)
}

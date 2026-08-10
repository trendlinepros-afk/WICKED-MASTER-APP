import Store from 'electron-store'
import { DEFAULT_SETTINGS, type ShellSettings } from '@shared/types'

const store = new Store<{ settings: ShellSettings }>({
  name: 'wicked-settings',
  defaults: { settings: DEFAULT_SETTINGS }
})

export function getSettings(): ShellSettings {
  // merge so new keys added in updates get their defaults
  return { ...DEFAULT_SETTINGS, ...store.get('settings') }
}

export function setSettings(patch: Partial<ShellSettings>): ShellSettings {
  const next = { ...getSettings(), ...patch }
  store.set('settings', next)
  return next
}

/* ----------------------- one-time settings migrations ---------------------- *
 * When an update reorganizes shipped modules, a user's older stored layout can
 * contradict it (e.g. a manual folder placement made before the module ever
 * declared a folder). Each migration runs ONCE per machine — recorded in
 * appliedMigrations — so anything the user rearranges afterwards sticks.
 * --------------------------------------------------------------------------- */

const MIGRATIONS: { id: string; apply: (s: ShellSettings) => Partial<ShellSettings> | null }[] = [
  {
    // v0.2.14 filed the YouTube downloader (renamed "Custom Playlist
    // Downloader") into the shipped "youtube" folder. A manual placement from
    // before that folder existed would keep the tool filed elsewhere — making
    // it look like it vanished from the new folder. Clear the stale placement
    // so the shipped folder assignment takes effect.
    id: 'yt-downloader-into-youtube-folder',
    apply: (s) => {
      if (s.moduleGroupOverrides['yt-downloader'] === undefined) return null
      const next = { ...s.moduleGroupOverrides }
      delete next['yt-downloader']
      return { moduleGroupOverrides: next }
    }
  }
]

function runMigrations(): void {
  try {
    const s = getSettings()
    const applied = new Set(s.appliedMigrations ?? [])
    let patch: Partial<ShellSettings> = {}
    let changed = false
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue
      const p = m.apply({ ...s, ...patch })
      if (p) {
        patch = { ...patch, ...p }
        console.log(`[wicked] applied settings migration: ${m.id}`)
      }
      applied.add(m.id)
      changed = true
    }
    if (changed) setSettings({ ...patch, appliedMigrations: [...applied] })
  } catch (err) {
    console.error('[wicked] settings migration failed (non-fatal):', err)
  }
}
runMigrations()

/** Shared store handle for modules that want simple persistence via ctx.storeGet/storeSet */
const moduleStore = new Store<Record<string, unknown>>({ name: 'wicked-modules' })

export function moduleStoreGet<T>(key: string, fallback: T): T {
  return (moduleStore.get(key) as T) ?? fallback
}

export function moduleStoreSet(key: string, value: unknown): void {
  moduleStore.set(key, value)
}

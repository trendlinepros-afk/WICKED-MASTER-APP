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

/** Shared store handle for modules that want simple persistence via ctx.storeGet/storeSet */
const moduleStore = new Store<Record<string, unknown>>({ name: 'wicked-modules' })

export function moduleStoreGet<T>(key: string, fallback: T): T {
  return (moduleStore.get(key) as T) ?? fallback
}

export function moduleStoreSet(key: string, value: unknown): void {
  moduleStore.set(key, value)
}

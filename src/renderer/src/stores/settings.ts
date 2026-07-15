import { create } from 'zustand'
import { DEFAULT_SETTINGS, SHELL_IPC, type ShellSettings } from '@shared/types'

interface SettingsState {
  settings: ShellSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<ShellSettings>) => Promise<void>
}

function applyTheme(theme: ShellSettings['theme']): void {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem('wicked-theme', theme)
  } catch {
    /* storage unavailable — theme still applied for this session */
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = (await window.wicked.invoke(SHELL_IPC.settingsGet)) as ShellSettings
    applyTheme(settings.theme)
    set({ settings, loaded: true })
  },
  update: async (patch) => {
    const settings = (await window.wicked.invoke(SHELL_IPC.settingsSet, patch)) as ShellSettings
    if (patch.theme) applyTheme(settings.theme)
    set({ settings })
  }
}))

// keep 'system' theme live when the OS theme flips
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { settings, loaded } = useSettings.getState()
  if (loaded && settings.theme === 'system') applyTheme('system')
})

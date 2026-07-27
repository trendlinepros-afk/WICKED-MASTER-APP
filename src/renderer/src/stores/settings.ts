import { create } from 'zustand'
import { DEFAULT_SETTINGS, SHELL_IPC, type ShellSettings } from '@shared/types'
import { resolveAppearance, type CustomTheme, type ThemeColors } from '@shared/themes'

interface SettingsState {
  settings: ShellSettings
  loaded: boolean
  load: () => Promise<void>
  update: (patch: Partial<ShellSettings>) => Promise<void>
}

/**
 * Apply the current appearance (built-in light/dark OR a custom theme's full
 * variable set) to <html>, and persist what boot needs to pre-paint without a
 * flash (see public/theme-init.js).
 */
function applyAppearance(s: ShellSettings): void {
  const { dark, vars } = resolveAppearance(s, matchMedia('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  const varNames = [
    '--wk-bg', '--wk-surface', '--wk-raised', '--wk-edge', '--wk-ink', '--wk-muted',
    '--wk-accent', '--wk-accent-ink', '--wk-danger', '--wk-ok', '--wk-warn'
  ]
  for (const name of varNames) {
    if (vars && vars[name]) root.style.setProperty(name, vars[name])
    else root.style.removeProperty(name)
  }
  try {
    localStorage.setItem('wicked-theme', s.theme)
    if (vars) localStorage.setItem('wicked-theme-vars', JSON.stringify({ dark, vars }))
    else localStorage.removeItem('wicked-theme-vars')
  } catch {
    /* storage unavailable — theme still applied for this session */
  }
}

/**
 * Live-preview a candidate theme while editing (does NOT persist anything).
 * Call previewAppearance(null) — or any settings update — to fall back to the
 * saved appearance.
 */
export function previewAppearance(candidate: { base: CustomTheme['base']; colors: ThemeColors } | null): void {
  const { settings } = useSettings.getState()
  if (!candidate) {
    applyAppearance(settings)
    return
  }
  const preview: ShellSettings = {
    ...settings,
    customThemes: [{ id: '__preview__', name: 'preview', base: candidate.base, colors: candidate.colors }],
    activeThemeId: '__preview__'
  }
  const root = document.documentElement
  const { dark, vars } = resolveAppearance(preview, matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  if (vars) for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    const settings = (await window.wicked.invoke(SHELL_IPC.settingsGet)) as ShellSettings
    applyAppearance(settings)
    set({ settings, loaded: true })
  },
  update: async (patch) => {
    const settings = (await window.wicked.invoke(SHELL_IPC.settingsSet, patch)) as ShellSettings
    if (patch.theme !== undefined || patch.activeThemeId !== undefined || patch.customThemes !== undefined) {
      applyAppearance(settings)
    }
    set({ settings })
  }
}))

// keep 'system' theme live when the OS theme flips
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { settings, loaded } = useSettings.getState()
  if (loaded && settings.theme === 'system' && !settings.activeThemeId) applyAppearance(settings)
})

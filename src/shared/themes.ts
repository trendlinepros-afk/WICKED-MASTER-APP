/**
 * Custom themes — pure helpers shared by main, renderer and tests.
 *
 * The app's entire look comes from 11 CSS variables (--wk-*) declared in
 * src/renderer/src/styles/index.css. A custom theme is simply a named set of
 * hex colors for those 11 tokens plus a light/dark base (the base drives the
 * `.dark` class for anything not covered by tokens, e.g. scrollbars/gradients).
 * DEFAULT_LIGHT / DEFAULT_DARK below MUST stay in sync with index.css.
 */

export const THEME_TOKENS = [
  { id: 'bg', label: 'App background', hint: 'The window backdrop behind everything' },
  { id: 'surface', label: 'Card background', hint: 'Panels, cards, sidebars' },
  { id: 'raised', label: 'Raised background', hint: 'Inputs, chips, hover fills' },
  { id: 'edge', label: 'Borders & dividers', hint: 'Card borders, separators, scrollbars' },
  { id: 'ink', label: 'Header & body text', hint: 'Primary text everywhere' },
  { id: 'muted', label: 'Muted text', hint: 'Secondary labels and descriptions' },
  { id: 'accent', label: 'Button background (accent)', hint: 'Primary buttons, links, highlights' },
  { id: 'accent-ink', label: 'Button text', hint: 'Text on accent-colored buttons' },
  { id: 'danger', label: 'Danger', hint: 'Errors and destructive actions' },
  { id: 'ok', label: 'Success', hint: 'Positive values, green buttons' },
  { id: 'warn', label: 'Warning & folders', hint: 'Warnings, Beta badges, folder icons' }
] as const

export type ThemeTokenId = (typeof THEME_TOKENS)[number]['id']
export type ThemeColors = Record<ThemeTokenId, string>

export interface CustomTheme {
  id: string
  name: string
  /**
   * A theme carries its OWN light and dark palettes. The app's Light/Dark/System
   * toggle picks which one is shown — so Light and Dark are sub-themes of the
   * same theme and editing one never bleeds into the other.
   */
  light: ThemeColors
  dark: ThemeColors
}

/** Legacy single-palette theme shape (pre-0.1.28), migrated on read. */
interface LegacyTheme {
  id: string
  name: string
  base?: 'light' | 'dark'
  colors?: Partial<ThemeColors>
}

/**
 * Accept either the new two-palette theme or the legacy {base, colors} shape.
 * A legacy theme's colors seed its declared base; the opposite mode starts from
 * that built-in default so it's sane until the user edits it.
 */
export function migrateTheme(raw: CustomTheme | LegacyTheme): CustomTheme {
  const t = raw as Partial<CustomTheme> & LegacyTheme
  if (t.light && t.dark) return { id: t.id, name: t.name, light: t.light, dark: t.dark }
  const base = t.base === 'dark' ? 'dark' : 'light'
  const seeded = { ...(base === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT), ...(t.colors ?? {}) }
  return {
    id: t.id,
    name: t.name,
    light: base === 'light' ? seeded : { ...DEFAULT_LIGHT },
    dark: base === 'dark' ? seeded : { ...DEFAULT_DARK }
  }
}

/** Mirrors :root in index.css. */
export const DEFAULT_LIGHT: ThemeColors = {
  bg: '#f5f6f8',
  surface: '#ffffff',
  raised: '#eef0f4',
  edge: '#d8dce4',
  ink: '#181c24',
  muted: '#697080',
  accent: '#7c3aed',
  'accent-ink': '#ffffff',
  danger: '#dc2626',
  ok: '#16a34a',
  warn: '#ca8a04'
}

/** Mirrors .dark in index.css. */
export const DEFAULT_DARK: ThemeColors = {
  bg: '#111318',
  surface: '#181b22',
  raised: '#20242d',
  edge: '#2f343f',
  ink: '#e5e7eb',
  muted: '#949baa',
  accent: '#8b5cf6',
  'accent-ink': '#ffffff',
  danger: '#f87171',
  ok: '#4ade80',
  warn: '#facc15'
}

/* ------------------------------ color utils ------------------------------ */

/** '#abc', 'abc', '#aabbcc', 'AABBCC' → '#aabbcc' — or null if not a hex color. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(s)) return '#' + s.split('').map((c) => c + c).join('')
  if (/^[0-9a-f]{6}$/.test(s)) return '#' + s
  return null
}

/** '#0b1022' → '11 16 34' (the RGB triplet format the CSS vars use). */
export function hexToTriplet(hex: string): string | null {
  const n = normalizeHex(hex)
  if (!n) return null
  const v = parseInt(n.slice(1), 16)
  return `${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255}`
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHex(hex)
  if (!n) return null
  const v = parseInt(n.slice(1), 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number): string =>
    Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** h 0..360, s 0..1, v 0..1 → rgb 0..255 */
export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = v - c
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 }
}

/** rgb 0..255 → { h 0..360, s 0..1, v 0..1 } */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6)
    else if (max === gn) h = 60 * ((bn - rn) / d + 2)
    else h = 60 * ((rn - gn) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

/* ----------------------------- theme resolution ---------------------------- */

export interface AppearanceSettingsSlice {
  theme: 'light' | 'dark' | 'system'
  customThemes: CustomTheme[]
  activeThemeId: string
}

/** Build the --wk-* variable map from a single palette (with base fallback). */
export function paletteToVars(colors: ThemeColors, dark: boolean): Record<string, string> {
  const fallback = dark ? DEFAULT_DARK : DEFAULT_LIGHT
  const vars: Record<string, string> = {}
  for (const tok of THEME_TOKENS) {
    const hex = colors?.[tok.id] ?? fallback[tok.id]
    vars[`--wk-${tok.id}`] = hexToTriplet(hex) ?? hexToTriplet(fallback[tok.id])!
  }
  return vars
}

/**
 * What the window should look like right now. The Light/Dark/System toggle
 * decides light vs dark; a custom theme then supplies the matching sub-palette
 * (its .light or .dark). vars = null means "use the stylesheet defaults".
 */
export function resolveAppearance(
  s: AppearanceSettingsSlice,
  systemPrefersDark: boolean
): { dark: boolean; vars: Record<string, string> | null } {
  const dark = s.theme === 'dark' || (s.theme === 'system' && systemPrefersDark)
  const active = s.activeThemeId ? s.customThemes.find((t) => t.id === s.activeThemeId) : undefined
  if (!active) return { dark, vars: null }
  const theme = migrateTheme(active)
  return { dark, vars: paletteToVars(dark ? theme.dark : theme.light, dark) }
}

/** kebab-case, collision-free id for a new theme. */
export function makeThemeId(name: string, taken: string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

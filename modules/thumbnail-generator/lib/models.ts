/**
 * Model catalogue + cost maths (pure; shared by main and renderer).
 *
 * Pikzels v2 models: pkz_2 … pkz_4_5. Personas, styles and a guiding prompt on
 * a recreate need pkz_4 or newer; image_weight only exists on pkz_2. Credit
 * prices per model vary by plan (Pikzels says "10–20 credits per thumbnail
 * depending on the model"), so they're editable in Settings and, when a
 * response carries a credits figure, learned automatically.
 */
import type { Format, Model, ModuleSettings } from '../types'

export interface ModelInfo {
  id: Model
  label: string
  blurb: string
  /** persona / style / recreate-prompt allowed */
  personaCapable: boolean
  /** image_weight allowed on recreate */
  imageWeight: boolean
}

export const MODELS: ModelInfo[] = [
  { id: 'pkz_4_5', label: 'PKZ 4.5', blurb: 'Latest — best quality, personas & themes', personaCapable: true, imageWeight: false },
  { id: 'pkz_4', label: 'PKZ 4', blurb: 'High quality, personas & themes', personaCapable: true, imageWeight: false },
  { id: 'pkz_3', label: 'PKZ 3', blurb: 'Fast, no persona/theme support', personaCapable: false, imageWeight: false },
  { id: 'pkz_2', label: 'PKZ 2', blurb: 'Versatile & photoreal; recreate with image weight', personaCapable: false, imageWeight: true }
]

export const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: '16:9', label: '16:9', hint: 'YouTube video' },
  { id: '9:16', label: '9:16', hint: 'Shorts / vertical' },
  { id: '1:1', label: '1:1', hint: 'Square' }
]

export const DEFAULT_SETTINGS: ModuleSettings = {
  downloadDir: '',
  creditsPerModel: { pkz_2: 10, pkz_3: 10, pkz_4: 15, pkz_4_5: 20 },
  creditsPersona: 50,
  creditsStyle: 50,
  creditsTitle: 3,
  creditsScore: 3,
  creditsEdit: 10,
  planPrice: 0,
  planCredits: 0,
  concurrency: 2,
  creditsRemaining: null
}

export const modelInfo = (id: string): ModelInfo => MODELS.find((m) => m.id === id) ?? MODELS[0]

/** Why a model can't be used with the current options (null = fine). */
export function modelRestriction(model: Model, o: { persona?: boolean; style?: boolean; recreateWithPrompt?: boolean; imageWeight?: boolean }): string | null {
  const m = modelInfo(model)
  if ((o.persona || o.style) && !m.personaCapable) return `${m.label} can't use personas or themes — pick PKZ 4 or 4.5.`
  if (o.recreateWithPrompt && !m.personaCapable) return `${m.label} ignores a guiding prompt on recreate — pick PKZ 4 or 4.5.`
  if (o.imageWeight && !m.imageWeight) return `Image weight is only available on PKZ 2.`
  return null
}

export interface Estimate {
  creditsEach: number
  creditsTotal: number
  /** null when the plan price isn't set */
  dollarsEach: number | null
  dollarsTotal: number | null
  perCredit: number | null
}

export function estimate(s: ModuleSettings, creditsEach: number, count: number): Estimate {
  const perCredit = s.planPrice > 0 && s.planCredits > 0 ? s.planPrice / s.planCredits : null
  const n = Math.max(1, Math.round(count))
  return {
    creditsEach,
    creditsTotal: creditsEach * n,
    dollarsEach: perCredit == null ? null : creditsEach * perCredit,
    dollarsTotal: perCredit == null ? null : creditsEach * n * perCredit,
    perCredit
  }
}

export const fmtUsd = (n: number): string => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3).replace(/0$/, '')}`)

/** file-name-safe slug from a prompt */
export function slug(text: string, max = 48): string {
  const s = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (s.slice(0, max).replace(/-+$/, '') || 'thumbnail')
}

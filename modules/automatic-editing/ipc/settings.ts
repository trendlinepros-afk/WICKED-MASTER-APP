/**
 * Non-secret settings store — settings.json under the module's data folder
 * (<userData>/modules/automatic-editing).
 *
 * API keys and S3 credentials are NOT stored here: they live in the WICKED
 * shell's central key vault (Settings → API Keys) and are read at call time
 * via keys.ts. This store only surfaces presence booleans (keysPresent,
 * hosting.configured) to the renderer — never values.
 */
import fs from 'fs'
import path from 'path'
import { moduleDataDir } from './paths'
import { getSecret } from './keys'
import type { AppSettings, BrandKit } from '../shared/types'

export type { SecretName } from '../shared/types'

const DEFAULT_BRAND: BrandKit = {
  fontDisplay: 'Segoe UI Variable Display',
  fontBody: 'Segoe UI Variable Text',
  customFonts: [],
  palette: {
    primary: '#5eead4',
    secondary: '#0f766e',
    accent: '#5eead4',
    background: '#0b0d10',
    text: '#f2f5f8'
  }
}

const DEFAULTS: AppSettings = {
  onboarded: false,
  keysPresent: { gemini: false, openai: false, deepseek: false, anthropic: false, opusclip: false },
  routing: {
    taskProviders: {
      'retake-detection': 'gemini',
      'cut-review': 'gemini',
      'graphic-planning': 'gemini',
      'graphic-slot-filling': 'gemini',
      'revision-parsing': 'gemini'
    }
  },
  silence: { thresholdDb: -35, minSilenceSec: 0.6, keepPadMs: 150 },
  scene: { threshold: 0.4, defaultTransition: 'crossfade', defaultDurationSec: 0.5 },
  hosting: { kind: 's3', configured: false },
  export: { preferNvenc: true },
  opusclip: {},
  brandKit: DEFAULT_BRAND
}

class SettingsStore {
  private settingsPath: string
  private settings: AppSettings

  constructor() {
    this.settingsPath = path.join(moduleDataDir(), 'settings.json')
    this.settings = this.load()
    this.refreshKeyPresence()
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'))
      return {
        ...DEFAULTS,
        ...raw,
        routing: { taskProviders: { ...DEFAULTS.routing.taskProviders, ...raw?.routing?.taskProviders } },
        brandKit: { ...DEFAULT_BRAND, ...raw?.brandKit, palette: { ...DEFAULT_BRAND.palette, ...raw?.brandKit?.palette } }
      }
    } catch {
      return structuredClone(DEFAULTS)
    }
  }

  /** Presence booleans derived LIVE from the shell key vault. */
  private refreshKeyPresence(): void {
    this.settings.keysPresent = {
      gemini: Boolean(getSecret('gemini')),
      openai: Boolean(getSecret('openai')),
      deepseek: Boolean(getSecret('deepseek')),
      anthropic: Boolean(getSecret('anthropic')),
      opusclip: Boolean(getSecret('opusclip'))
    }
    this.settings.hosting.configured = Boolean(getSecret('s3-access') && getSecret('s3-secret') && this.settings.hosting.bucket)
  }

  getSettings(): AppSettings {
    // Re-check on every read — vault keys can change any time in the shell UI.
    this.refreshKeyPresence()
    return this.settings
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      // Deep-merge nested objects so a partial patch (e.g. only brandKit.logoPath
      // or one task provider) can't clobber sibling fields.
      routing: patch.routing
        ? { taskProviders: { ...this.settings.routing.taskProviders, ...patch.routing.taskProviders } }
        : this.settings.routing,
      brandKit: patch.brandKit
        ? {
            ...this.settings.brandKit,
            ...patch.brandKit,
            palette: { ...this.settings.brandKit.palette, ...patch.brandKit.palette }
          }
        : this.settings.brandKit,
      hosting: patch.hosting ? { ...this.settings.hosting, ...patch.hosting } : this.settings.hosting
    }
    this.refreshKeyPresence()
    fs.writeFileSync(this.settingsPath, JSON.stringify({ ...this.settings }, null, 2))
    return this.settings
  }
}

let store: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!store) store = new SettingsStore()
  return store
}

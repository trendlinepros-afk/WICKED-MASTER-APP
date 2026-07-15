import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/config'
import { logger } from './logger'

/**
 * Config persistence for the coding-app module, with update-survivability.
 *
 * The config lives at `<userData>/modules/coding-app/config.json` (module-
 * owned subfolder per the WICKED module contract). On every load the stored
 * object is deep-merged over DEFAULT_CONFIG, so fields added in newer versions
 * appear with defaults and previously-saved values are retained. Before each
 * write the previous good file is snapshot to `config.backup.json`, enabling
 * recovery if the main file becomes corrupt.
 *
 * SECURITY NOTE (port change): the standalone app stored provider API keys in
 * PLAINTEXT inside this file. In WICKED, keys live in the shell's central,
 * safeStorage-encrypted API key vault (Settings → API Keys) and are read via
 * `ctx.getApiKey()` — they are never part of this config. Any `apiKey` fields
 * found in an old config (including a one-time import of the standalone
 * app's config on first run) are silently dropped, never re-persisted.
 */
class ConfigStore {
  private cache: AppConfig | null = null

  private get dir(): string {
    return join(app.getPath('userData'), 'modules', 'coding-app')
  }

  private get file(): string {
    return join(this.dir, 'config.json')
  }

  private get backupFile(): string {
    return join(this.dir, 'config.backup.json')
  }

  path(): string {
    return this.file
  }

  load(): AppConfig {
    if (this.cache) return this.cache
    this.ensureDir()
    if (!existsSync(this.file)) {
      // First run inside the suite: import the standalone app's settings if
      // present (keys are dropped by pickKnown/mergeConfig — see note above).
      const legacy = this.tryLoadLegacyConfig()
      this.cache = legacy ?? { ...DEFAULT_CONFIG }
      this.persist(this.cache)
      if (legacy) logger.info('Imported settings from the standalone app (API keys excluded).')
      return this.cache
    }
    try {
      const raw = readFileSync(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      this.cache = mergeConfig(DEFAULT_CONFIG, pickKnown(parsed))
      return this.cache
    } catch (err) {
      logger.error('Config file corrupt, attempting backup restore', err)
      const restored = this.tryRestoreBackup()
      if (restored) return restored
      logger.warn('No usable backup; falling back to defaults')
      this.cache = { ...DEFAULT_CONFIG }
      return this.cache
    }
  }

  update(patch: Partial<AppConfig>): AppConfig {
    const current = this.load()
    const next = mergeConfig(current, patch)
    this.persist(next)
    this.cache = next
    return next
  }

  /** Explicit restore requested by the user (Settings) or automatic on corrupt load. */
  restoreBackup(): AppConfig {
    const restored = this.tryRestoreBackup()
    if (restored) return restored
    throw new Error('No config backup available to restore.')
  }

  // ---- internals ----

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  private persist(cfg: AppConfig): void {
    this.ensureDir()
    try {
      // Snapshot previous good file before overwriting.
      if (existsSync(this.file)) {
        try {
          copyFileSync(this.file, this.backupFile)
        } catch (e) {
          logger.warn('Could not write config backup', e)
        }
      }
      writeFileSync(this.file, JSON.stringify(cfg, null, 2), 'utf-8')
    } catch (err) {
      logger.error('Failed to persist config', err)
    }
  }

  private tryRestoreBackup(): AppConfig | null {
    if (!existsSync(this.backupFile)) return null
    try {
      const raw = readFileSync(this.backupFile, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const merged = mergeConfig(DEFAULT_CONFIG, pickKnown(parsed))
      this.persist(merged)
      this.cache = merged
      logger.info('Config restored from backup')
      return merged
    } catch (err) {
      logger.error('Backup config also corrupt', err)
      return null
    }
  }

  /**
   * Best-effort one-time import of the standalone app's config (settings
   * only — never its plaintext API keys). The old app's userData folder was
   * named after its productName (packaged) or package name (dev builds).
   */
  private tryLoadLegacyConfig(): AppConfig | null {
    const appData = app.getPath('appData')
    const candidates = [
      join(appData, 'Local LLM Coding Assistant', 'config.json'),
      join(appData, 'local-llm-coding-assistant', 'config.json')
    ]
    for (const file of candidates) {
      try {
        if (!existsSync(file)) continue
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
        return mergeConfig(DEFAULT_CONFIG, pickKnown(parsed))
      } catch (err) {
        logger.warn('Legacy config unreadable, skipping', file, err)
      }
    }
    return null
  }
}

/**
 * Keep only fields that exist in the current schema, dropping legacy ones
 * (`theme`, `autoCheckUpdates`, and crucially any plaintext `api.*.apiKey` —
 * those are handled per-provider in mergeConfig, which picks known provider
 * fields explicitly).
 */
function pickKnown(parsed: Record<string, unknown>): Partial<AppConfig> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key in parsed) out[key] = parsed[key]
  }
  return out as Partial<AppConfig>
}

/**
 * Deep-merge `patch` over `base` for the AppConfig shape. Nested `api.*`
 * provider objects are merged field-by-field (model/enabled only, so stray
 * legacy `apiKey` properties can never survive into the persisted file);
 * arrays and scalars are replaced.
 */
function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const out: AppConfig = { ...base, ...patch }
  const provider = (p: 'openai' | 'anthropic' | 'gemini' | 'deepseek'): AppConfig['api'][typeof p] => ({
    model: patch.api?.[p]?.model ?? base.api[p].model,
    enabled: patch.api?.[p]?.enabled ?? base.api[p].enabled
  })
  out.api = {
    openai: provider('openai'),
    anthropic: provider('anthropic'),
    gemini: provider('gemini'),
    deepseek: provider('deepseek')
  }
  if (patch.customModels) out.customModels = patch.customModels
  if (patch.favoriteModels) out.favoriteModels = patch.favoriteModels
  if (patch.recentProjects) out.recentProjects = patch.recentProjects
  // Config version is owned by the app, never downgraded by a stored value.
  out.configVersion = Math.max(base.configVersion, patch.configVersion ?? 0)
  return out
}

export const configStore = new ConfigStore()

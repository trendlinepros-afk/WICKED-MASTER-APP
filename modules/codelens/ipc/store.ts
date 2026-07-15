import Store from 'electron-store'
import { AI_PROVIDER_IDS, DEFAULT_MODELS } from '../shared/providers'
import type { AiProvider } from '../shared/types'

// API keys are NOT stored here — they live in the WICKED central vault
// (Settings → API Keys) and are read via ctx.getApiKey() in ipc.ts.

interface StoreSchema {
  aiProvider?: AiProvider
  aiModels?: Partial<Record<AiProvider, string>>
  recentProjects: string[]
  customIgnores: string[]
}

// Module-private store file (module-codelens.json in userData) — must not
// collide with the WICKED shell's own settings store.
const store = new Store<StoreSchema>({
  name: 'module-codelens',
  defaults: { recentProjects: [], customIgnores: [] }
})

export function getAiProvider(): AiProvider {
  const p = store.get('aiProvider')
  return p && AI_PROVIDER_IDS.includes(p) ? p : 'claude'
}

export function setAiProvider(provider: AiProvider): void {
  store.set('aiProvider', provider)
}

export function getAiModel(provider: AiProvider): string {
  return store.get('aiModels')?.[provider] || DEFAULT_MODELS[provider]
}

export function setAiModel(provider: AiProvider, model: string): void {
  const models = store.get('aiModels') ?? {}
  models[provider] = model.trim() || DEFAULT_MODELS[provider]
  store.set('aiModels', models)
}

export function getRecentProjects(): string[] {
  return store.get('recentProjects')
}

export function addRecentProject(projectPath: string): void {
  const list = [projectPath, ...store.get('recentProjects').filter((p) => p !== projectPath)]
  store.set('recentProjects', list.slice(0, 8))
}

export function getCustomIgnores(): string[] {
  return store.get('customIgnores')
}

export function setCustomIgnores(ignores: string[]): void {
  store.set(
    'customIgnores',
    ignores.map((s) => s.trim()).filter(Boolean)
  )
}

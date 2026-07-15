import { configStore } from './config-persistence'
import { ollamaService, vramForModel } from './ollama'
import { getApiKey } from './keys'
import {
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  describeModel,
  type ProviderId
} from '../../shared/config'
import type { ModelDescriptor } from '../../shared/types'

/**
 * Builds the unified model list for the switcher: downloaded Ollama models plus
 * every configured cloud model. Availability reflects Ollama connectivity, VRAM
 * budget (local), and whether a provider key is present (cloud).
 */
export async function listModels(): Promise<ModelDescriptor[]> {
  const cfg = configStore.load()
  const out: ModelDescriptor[] = []

  // Local Ollama models (only downloaded ones are listed).
  const status = await ollamaService.status()
  for (const m of status.models) {
    // Ollama-hosted "cloud" models (name ends in :cloud) don't use local VRAM.
    const isCloud = m.name.endsWith(':cloud')
    const vram = isCloud ? null : vramForModel(m.name, cfg, m.sizeBytes)
    const exceedsVram = vram != null && vram > cfg.gpuVramGb
    out.push({
      id: `ollama:${m.name}`,
      name: m.name,
      provider: 'ollama',
      providerLabel: isCloud ? 'Cloud (Ollama)' : 'Local (Ollama)',
      isLocal: !isCloud,
      vramGb: vram,
      available: status.connected && !exceedsVram,
      unavailableReason: !status.connected
        ? 'Ollama is not running.'
        : exceedsVram
          ? `Needs ~${vram} GB > your ${cfg.gpuVramGb} GB. Will be slow (CPU offload).`
          : undefined,
      speedHint: vram != null ? estimateSpeed(vram, cfg.gpuVramGb) : undefined,
      description: describeModel(m.name)
    })
  }

  // Cloud provider models. A disabled provider is hidden entirely.
  // Keys come from the shell's central vault, not from module config.
  const providers = Object.keys(PROVIDER_MODELS) as ProviderId[]
  providers.forEach((provider) => {
    if (!cfg.api[provider].enabled) return
    const key = getApiKey(provider)
    for (const model of PROVIDER_MODELS[provider]) {
      out.push({
        id: `${provider}:${model}`,
        name: model,
        provider,
        providerLabel: PROVIDER_LABELS[provider],
        isLocal: false,
        vramGb: null,
        available: !!key,
        unavailableReason: key ? undefined : 'API key not configured.'
      })
    }
  })

  return out
}

/** Very rough qualitative speed hint based on VRAM headroom. */
function estimateSpeed(vram: number, total: number): string {
  const headroom = total - vram
  if (headroom < 0) return 'Exceeds VRAM (CPU offload, slow)'
  if (headroom > 6) return '~40-60 tok/s'
  if (headroom > 2) return '~20-40 tok/s'
  return '~10-20 tok/s'
}

/** Parse a model id like "ollama:mistral:7b" or "openai:gpt-4o". */
export function parseModelId(id: string): {
  provider: 'ollama' | ProviderId
  model: string
} {
  const idx = id.indexOf(':')
  const provider = id.slice(0, idx) as 'ollama' | ProviderId
  const model = id.slice(idx + 1)
  return { provider, model }
}

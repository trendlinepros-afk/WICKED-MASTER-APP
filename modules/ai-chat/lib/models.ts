import type { Provider } from '../types';
import type { ModelVersion } from '../components/ModelSelector/modelConfig';
import { api } from './bridge';

// Live model discovery. Port note: the actual provider requests (which need
// API keys) moved to the main process (ipc/providers.ts) — the renderer just
// asks over IPC and never sees a key. Returns [] when the provider's key is
// missing or the request fails, so callers fall back to the hardcoded
// defaults in modelConfig.ts.

// Cache per provider for the session — the list doesn't change minute to minute.
const cache = new Map<string, ModelVersion[]>();

export async function listChatModels(provider: Provider): Promise<ModelVersion[]> {
  if (provider === 'ollama') return []; // handled by lib/ollama.ts (local server)
  const key = `chat:${provider}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const models = await api.modelsListChat(provider);
  if (models.length > 0) cache.set(key, models);
  return models;
}

// Image-capable Gemini/Imagen models discovered on the key (Image Gen dropdown).
export async function listImageModels(): Promise<ModelVersion[]> {
  const hit = cache.get('image:gemini');
  if (hit) return hit;
  const models = await api.modelsListImage();
  if (models.length > 0) cache.set('image:gemini', models);
  return models;
}

import type { ModelVersion } from '../components/ModelSelector/modelConfig';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function normalizeBase(url: string): string {
  return (url || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
}

// OpenAI-compatible endpoint that the chat code points the SDK at.
export function ollamaOpenAIBase(url: string): string {
  return `${normalizeBase(url)}/v1`;
}

// List the models actually installed on the local Ollama server.
// Returns [] if Ollama isn't reachable (so callers fall back to defaults).
export async function listOllamaModels(baseUrl: string): Promise<ModelVersion[]> {
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/api/tags`, {
      method: 'GET',
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = data.models ?? [];
    return models
      .map((m) => m.name)
      .filter(Boolean)
      .sort()
      .map((name) => ({ id: name, label: name }));
  } catch {
    return [];
  }
}

// Names of models currently loaded into memory (via /api/ps).
export async function listRunningOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(`${normalizeBase(baseUrl)}/api/ps`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Load a model into memory (keep_alive: -1 keeps it resident) or unload (0).
export async function setOllamaLoaded(
  baseUrl: string,
  model: string,
  loaded: boolean
): Promise<void> {
  await fetch(`${normalizeBase(baseUrl)}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: loaded ? -1 : 0 }),
  });
}

// Pull (download) a model, reporting 0..1 progress. Streams NDJSON from /api/pull.
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (fraction: number, status: string) => void
): Promise<void> {
  const res = await fetch(`${normalizeBase(baseUrl)}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Pull failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
        if (obj.error) throw new Error(obj.error);
        const frac = obj.total && obj.completed ? obj.completed / obj.total : 0;
        onProgress(frac, obj.status ?? '');
      } catch {
        /* ignore non-JSON keepalive lines */
      }
    }
  }
}

export interface CatalogModel {
  id: string; // ollama pull name
  label: string;
  size: string;
  goodAt: string;
}

// Curated catalog (Ollama has no public registry-list API). Users can still
// pull any model by typing its name.
export const OLLAMA_CATALOG: CatalogModel[] = [
  { id: 'llama3.2', label: 'Llama 3.2', size: '~2 GB (3B)', goodAt: 'Fast, compact general chat; runs on modest hardware.' },
  { id: 'llama3.1', label: 'Llama 3.1', size: '~4.7 GB (8B)', goodAt: 'Strong general-purpose default; good balance.' },
  { id: 'qwen2.5', label: 'Qwen 2.5', size: '~4.7 GB (7B)', goodAt: 'Excellent all-rounder; strong code & multilingual.' },
  { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder', size: '~4.7 GB (7B)', goodAt: 'Specialized for coding & completions.' },
  { id: 'deepseek-r1', label: 'DeepSeek R1', size: '~4.7 GB (7B)', goodAt: 'Step-by-step reasoning & math.' },
  { id: 'mistral', label: 'Mistral', size: '~4.1 GB (7B)', goodAt: 'Fast, capable general model.' },
  { id: 'gemma2', label: 'Gemma 2', size: '~5.4 GB (9B)', goodAt: "Google's efficient open model; solid writing." },
  { id: 'phi3', label: 'Phi-3', size: '~2.2 GB (3.8B)', goodAt: 'Tiny but capable; great on low-RAM machines.' },
  { id: 'codellama', label: 'Code Llama', size: '~3.8 GB (7B)', goodAt: 'Code generation & infilling.' },
  { id: 'llava', label: 'LLaVA', size: '~4.7 GB (7B)', goodAt: 'Vision — can understand attached images.' },
  { id: 'nomic-embed-text', label: 'Nomic Embed', size: '~274 MB', goodAt: 'Text embeddings (not a chat model).' },
];

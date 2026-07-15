import type { Provider } from '../../types';

export interface ModelVersion {
  id: string;
  label: string;
}

export interface ProviderConfig {
  label: string;
  color: string;
  versions: ModelVersion[];
  imageGenVersions?: ModelVersion[];
}

export const MODEL_CONFIG: Record<Provider, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    color: '#10a37f',
    versions: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
      { id: 'o1', label: 'o1' },
      { id: 'o1-mini', label: 'o1 Mini' },
      { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
    ],
  },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    versions: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
    ],
    imageGenVersions: [
      { id: 'gemini-2.0-flash-preview-image-generation', label: 'Gemini Flash (image)' },
      { id: 'gemini-2.5-flash-image-preview', label: 'Nano Banana (2.5 Flash image)' },
      { id: 'imagen-3.0-generate-002', label: 'Imagen 3' },
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    color: '#7c3aed',
    versions: [
      { id: 'deepseek-chat', label: 'DeepSeek V3' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1' },
    ],
  },
  ollama: {
    label: 'Ollama (local)',
    color: '#475569',
    // Defaults shown before we fetch the machine's actually-installed models.
    versions: [
      { id: 'llama3.2', label: 'Llama 3.2' },
      { id: 'llama3.1', label: 'Llama 3.1' },
      { id: 'qwen2.5', label: 'Qwen 2.5' },
      { id: 'mistral', label: 'Mistral' },
      { id: 'deepseek-r1', label: 'DeepSeek R1 (local)' },
      { id: 'gemma2', label: 'Gemma 2' },
      { id: 'phi3', label: 'Phi-3' },
      { id: 'codellama', label: 'Code Llama' },
    ],
  },
};

export const PROVIDERS: Provider[] = ['openai', 'gemini', 'deepseek', 'ollama'];

export function providerColor(provider: Provider): string {
  return MODEL_CONFIG[provider].color;
}

export function versionLabel(provider: Provider, id: string): string {
  const cfg = MODEL_CONFIG[provider];
  const all = [...cfg.versions, ...(cfg.imageGenVersions ?? [])];
  return all.find((v) => v.id === id)?.label ?? id;
}

export function defaultVersionFor(provider: Provider): string {
  return MODEL_CONFIG[provider].versions[0].id;
}

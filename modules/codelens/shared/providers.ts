import type { AiProvider } from './types'

export const AI_PROVIDER_IDS: AiProvider[] = ['claude', 'openai', 'gemini', 'deepseek']

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: 'Claude (Anthropic)',
  openai: 'OpenAI',
  gemini: 'Gemini (Google)',
  deepseek: 'DeepSeek'
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: 'claude-sonnet-4-6',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
  deepseek: 'deepseek-chat'
}

/** Shown as datalist suggestions — any model id the account can access is accepted. */
export const MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  claude: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner']
}

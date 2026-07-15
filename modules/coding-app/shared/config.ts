/**
 * Application configuration schema (coding-app module).
 *
 * Non-secret config is persisted as plain JSON under
 * `app.getPath('userData')/modules/coding-app/config.json`. API keys are NOT
 * part of this config at all — they live in the WICKED shell's central API
 * key vault (Settings → API Keys) and are read by main-process code via
 * `ctx.getApiKey(provider)`. Key values never reach the renderer; it only
 * sees set/not-set booleans via the shell's `apiKeysStatus` channel.
 *
 * Port notes: the standalone app persisted `theme` and `autoCheckUpdates`
 * (removed — the shell owns theming and updates) and a plaintext `apiKey` per
 * provider (removed — replaced by the shell vault).
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'deepseek'

/**
 * How the assistant is allowed to change files:
 *  - 'plan': read-only planning. No file edits at all; the AI produces a plan
 *    and asks permission to switch modes to implement it.
 *  - 'ask':  the AI proposes file changes but they are not written until the
 *    user approves (Apply / Reject).
 *  - 'auto': file changes are written to disk automatically (full auto).
 */
export type ChatMode = 'plan' | 'ask' | 'auto'

export interface ProviderConfig {
  /** The model id currently selected for this provider. */
  model: string
  /**
   * Whether this provider is enabled in the model switcher. Defaults to true.
   * When false, the provider's models are hidden even if a key is present —
   * lets the user keep a key configured but temporarily off.
   */
  enabled: boolean
}

export interface ApiConfig {
  openai: ProviderConfig
  anthropic: ProviderConfig
  gemini: ProviderConfig
  deepseek: ProviderConfig
}

/** A user-added Ollama model with its VRAM footprint (GB). */
export interface CustomOllamaModel {
  name: string
  vramGb: number
}

export interface AppConfig {
  configVersion: number

  // General
  gpuVramGb: number
  projectsRootPath: string
  obsidianVaultPath: string

  // Providers
  api: ApiConfig

  // Gemini screenshot analysis
  geminiAnalysisEnabled: boolean
  autoFixFromGemini: boolean

  // Ollama
  ollamaEndpoint: string
  autoStartOllama: boolean
  /** When enabled, the loaded model auto-unloads after this many seconds of
   *  inactivity (maps to Ollama's keep_alive). When disabled the model stays
   *  loaded until manually unloaded. */
  llmTimeoutEnabled: boolean
  llmKeepAliveSeconds: number

  // Advanced
  temperature: number
  maxTokens: number

  // How file edits are handled (plan / ask / auto).
  chatMode: ChatMode

  // Recently opened project folders (absolute paths, most-recent first).
  recentProjects: string[]

  // Auto-send a failed run's output to the chat so the AI can diagnose it.
  autoDebugRunErrors: boolean

  // Custom Ollama model VRAM entries (merged with hardcoded MODEL_VRAM)
  customModels: CustomOllamaModel[]

  // Favorited model ids (e.g. "ollama:deepseek-coder-v2:16b", "openai:gpt-4o").
  // Favorites sort to the top of the model switcher.
  favoriteModels: string[]

  // The last selected model id across providers, e.g. "ollama:deepseek-coder:33b"
  // or "openai:gpt-4o". Restored on launch.
  lastSelectedModel: string | null
}

export const DEFAULT_CONFIG: AppConfig = {
  configVersion: 1,

  gpuVramGb: 8,
  projectsRootPath: '',
  obsidianVaultPath: '',

  api: {
    openai: { model: 'gpt-4o', enabled: true },
    anthropic: { model: 'claude-3-5-sonnet-latest', enabled: true },
    gemini: { model: 'gemini-2.5-pro', enabled: true },
    deepseek: { model: 'deepseek-chat', enabled: true }
  },

  geminiAnalysisEnabled: false,
  autoFixFromGemini: false,

  ollamaEndpoint: 'http://localhost:11434',
  autoStartOllama: true,
  llmTimeoutEnabled: false,
  llmKeepAliveSeconds: 300,

  temperature: 0.7,
  maxTokens: 2048,

  chatMode: 'ask',

  recentProjects: [],
  autoDebugRunErrors: true,

  customModels: [],

  favoriteModels: [],

  lastSelectedModel: null
}

/**
 * Hardcoded VRAM requirements (GB) for well-known Ollama models.
 * Users can extend this via `customModels` in settings.
 */
export const MODEL_VRAM: Record<string, number> = {
  'deepseek-coder:33b': 10.5,
  'deepseek-coder:13b': 9,
  'mistral:7b': 5.5,
  'codellama:7b': 5.5,
  'codellama:13b': 9,
  'llama3:8b': 6,
  'qwen2.5-coder:7b': 5.5,
  'qwen2.5-coder:14b': 9.5
}

/**
 * Short "what is it good at" descriptions matched by model-name pattern (first
 * match wins). Used to annotate the model switcher so users know what each
 * downloaded model is for.
 */
const MODEL_DESCRIPTIONS: { pattern: RegExp; text: string }[] = [
  { pattern: /qwen[\d.]*-?coder/i, text: 'Top open coding model — code generation, completion, refactoring.' },
  { pattern: /qwen.*vl/i, text: 'Vision-language: can read images/screenshots plus general chat & code.' },
  { pattern: /qwen/i, text: 'Strong all-rounder — general chat, reasoning, and coding.' },
  { pattern: /deepseek-coder/i, text: 'Excellent at coding with long code context.' },
  { pattern: /deepseek.*(v2|v3|v4|r1|reason)/i, text: 'Strong reasoning and coding.' },
  { pattern: /deepseek/i, text: 'Strong general reasoning and coding.' },
  { pattern: /codellama|code-llama/i, text: 'Meta code-specialized model.' },
  { pattern: /llama.*vision/i, text: 'General model that can also read images/screenshots.' },
  { pattern: /llama/i, text: 'Meta general-purpose model — balanced chat and code.' },
  { pattern: /mixtral/i, text: 'Mixture-of-experts — capable general-purpose, heavier.' },
  { pattern: /mistral/i, text: 'Fast, efficient general-purpose — good on modest GPUs.' },
  { pattern: /phi/i, text: 'Small and efficient with strong reasoning for its size.' },
  { pattern: /gemma/i, text: 'Google general-purpose model.' },
  { pattern: /starcoder/i, text: 'Code-focused model.' },
  { pattern: /gpt-oss|granite|command-?r/i, text: 'General-purpose model.' }
]

/** A one-line description of what a model is good at, by name. */
export function describeModel(name: string): string {
  const hit = MODEL_DESCRIPTIONS.find((d) => d.pattern.test(name))
  return hit ? hit.text : 'General-purpose local model.'
}

/** System-prompt guidance injected for the active chat mode. */
export function modeSystemPrompt(mode: ChatMode): string {
  const fileFormat =
    'CRITICAL — HOW TO WRITE FILES: To create or modify a file you MUST output its COMPLETE contents in a fenced code block whose info string includes the file path via title="...", exactly like this:\n' +
    '```python title="main.py"\n<full file contents here>\n```\n' +
    'Rules: (1) ALWAYS put the path in title="..." on the opening fence — a code block with no path is NOT saved. ' +
    '(2) If the user asks for a single program/script, still choose a sensible filename (e.g. main.py, index.html, game.py). ' +
    '(3) Put shell/terminal commands (like `pip install pygame`) in a plain ```bash block or prose — never as a titled file. ' +
    '(4) Output the entire file, not a snippet. (5) To delete a file, make the block body exactly DELETE. ' +
    'RESPONSE STRUCTURE: begin with ONE or TWO sentences describing what you are about to do, then the ' +
    'file/command blocks, then end with a brief "Done — what changed and suggested next steps" note. Keep ' +
    'the prose short; the code is collapsible in the UI.'
  switch (mode) {
    case 'plan':
      return (
        'You are in PLAN MODE (read-only). Do NOT write, edit, or delete any files, ' +
        'and do NOT output file code blocks. Instead, analyze the request and produce a clear, ' +
        'step-by-step implementation plan (files to create/change, key decisions, risks). ' +
        'When you have a solid, complete plan, STOP and ask the user for permission to switch to ' +
        '"Ask before edits" or "Full Auto" mode to implement it — tell them to use the mode toggle above the chat box.'
      )
    case 'ask':
      return (
        'You are in ASK MODE. You may propose file changes and shell commands, but they are NOT ' +
        'applied until the user approves. Briefly explain what you will do, then provide it. ' +
        fileFormat +
        ' RUNNING COMMANDS: to install a dependency or run something, put the command in a ```bash ' +
        'block (e.g. `pip install pygame`) — it will be executed in the project directory after ' +
        'approval. Do NOT just tell the user to run it themselves.'
      )
    case 'auto':
      return (
        'You are in FULL AUTO mode. Implement the request directly with NO further questions. Your ' +
        'file changes are written to disk automatically, and any shell command you put in a ```bash ' +
        'block is EXECUTED automatically in the project directory (e.g. `pip install pygame`, ' +
        '`npm install`). Use this to install dependencies and run build steps yourself — NEVER just ' +
        'tell the user to run a command, emit it in a ```bash block instead. ' +
        fileFormat
      )
  }
}

/** A model in the curated download catalog. */
export interface CatalogModel {
  /** `ollama pull` name. */
  name: string
  /** Approximate VRAM/download size (GB). */
  vramGb: number
  description: string
}

/**
 * Curated selection of coding-capable models in the 4–12 GB VRAM range, shown
 * in Settings → Ollama so users can pick and download one that fits their GPU.
 */
export const MODEL_CATALOG: CatalogModel[] = [
  { name: 'mistral:7b', vramGb: 4.1, description: 'Fast, efficient general-purpose. Great starter model on modest GPUs.' },
  { name: 'qwen2.5-coder:7b', vramGb: 4.7, description: 'Best-in-class small coding model — generation, completion, refactoring.' },
  { name: 'qwen2.5:7b', vramGb: 4.7, description: 'Strong general-purpose + reasoning at 7B.' },
  { name: 'llama3.1:8b', vramGb: 4.9, description: 'Meta Llama 3.1 — well-rounded chat and coding.' },
  { name: 'gemma2:9b', vramGb: 5.4, description: 'Google Gemma 2 — strong general-purpose.' },
  { name: 'codellama:13b', vramGb: 7.4, description: 'Code Llama 13B — code-specialized, more capable than 7B.' },
  { name: 'llama3.2-vision:11b', vramGb: 7.9, description: 'Reads images/screenshots plus general chat — good for UI work.' },
  { name: 'deepseek-coder-v2:16b', vramGb: 8.9, description: 'Top-tier coding with large context (MoE). Needs ~9 GB.' },
  { name: 'qwen2.5-coder:14b', vramGb: 9.0, description: 'Larger Qwen Coder — stronger coding, needs ~9 GB.' },
  { name: 'phi4:14b', vramGb: 9.1, description: 'Microsoft Phi-4 — excellent reasoning for its size.' }
]

/** Available cloud models offered per provider in the settings dropdowns. */
export const PROVIDER_MODELS: Record<ProviderId, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
  anthropic: [
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-opus-latest'
  ],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner']
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek'
}

/** Rough per-1K-token pricing (USD) for cost estimation. input/output. */
export const PROVIDER_PRICING: Record<
  string,
  { inputPer1k: number; outputPer1k: number }
> = {
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'gpt-4-turbo': { inputPer1k: 0.01, outputPer1k: 0.03 },
  o1: { inputPer1k: 0.015, outputPer1k: 0.06 },
  'o1-mini': { inputPer1k: 0.003, outputPer1k: 0.012 },
  'claude-3-5-sonnet-latest': { inputPer1k: 0.003, outputPer1k: 0.015 },
  'claude-3-5-haiku-latest': { inputPer1k: 0.0008, outputPer1k: 0.004 },
  'claude-3-opus-latest': { inputPer1k: 0.015, outputPer1k: 0.075 },
  'gemini-2.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.005 },
  'gemini-2.5-flash': { inputPer1k: 0.0003, outputPer1k: 0.0025 },
  'gemini-1.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.005 },
  'deepseek-chat': { inputPer1k: 0.00027, outputPer1k: 0.0011 },
  'deepseek-reasoner': { inputPer1k: 0.00055, outputPer1k: 0.00219 }
}

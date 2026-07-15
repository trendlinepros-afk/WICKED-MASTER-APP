import type { ProviderId } from './config'

export type Role = 'user' | 'assistant' | 'system'

export type MessageKind = 'chat' | 'gemini-analysis'

/** A code change applied to disk, recorded for history/auditing. */
export interface FileChange {
  path: string
  action: 'create' | 'update' | 'delete'
  description?: string
}

export interface GeminiAnalysisData {
  /** base64 PNG (data URI without prefix) of the analyzed screenshot. */
  screenshotBase64: string
  analysis: string
  issueCount: number
  /** null while awaiting user decision (auto-fix disabled). */
  actionTaken: 'Fixed' | 'Skipped' | 'Auto-Fixed' | null
  changes: FileChange[]
}

export interface ChatMessage {
  id: string
  role: Role
  content: string
  kind: MessageKind
  /** Model id that produced an assistant message, e.g. "ollama:mistral:7b". */
  model?: string
  createdAt: string // ISO
  /** Present when kind === 'gemini-analysis'. */
  gemini?: GeminiAnalysisData
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string
  projectName: string | null
  messages: ChatMessage[]
  /** Relative path of the markdown file inside the Obsidian vault. */
  vaultRelativePath: string
}

/** Lightweight summary for the sidebar list. */
export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
  preview: string
  vaultRelativePath: string
}

export type ModelProvider = 'ollama' | ProviderId

/** A model exposed in the model switcher, local or cloud. */
export interface ModelDescriptor {
  /** Unique id: "ollama:<name>" or "<provider>:<model>". */
  id: string
  name: string
  provider: ModelProvider
  providerLabel: string
  /** true for Ollama models. */
  isLocal: boolean
  /** Estimated VRAM footprint (GB) for local models; null for cloud. */
  vramGb: number | null
  /** Whether the model can be selected right now. */
  available: boolean
  /** Reason it is unavailable (missing key / Ollama down / exceeds VRAM). */
  unavailableReason?: string
  /** Human hint like "~40 tok/s" for local models. */
  speedHint?: string
  /** One-line "what it's good at" description. */
  description?: string
}

export interface OllamaModelInfo {
  name: string
  sizeBytes: number
  /** true once loaded into memory (present in /api/ps). */
  loaded: boolean
}

export interface OllamaStatus {
  connected: boolean
  endpoint: string
  error?: string
  models: OllamaModelInfo[]
  /** Sum of VRAM (GB) currently occupied by loaded models (from /api/ps). */
  vramInUseGb: number
  /** Names of models currently loaded in memory. */
  loadedModels: string[]
}

export interface ProviderStatus {
  provider: ProviderId
  status: 'valid' | 'invalid' | 'unconfigured' | 'unknown'
  message?: string
}

/** Parameters for a chat completion request. */
export interface ChatRequest {
  modelId: string
  messages: { role: Role; content: string }[]
  temperature: number
  maxTokens: number
}

/** Streaming events emitted over the chat stream channel. */
export type ChatStreamEvent =
  | { type: 'token'; requestId: string; token: string }
  | { type: 'done'; requestId: string; content: string }
  | { type: 'error'; requestId: string; error: string }

/** Result of a token/cost estimate for a paid request. */
export interface CostEstimate {
  modelId: string
  isLocal: boolean
  inputTokens: number
  estimatedOutputTokens: number
  estimatedCostUsd: number
}

export interface FileNode {
  name: string
  path: string // relative to project root
  isDirectory: boolean
  children?: FileNode[]
}

export interface ProjectInfo {
  name: string
  rootPath: string
}

export type PreviewKind = 'static' | 'react' | 'node' | 'unknown'

export interface PreviewStatus {
  running: boolean
  url: string | null
  kind: PreviewKind
  error?: string
}

/** State of the project runner (Play button + diagnostics console). */
export interface RunStatus {
  running: boolean
  /** The command being run, e.g. "python main.py". */
  command: string | null
  exitCode: number | null
}

/** A parsed file-write directive extracted from an assistant response. */
export interface ParsedFileBlock {
  path: string
  content: string
  action: 'create' | 'update' | 'delete'
}

/** An external prerequisite (Ollama, Node.js) and whether it is installed. */
export interface Prereq {
  id: 'ollama' | 'node'
  name: string
  installed: boolean
  impact: string
  downloadUrl: string
}

/** Payload of the ollama pull-progress stream event. */
export interface PullProgress {
  name: string
  status: string
  percent: number
}

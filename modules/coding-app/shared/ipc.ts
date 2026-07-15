/**
 * IPC channel names and the typed API surface used by the renderer.
 *
 * Every renderer <-> main interaction goes through one of these channels. All
 * channels are namespaced `coding-app:<action>` per the WICKED module
 * contract. The renderer bridge (`lib/bridge.ts`) implements `AppApi` by
 * wrapping `window.wicked.invoke` / `window.wicked.on`; the module's `ipc.ts`
 * registers matching handlers in the main process. Keeping the channel strings
 * and the `AppApi` interface in one shared file keeps both sides in sync.
 *
 * Port note: the standalone app's `update:*` channels (electron-updater) were
 * removed — the WICKED shell owns app updates. `app:version` was removed too;
 * the renderer reads the module version straight from module.json.
 */

import type { AppConfig } from './config'
import type {
  ChatRequest,
  ChatStreamEvent,
  Conversation,
  ConversationSummary,
  CostEstimate,
  FileNode,
  GeminiAnalysisData,
  ModelDescriptor,
  OllamaStatus,
  ProjectInfo,
  PreviewStatus,
  Prereq,
  ProviderStatus,
  PullProgress,
  RunStatus
} from './types'

const NS = 'coding-app'

export const IPC = {
  // Config
  configGet: `${NS}:config-get`,
  configUpdate: `${NS}:config-update`,
  configPath: `${NS}:config-path`,
  configRestoreBackup: `${NS}:config-restore-backup`,

  // Models
  modelsList: `${NS}:models-list`,

  // Ollama
  ollamaStatus: `${NS}:ollama-status`,
  ollamaStart: `${NS}:ollama-start`,
  ollamaLoadModel: `${NS}:ollama-load-model`,
  ollamaUnloadModel: `${NS}:ollama-unload-model`,
  ollamaPullModel: `${NS}:ollama-pull-model`,
  ollamaPullProgress: `${NS}:ollama-pull-progress`, // main -> renderer event
  ollamaCancelPull: `${NS}:ollama-cancel-pull`,

  // Providers
  providerTest: `${NS}:provider-test`,

  // Chat
  chatSend: `${NS}:chat-send`,
  chatStream: `${NS}:chat-stream`, // main -> renderer event
  chatStop: `${NS}:chat-stop`,
  chatEstimateCost: `${NS}:chat-estimate-cost`,

  // Conversations
  convList: `${NS}:conv-list`,
  convLoad: `${NS}:conv-load`,
  convSave: `${NS}:conv-save`,
  convDelete: `${NS}:conv-delete`,

  // Projects / files
  projectCreate: `${NS}:project-create`,
  projectOpen: `${NS}:project-open`,
  projectSetActive: `${NS}:project-set-active`,
  fileTree: `${NS}:file-tree`,
  fileRead: `${NS}:file-read`,
  fileWrite: `${NS}:file-write`,
  fileDelete: `${NS}:file-delete`,
  fileRename: `${NS}:file-rename`,
  fileApplyBlocks: `${NS}:file-apply-blocks`,
  filePreviewBlocks: `${NS}:file-preview-blocks`,
  fileChanged: `${NS}:file-changed`, // main -> renderer event (watcher)

  // Preview
  previewStart: `${NS}:preview-start`,
  previewStop: `${NS}:preview-stop`,
  previewStatus: `${NS}:preview-status`,

  // Run (Play button + diagnostics console)
  runStart: `${NS}:run-start`,
  runStop: `${NS}:run-stop`,
  runStatus: `${NS}:run-status`,
  runCommand: `${NS}:run-command`,
  runLog: `${NS}:run-log`, // main -> renderer event
  runExit: `${NS}:run-exit`, // main -> renderer event

  // Screenshot + Gemini
  screenshotCapture: `${NS}:screenshot-capture`,
  geminiAnalyze: `${NS}:gemini-analyze`,
  geminiApplyFix: `${NS}:gemini-apply-fix`,

  // Dialogs / misc
  dialogPickFolder: `${NS}:pick-folder`,
  logsExport: `${NS}:logs-export`,
  openExternal: `${NS}:open-external`,
  prereqsCheck: `${NS}:prereqs-check`,
  gpuDetectVram: `${NS}:gpu-detect-vram`
} as const

/** The typed API implemented by `lib/bridge.ts` over `window.wicked`. */
export interface AppApi {
  // Config
  getConfig(): Promise<AppConfig>
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  getConfigPath(): Promise<string>
  restoreConfigBackup(): Promise<AppConfig>

  // Models
  listModels(): Promise<ModelDescriptor[]>

  // Ollama
  getOllamaStatus(): Promise<OllamaStatus>
  startOllama(): Promise<OllamaStatus>
  loadOllamaModel(name: string): Promise<{ ok: boolean; error?: string }>
  unloadOllamaModel(name: string): Promise<{ ok: boolean; error?: string }>
  pullOllamaModel(name: string): Promise<{ ok: boolean; error?: string }>
  cancelOllamaPull(name: string): Promise<void>
  onOllamaPullProgress(cb: (p: PullProgress) => void): () => void

  // Providers
  testProvider(provider: string): Promise<ProviderStatus>

  // Chat
  sendChat(req: ChatRequest): Promise<{ requestId: string }>
  stopChat(requestId: string): Promise<void>
  estimateCost(req: ChatRequest): Promise<CostEstimate>
  onChatStream(cb: (e: ChatStreamEvent) => void): () => void

  // Conversations
  listConversations(): Promise<ConversationSummary[]>
  loadConversation(id: string): Promise<Conversation | null>
  saveConversation(conv: Conversation): Promise<Conversation>
  deleteConversation(id: string): Promise<void>

  // Projects / files
  createProject(name: string): Promise<ProjectInfo>
  openProject(rootPath: string): Promise<ProjectInfo>
  setActiveProject(rootPath: string): Promise<ProjectInfo>
  getFileTree(): Promise<FileNode[]>
  readFile(relPath: string): Promise<string>
  writeFile(relPath: string, content: string): Promise<void>
  deleteFile(relPath: string): Promise<void>
  renameFile(relPath: string, newRelPath: string): Promise<void>
  applyFileBlocks(raw: string): Promise<{ path: string; action: string }[]>
  previewFileBlocks(raw: string): Promise<{ path: string; action: string }[]>
  onFileChanged(cb: (path: string) => void): () => void

  // Preview
  startPreview(): Promise<PreviewStatus>
  stopPreview(): Promise<void>
  getPreviewStatus(): Promise<PreviewStatus>

  // Run
  startRun(): Promise<RunStatus>
  stopRun(): Promise<void>
  getRunStatus(): Promise<RunStatus>
  runCommand(command: string): Promise<number | null>
  onRunLog(cb: (line: string) => void): () => void
  onRunExit(cb: (code: number | null) => void): () => void

  // Screenshot + Gemini
  captureScreenshot(): Promise<{ base64: string } | { error: string }>
  analyzeScreenshot(base64: string): Promise<GeminiAnalysisData | { error: string }>
  applyGeminiFix(
    analysis: GeminiAnalysisData
  ): Promise<{ ok: boolean; changes: GeminiAnalysisData['changes']; error?: string }>

  // Dialogs / misc
  pickFolder(): Promise<string | null>
  exportLogs(): Promise<string | null>
  openExternal(url: string): Promise<void>
  checkPrereqs(): Promise<Prereq[]>
  /** Auto-detect total GPU VRAM (GB); null if it can't be determined. */
  detectGpuVram(): Promise<number | null>
}

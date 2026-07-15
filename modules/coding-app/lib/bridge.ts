/**
 * Renderer-side bridge. The standalone app exposed a preload-built
 * `window.api` (AppApi); inside WICKED the shell exposes only the generic
 * `window.wicked.invoke/on` bridge, so this file recreates the exact same
 * typed `api` object on top of it, with all channels renamed to
 * `coding-app:*`. Components import { api } from '../lib/bridge' instead of
 * touching window.api.
 */
import { IPC, type AppApi } from '../shared/ipc'
import type { AppConfig } from '../shared/config'
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
  Prereq,
  PreviewStatus,
  ProjectInfo,
  ProviderStatus,
  PullProgress,
  RunStatus
} from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.wicked.invoke(channel, ...args) as Promise<T>
}

/** Subscribe to a main->renderer event; returns an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  return window.wicked.on(channel, (...args: unknown[]) => cb(args[0] as T))
}

export const api: AppApi = {
  // Config
  getConfig: () => invoke<AppConfig>(IPC.configGet),
  updateConfig: (patch) => invoke<AppConfig>(IPC.configUpdate, patch),
  getConfigPath: () => invoke<string>(IPC.configPath),
  restoreConfigBackup: () => invoke<AppConfig>(IPC.configRestoreBackup),

  // Models
  listModels: () => invoke<ModelDescriptor[]>(IPC.modelsList),

  // Ollama
  getOllamaStatus: () => invoke<OllamaStatus>(IPC.ollamaStatus),
  startOllama: () => invoke<OllamaStatus>(IPC.ollamaStart),
  loadOllamaModel: (name) =>
    invoke<{ ok: boolean; error?: string }>(IPC.ollamaLoadModel, name),
  unloadOllamaModel: (name) =>
    invoke<{ ok: boolean; error?: string }>(IPC.ollamaUnloadModel, name),
  pullOllamaModel: (name) =>
    invoke<{ ok: boolean; error?: string }>(IPC.ollamaPullModel, name),
  cancelOllamaPull: (name) => invoke<void>(IPC.ollamaCancelPull, name),
  onOllamaPullProgress: (cb) => subscribe<PullProgress>(IPC.ollamaPullProgress, cb),

  // Providers
  testProvider: (provider) => invoke<ProviderStatus>(IPC.providerTest, provider),

  // Chat
  sendChat: (req: ChatRequest) => invoke<{ requestId: string }>(IPC.chatSend, req),
  stopChat: (requestId) => invoke<void>(IPC.chatStop, requestId),
  estimateCost: (req: ChatRequest) => invoke<CostEstimate>(IPC.chatEstimateCost, req),
  onChatStream: (cb) => subscribe<ChatStreamEvent>(IPC.chatStream, cb),

  // Conversations
  listConversations: () => invoke<ConversationSummary[]>(IPC.convList),
  loadConversation: (id) => invoke<Conversation | null>(IPC.convLoad, id),
  saveConversation: (conv) => invoke<Conversation>(IPC.convSave, conv),
  deleteConversation: (id) => invoke<void>(IPC.convDelete, id),

  // Projects / files
  createProject: (name) => invoke<ProjectInfo>(IPC.projectCreate, name),
  openProject: (rootPath) => invoke<ProjectInfo>(IPC.projectOpen, rootPath),
  setActiveProject: (rootPath) => invoke<ProjectInfo>(IPC.projectSetActive, rootPath),
  getFileTree: () => invoke<FileNode[]>(IPC.fileTree),
  readFile: (relPath) => invoke<string>(IPC.fileRead, relPath),
  writeFile: (relPath, content) => invoke<void>(IPC.fileWrite, relPath, content),
  deleteFile: (relPath) => invoke<void>(IPC.fileDelete, relPath),
  renameFile: (relPath, newRelPath) => invoke<void>(IPC.fileRename, relPath, newRelPath),
  applyFileBlocks: (raw) =>
    invoke<{ path: string; action: string }[]>(IPC.fileApplyBlocks, raw),
  previewFileBlocks: (raw) =>
    invoke<{ path: string; action: string }[]>(IPC.filePreviewBlocks, raw),
  onFileChanged: (cb) => subscribe<string>(IPC.fileChanged, cb),

  // Preview
  startPreview: () => invoke<PreviewStatus>(IPC.previewStart),
  stopPreview: () => invoke<void>(IPC.previewStop),
  getPreviewStatus: () => invoke<PreviewStatus>(IPC.previewStatus),

  // Run
  startRun: () => invoke<RunStatus>(IPC.runStart),
  stopRun: () => invoke<void>(IPC.runStop),
  getRunStatus: () => invoke<RunStatus>(IPC.runStatus),
  runCommand: (command) => invoke<number | null>(IPC.runCommand, command),
  onRunLog: (cb) => subscribe<string>(IPC.runLog, cb),
  onRunExit: (cb) => subscribe<number | null>(IPC.runExit, cb),

  // Screenshot + Gemini
  captureScreenshot: () =>
    invoke<{ base64: string } | { error: string }>(IPC.screenshotCapture),
  analyzeScreenshot: (base64) =>
    invoke<GeminiAnalysisData | { error: string }>(IPC.geminiAnalyze, base64),
  applyGeminiFix: (analysis) =>
    invoke<{ ok: boolean; changes: GeminiAnalysisData['changes']; error?: string }>(
      IPC.geminiApplyFix,
      analysis
    ),

  // Dialogs / misc
  pickFolder: () => invoke<string | null>(IPC.dialogPickFolder),
  exportLogs: () => invoke<string | null>(IPC.logsExport),
  openExternal: (url) => invoke<void>(IPC.openExternal, url),
  checkPrereqs: () => invoke<Prereq[]>(IPC.prereqsCheck),
  detectGpuVram: () => invoke<number | null>(IPC.gpuDetectVram)
}

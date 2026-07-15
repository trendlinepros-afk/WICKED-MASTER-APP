import { create } from 'zustand'
import { SHELL_IPC } from '@shared/types'
import { modeSystemPrompt, type AppConfig, type ChatMode } from './shared/config'
import type {
  ChatMessage,
  ChatRequest,
  Conversation,
  ConversationSummary,
  CostEstimate,
  FileNode,
  GeminiAnalysisData,
  ModelDescriptor,
  OllamaStatus,
  PreviewStatus,
  ProjectInfo,
  RunStatus
} from './shared/types'
import { api } from './lib/bridge'

export type RightPanelMode = 'editor' | 'preview' | 'run'

/** A pending paid-request confirmation surfaced as a modal. */
export interface PendingSend {
  estimate: CostEstimate
  text: string
}

interface AppState {
  // Config
  config: AppConfig | null
  loadConfig: () => Promise<void>
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>

  // Shell API-key vault presence (provider id -> key set?). Values never
  // reach the renderer — booleans only, from SHELL_IPC.apiKeysStatus.
  apiKeys: Record<string, boolean>
  refreshApiKeys: () => Promise<void>
  setApiKeys: (status: Record<string, boolean>) => void

  // Models
  models: ModelDescriptor[]
  selectedModelId: string | null
  refreshModels: () => Promise<void>
  selectModel: (id: string) => Promise<void>
  toggleFavorite: (id: string) => Promise<void>

  // Ollama
  ollamaStatus: OllamaStatus | null
  refreshOllama: () => Promise<void>

  // Conversation
  conversations: ConversationSummary[]
  current: Conversation | null
  refreshConversations: () => Promise<void>
  newConversation: () => void
  loadConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>

  // Chat mode (plan / ask / auto)
  setChatMode: (mode: ChatMode) => Promise<void>

  // Chat streaming
  isStreaming: boolean
  currentRequestId: string | null
  pendingSend: PendingSend | null
  sendMessage: (text: string) => Promise<void>
  confirmPendingSend: () => Promise<void>
  cancelPendingSend: () => void
  stopStreaming: () => void

  // Pending file edits / commands awaiting approval (ask mode)
  pendingEdits: {
    raw: string
    files: { path: string; action: string }[]
    commands: string[]
  } | null
  applyPendingEdits: () => Promise<void>
  rejectPendingEdits: () => void
  runShellCommands: (commands: string[]) => Promise<void>

  // Project / files
  project: ProjectInfo | null
  fileTree: FileNode[]
  openFilePath: string | null
  openFileContent: string
  createProject: (name: string) => Promise<void>
  openProject: (rootPath: string) => Promise<void>
  _trackRecentProject: (rootPath: string) => Promise<void>
  refreshFileTree: () => Promise<void>
  openFile: (relPath: string) => Promise<void>
  saveOpenFile: (content: string) => Promise<void>
  deleteFile: (relPath: string) => Promise<void>

  // Right panel / preview
  rightPanelMode: RightPanelMode
  setRightPanelMode: (m: RightPanelMode) => void
  previewStatus: PreviewStatus | null
  startPreview: () => Promise<void>
  stopPreview: () => Promise<void>

  // Project runner (Play + diagnostics console)
  runStatus: RunStatus | null
  runLogs: string[]
  startRun: () => Promise<void>
  stopRun: () => Promise<void>
  clearRunLogs: () => void
  handleRunLog: (line: string) => void
  handleRunExit: (code: number | null) => void

  // Gemini analysis
  analyzeCurrentPreview: () => Promise<void>
  resolveGeminiAnalysis: (messageId: string, fix: boolean) => Promise<void>

  // Settings
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  // New-project dialog
  newProjectOpen: boolean
  setNewProjectOpen: (open: boolean) => void

  // Banner
  banner: { kind: 'error' | 'info'; text: string } | null
  setBanner: (b: AppState['banner']) => void

  // ---- Stream event handlers (called by the module-root subscription) ----
  handleStreamToken: (token: string) => void
  handleStreamDone: (content: string) => Promise<void>
  handleStreamError: (error: string) => void

  // ---- Internal helpers (prefixed _) ----
  _buildRequest: (text: string) => ChatRequest
  _dispatchSend: (text: string) => Promise<void>
  _appendMessage: (m: ChatMessage) => void
  _appendSystemMessage: (text: string) => void
  _patchGemini: (messageId: string, patch: Partial<GeminiAnalysisData>) => void
  _persistCurrent: () => Promise<void>
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const SHELL_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'console', 'shell-session', 'powershell',
  'ps1', 'cmd', 'bat', 'terminal'
])

/**
 * Extract runnable shell commands from an assistant response's ```bash-style
 * blocks — one command per non-empty, non-comment line, with leading prompt
 * markers (`$ `, `> `, `PS> `) stripped. This is what lets Full Auto actually
 * run `pip install ...` etc. instead of just showing it.
 */
function extractShellCommands(raw: string): string[] {
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g
  const commands: string[] = []
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(raw)) !== null) {
    const lang = (m[1].trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (!SHELL_LANGS.has(lang)) continue
    for (const rawLine of m[2].split('\n')) {
      const line = rawLine.replace(/^\s*(?:\$|>|PS[^>]*>|#\s*!)\s?/, '').trim()
      if (!line || line.startsWith('#')) continue
      commands.push(line)
    }
  }
  // De-dupe consecutive duplicates, cap to keep runs bounded.
  return commands.filter((c, i) => c !== commands[i - 1]).slice(0, 12)
}

function newBlankConversation(model: string): Conversation {
  const now = new Date().toISOString()
  return {
    id: uid('conv'),
    title: 'New conversation',
    createdAt: now,
    updatedAt: now,
    model,
    projectName: null,
    messages: [],
    vaultRelativePath: ''
  }
}

export const useStore = create<AppState>((set, get) => ({
  // ---- Config ----
  config: null,
  loadConfig: async () => {
    const config = await api.getConfig()
    set({ config, selectedModelId: config.lastSelectedModel })
  },
  updateConfig: async (patch) => {
    const config = await api.updateConfig(patch)
    set({ config })
  },

  // ---- Shell API-key vault presence ----
  apiKeys: {},
  refreshApiKeys: async () => {
    try {
      const status = (await window.wicked.invoke(SHELL_IPC.apiKeysStatus)) as Record<
        string,
        boolean
      >
      set({ apiKeys: status })
    } catch {
      // shell channel unavailable — leave the last known status
    }
  },
  setApiKeys: (apiKeys) => set({ apiKeys }),

  // ---- Models ----
  models: [],
  selectedModelId: null,
  refreshModels: async () => {
    const models = await api.listModels()
    set({ models })
    const sel = get().selectedModelId
    if (!sel || !models.find((m) => m.id === sel)) {
      const firstAvailable = models.find((m) => m.available)
      if (firstAvailable) set({ selectedModelId: firstAvailable.id })
    }
  },
  selectModel: async (id) => {
    set({ selectedModelId: id })
    await get().updateConfig({ lastSelectedModel: id })
    const current = get().current
    if (current) set({ current: { ...current, model: id } })
  },
  toggleFavorite: async (id) => {
    const favs = get().config?.favoriteModels ?? []
    const next = favs.includes(id)
      ? favs.filter((f) => f !== id)
      : [...favs, id]
    await get().updateConfig({ favoriteModels: next })
  },

  // ---- Ollama ----
  ollamaStatus: null,
  refreshOllama: async () => set({ ollamaStatus: await api.getOllamaStatus() }),

  // ---- Conversations ----
  conversations: [],
  current: null,
  refreshConversations: async () =>
    set({ conversations: await api.listConversations() }),
  newConversation: () =>
    set({ current: newBlankConversation(get().selectedModelId ?? 'ollama:unknown') }),
  loadConversation: async (id) => {
    const conv = await api.loadConversation(id)
    if (conv) set({ current: conv, selectedModelId: conv.model })
  },
  deleteConversation: async (id) => {
    await api.deleteConversation(id)
    if (get().current?.id === id) set({ current: null })
    await get().refreshConversations()
  },

  // ---- Chat mode ----
  setChatMode: async (mode) => {
    await get().updateConfig({ chatMode: mode })
  },

  // ---- Chat streaming ----
  isStreaming: false,
  currentRequestId: null,
  pendingSend: null,
  pendingEdits: null,

  applyPendingEdits: async () => {
    const pe = get().pendingEdits
    if (!pe) return
    set({ pendingEdits: null })
    try {
      const changes = await api.applyFileBlocks(pe.raw)
      if (changes.length) {
        await get().refreshFileTree()
        get()._appendSystemMessage(
          `✓ Applied ${changes.length} file change(s): ${changes.map((c) => c.path).join(', ')}`
        )
      }
      if (pe.commands.length) await get().runShellCommands(pe.commands)
      await get()._persistCurrent()
    } catch (err) {
      get().setBanner({ kind: 'error', text: `Apply failed: ${(err as Error).message}` })
    }
  },
  rejectPendingEdits: () => {
    if (!get().pendingEdits) return
    set({ pendingEdits: null })
    get()._appendSystemMessage('✗ Changes rejected — nothing was written.')
    void get()._persistCurrent()
  },
  runShellCommands: async (commands) => {
    if (!commands.length) return
    // Show the console so the user sees the commands run live.
    set({ rightPanelMode: 'run', runLogs: [] })
    get()._appendSystemMessage(
      `Auto-running ${commands.length} command(s): ${commands.join(' && ')}`
    )
    for (const c of commands) {
      await api.runCommand(c)
    }
    await get().refreshFileTree()
  },

  sendMessage: async (text) => {
    if (!text.trim() || get().isStreaming) return
    // Require an active project so generated files have a destination.
    if (!get().project) {
      get().setBanner({
        kind: 'error',
        text: 'Create or open a project before chatting.'
      })
      return
    }
    const modelId = get().selectedModelId
    if (!modelId) {
      get().setBanner({ kind: 'error', text: 'No model selected.' })
      return
    }
    const model = get().models.find((m) => m.id === modelId)
    if (model && !model.available) {
      get().setBanner({
        kind: 'error',
        text: `Model unavailable: ${model.unavailableReason ?? 'unknown reason'}`
      })
      return
    }
    // Cloud models: confirm token/cost before spending.
    if (model && !model.isLocal) {
      const estimate = await api.estimateCost(get()._buildRequest(text))
      set({ pendingSend: { estimate, text } })
      return
    }
    await get()._dispatchSend(text)
  },

  confirmPendingSend: async () => {
    const pending = get().pendingSend
    if (!pending) return
    set({ pendingSend: null })
    await get()._dispatchSend(pending.text)
  },
  cancelPendingSend: () => set({ pendingSend: null }),

  stopStreaming: () => {
    const id = get().currentRequestId
    if (id) void api.stopChat(id)
    set({ isStreaming: false, currentRequestId: null })
  },

  // ---- Project / files ----
  project: null,
  fileTree: [],
  openFilePath: null,
  openFileContent: '',
  createProject: async (name) => {
    const project = await api.createProject(name)
    set({ project })
    await get()._trackRecentProject(project.rootPath)
    await get().refreshFileTree()
    const current = get().current
    if (current) set({ current: { ...current, projectName: project.name } })
  },
  openProject: async (rootPath) => {
    const project = await api.openProject(rootPath)
    set({ project })
    await get()._trackRecentProject(project.rootPath)
    await get().refreshFileTree()
  },
  _trackRecentProject: async (rootPath) => {
    const existing = get().config?.recentProjects ?? []
    const recent = [rootPath, ...existing.filter((p) => p !== rootPath)].slice(0, 8)
    await get().updateConfig({ recentProjects: recent })
  },
  refreshFileTree: async () => {
    if (!get().project) return
    try {
      set({ fileTree: await api.getFileTree() })
    } catch {
      set({ fileTree: [] })
    }
  },
  openFile: async (relPath) => {
    try {
      const content = await api.readFile(relPath)
      set({ openFilePath: relPath, openFileContent: content })
    } catch (err) {
      get().setBanner({
        kind: 'error',
        text: `Cannot open ${relPath}: ${(err as Error).message}`
      })
    }
  },
  saveOpenFile: async (content) => {
    const path = get().openFilePath
    if (!path) return
    await api.writeFile(path, content)
    set({ openFileContent: content })
    await get().refreshFileTree()
  },
  deleteFile: async (relPath) => {
    await api.deleteFile(relPath)
    if (get().openFilePath === relPath) set({ openFilePath: null, openFileContent: '' })
    await get().refreshFileTree()
  },

  // ---- Right panel / preview ----
  rightPanelMode: 'editor',
  setRightPanelMode: (m) => set({ rightPanelMode: m }),
  previewStatus: null,
  startPreview: async () => {
    const previewStatus = await api.startPreview()
    set({ previewStatus })
    if (previewStatus.error) get().setBanner({ kind: 'error', text: previewStatus.error })
  },
  stopPreview: async () => {
    await api.stopPreview()
    set({ previewStatus: null })
  },

  // ---- Project runner ----
  runStatus: null,
  runLogs: [],
  startRun: async () => {
    // Fresh console for each run; switch the right panel to the Run view.
    set({ runLogs: [], rightPanelMode: 'run' })
    const runStatus = await api.startRun()
    set({ runStatus })
  },
  stopRun: async () => {
    await api.stopRun()
    const rs = get().runStatus
    set({ runStatus: rs ? { ...rs, running: false } : null })
  },
  clearRunLogs: () => set({ runLogs: [] }),
  handleRunLog: (line) => {
    // Keep the console bounded so a chatty process can't grow memory forever.
    const logs = [...get().runLogs, line]
    set({ runLogs: logs.length > 2000 ? logs.slice(-2000) : logs })
  },
  handleRunExit: (code) => {
    const rs = get().runStatus
    set({ runStatus: rs ? { ...rs, running: false, exitCode: code } : null })
    // Auto-report a failed run to the chat so the AI can diagnose/fix it.
    if (
      code !== 0 &&
      code !== null &&
      get().config?.autoDebugRunErrors &&
      !get().isStreaming &&
      get().project &&
      get().selectedModelId
    ) {
      const logs = get().runLogs.slice(-60).join('\n')
      const command = rs?.command ?? 'the project'
      const message =
        `I ran the project (\`${command}\`) and it failed with exit code ${code}. ` +
        `Here is the output:\n\n\`\`\`\n${logs}\n\`\`\`\n\n` +
        `Diagnose the failure and fix it — update the code if the bug is in it, ` +
        `or tell me exactly what to install/run if it's a missing dependency.`
      void get().sendMessage(message)
    }
  },

  // ---- Gemini analysis ----
  analyzeCurrentPreview: async () => {
    const cfg = get().config
    if (!cfg?.geminiAnalysisEnabled) {
      get().setBanner({ kind: 'error', text: 'Gemini analysis is disabled or unconfigured.' })
      return
    }
    if (!get().current) get().newConversation()
    const shot = await api.captureScreenshot()
    if ('error' in shot) {
      get()._appendSystemMessage(`⚠️ ${shot.error}`)
      await get()._persistCurrent()
      return
    }
    const result = await api.analyzeScreenshot(shot.base64)
    if ('error' in result) {
      get()._appendSystemMessage(`⚠️ ${result.error}`)
      await get()._persistCurrent()
      return
    }
    const message: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      kind: 'gemini-analysis',
      content: '',
      createdAt: new Date().toISOString(),
      gemini: result
    }
    get()._appendMessage(message)
    if (cfg.autoFixFromGemini) {
      get()._appendSystemMessage(`Gemini detected ${result.issueCount} issue(s). Auto-fixing...`)
      await get().resolveGeminiAnalysis(message.id, true)
    }
    await get()._persistCurrent()
  },

  resolveGeminiAnalysis: async (messageId, fix) => {
    const current = get().current
    if (!current) return
    const msg = current.messages.find((m) => m.id === messageId)
    if (!msg?.gemini) return
    const autoFix = get().config?.autoFixFromGemini
    if (!fix) {
      get()._patchGemini(messageId, { actionTaken: 'Skipped' })
      await get()._persistCurrent()
      return
    }
    const res = await api.applyGeminiFix(msg.gemini)
    if (res.ok) {
      get()._patchGemini(messageId, {
        actionTaken: autoFix ? 'Auto-Fixed' : 'Fixed',
        changes: res.changes
      })
      get()._appendSystemMessage(`Applied ${res.changes.length} file change(s).`)
      await get().refreshFileTree()
    } else {
      get()._appendSystemMessage(`⚠️ Auto-fix failed: ${res.error}`)
    }
    await get()._persistCurrent()
  },

  // ---- Settings ----
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  // ---- New-project dialog ----
  newProjectOpen: false,
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),

  // ---- Banner ----
  banner: null,
  setBanner: (banner) => set({ banner }),

  // ---- Stream event handlers ----
  handleStreamToken: (token) => {
    const current = get().current
    if (!current) return
    const messages = [...current.messages]
    const last = messages[messages.length - 1]
    if (last && last.role === 'assistant' && last.kind === 'chat') {
      messages[messages.length - 1] = { ...last, content: last.content + token }
      set({ current: { ...current, messages } })
    }
  },

  handleStreamDone: async (_content) => {
    set({ isStreaming: false, currentRequestId: null })
    const current = get().current
    if (!current) return
    const last = current.messages[current.messages.length - 1]
    const mode = get().config?.chatMode ?? 'ask'
    // Handle the assistant's file blocks according to the active mode.
    if (last?.role === 'assistant' && last.content && get().project) {
      const commands = extractShellCommands(last.content)
      if (mode === 'auto') {
        // Full auto: write files, then run any shell commands (installs, etc.).
        try {
          const changes = await api.applyFileBlocks(last.content)
          if (changes.length) {
            await get().refreshFileTree()
            get()._appendSystemMessage(
              `Wrote ${changes.length} file(s): ${changes.map((c) => c.path).join(', ')}`
            )
          }
        } catch {
          // non-fatal
        }
        if (commands.length) await get().runShellCommands(commands)
      } else if (mode === 'ask') {
        // Ask: preview the changes/commands and wait for approval.
        try {
          const files = await api.previewFileBlocks(last.content)
          if (files.length || commands.length) {
            set({ pendingEdits: { raw: last.content, files, commands } })
          }
        } catch {
          // non-fatal
        }
      }
      // 'plan': never writes; the AI was instructed not to emit file blocks.
    }
    await get()._persistCurrent()
    // A chat request lazily loads the model in Ollama; refresh so the
    // Load/Unload button and VRAM meter reflect that it's now resident.
    void get().refreshOllama()
    // Auto-analyze the live preview after a completed task, if enabled.
    if (get().config?.geminiAnalysisEnabled && get().previewStatus?.running) {
      await get().analyzeCurrentPreview()
    }
  },

  handleStreamError: (error) => {
    set({ isStreaming: false, currentRequestId: null })
    get().setBanner({ kind: 'error', text: `Model error: ${error}` })
    const current = get().current
    if (current) {
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && !last.content) {
        messages[messages.length - 1] = {
          ...last,
          content: `⚠️ ${error}. Try another model?`
        }
        set({ current: { ...current, messages } })
      }
    }
  },

  // ---- Internal helpers ----
  _buildRequest: (text) => {
    const cfg = get().config!
    const project = get().project
    // Lead with a system message describing the active mode (plan/ask/auto) and
    // the project context, so the model knows what it may do and where.
    const systemParts = [modeSystemPrompt(cfg.chatMode)]
    if (project) {
      systemParts.push(
        `The active project is "${project.name}". Use file paths relative to the project root.`
      )
    }
    const history = (get().current?.messages ?? [])
      .filter((m) => m.kind === 'chat' && m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))
    return {
      modelId: get().selectedModelId!,
      messages: [
        { role: 'system' as const, content: systemParts.join(' ') },
        ...history,
        { role: 'user' as const, content: text }
      ],
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens
    }
  },

  _dispatchSend: async (text) => {
    const selectedModelId = get().selectedModelId!
    // Build the request from the history BEFORE appending the new turn, so the
    // user message is not duplicated and the empty assistant placeholder is
    // excluded.
    const req = get()._buildRequest(text)
    let current = get().current ?? newBlankConversation(selectedModelId)
    const now = new Date().toISOString()
    const userMsg: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      kind: 'chat',
      content: text,
      createdAt: now
    }
    const assistantMsg: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      kind: 'chat',
      content: '',
      model: selectedModelId,
      createdAt: now
    }
    if (current.messages.length === 0) current = { ...current, title: text.slice(0, 60) }
    current = {
      ...current,
      model: selectedModelId,
      projectName: get().project?.name ?? current.projectName,
      messages: [...current.messages, userMsg, assistantMsg]
    }
    set({ current, isStreaming: true, pendingEdits: null })
    const { requestId } = await api.sendChat(req)
    set({ currentRequestId: requestId })
  },

  _appendMessage: (m) => {
    const current = get().current
    if (!current) return
    set({ current: { ...current, messages: [...current.messages, m] } })
  },

  _appendSystemMessage: (text) =>
    get()._appendMessage({
      id: uid('msg'),
      role: 'system',
      kind: 'chat',
      content: text,
      createdAt: new Date().toISOString()
    }),

  _patchGemini: (messageId, patch) => {
    const current = get().current
    if (!current) return
    const messages = current.messages.map((m) =>
      m.id === messageId && m.gemini ? { ...m, gemini: { ...m.gemini, ...patch } } : m
    )
    set({ current: { ...current, messages } })
  },

  _persistCurrent: async () => {
    const current = get().current
    if (!current || !get().config?.obsidianVaultPath) return
    try {
      const saved = await api.saveConversation(current)
      set({ current: saved })
      await get().refreshConversations()
    } catch {
      // vault not set or write failed; ignore
    }
  }
}))

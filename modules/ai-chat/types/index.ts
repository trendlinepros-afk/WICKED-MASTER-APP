export type Provider = 'openai' | 'gemini' | 'deepseek' | 'ollama';

export interface Folder {
  id: string;
  name: string;
  parentId: string | null; // null = top-level folder
  createdAt: number;
}

export interface Chat {
  id: string;
  title: string;
  folderId: string | null; // null = uncategorized
  provider: Provider;
  modelVersion: string;
  createdAt: number;
  updatedAt: number;
  systemPrompt: string;
  noMemory: boolean; // opt out of scheduled auto-commit to memory
  lastCommittedAt: number; // when this chat was last saved to the vault
  agentPersonaId: string | null; // bound "brain" persona this chat answers as
}

// A vault-backed persona ("brain"): answers as a specific person, grounded in the
// markdown docs inside a chosen Obsidian folder.
export interface AgentPersona {
  id: string;
  name: string;
  avatar: string;
  systemPrompt: string; // instructs the model to embody the person
  vaultPath: string; // folder holding this brain's markdown documents
  createdAt: number;
  updatedAt: number;
}

// A markdown document read from a brain folder.
export interface BrainDoc {
  path: string;
  title: string;
  body: string;
}

export interface DeletedChat extends Chat {
  deletedAt: number;
}

export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: number;
}

export interface MessageSearchHit {
  chatId: string;
  chatTitle: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: number;
}

export interface ContentPart {
  type: 'text' | 'image_url' | 'file';
  text?: string;
  image_url?: { url: string }; // base64 data URL
  name?: string;
  mime?: string;
  data?: string; // base64 for non-image files
}

export interface Message {
  id: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system';
  content: ContentPart[];
  createdAt: number;
  // The model that produced this message (assistant messages), so the bubble
  // tag is stable even if the chat's model is later changed.
  provider?: Provider;
  modelVersion?: string;
}

export interface VaultNote {
  path: string; // relative to vault root
  title: string;
  category: string;
  tags: string[];
  date: string;
  body: string;
  status?: string;
  embedding?: number[]; // stored in .embeddings.json sidecar
}

export interface MemoryReview {
  summary: string;
  keyPoints: string[];
  ideas: string[];
  openQuestions: string[];
  tags: string[];
  category: string;
}

// ---------- Project Board ----------
// A freeform OneNote-style canvas per project: text notes and images placed
// anywhere, freehand ink on top, notes taggable with a category and priority.
// All data lives as plain files in a user-mappable folder (e.g. a network
// drive) so it can be backed up outside the app.

export interface Project {
  id: string;
  name: string;
  icon: string; // emoji shown in the project list
  createdAt: number;
  updatedAt: number;
}

export type BoardPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface BoardItem {
  id: string;
  type: 'text' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  z: number; // stacking order
  text?: string; // text items
  color?: string; // text items — note tint key (see NOTE_COLORS)
  assetId?: string; // image items — file in the project's assets folder
  category: string; // free-text label ('' = none)
  priority: BoardPriority;
}

// A freehand pen stroke drawn on the board.
export interface BoardStroke {
  id: string;
  color: string;
  size: number;
  points: [number, number][];
}

export interface BoardData {
  items: BoardItem[];
  strokes: BoardStroke[];
  categories: string[]; // every category ever used, for quick re-pick
  updatedAt: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Port note: provider API keys are NOT part of module settings anymore — they
// live in the WICKED shell's central vault (Settings → API Keys) and are read
// in the main process only. The renderer sees presence booleans, never values.
export interface Settings {
  vaultPath: string;
  defaultProvider: Provider;
  defaultModelVersion: string;
  semanticIndexingEnabled: boolean;
  ollamaBaseUrl: string; // e.g. http://localhost:11434
  autoMemoryEnabled: boolean; // periodically commit chats to memory
  autoMemoryIntervalMinutes: number; // how often the scheduler runs
  // Where Project Board data lives ('' = the app's user-data folder). Point it
  // at a network drive to keep boards backed up.
  projectBoardPath: string;
  // LAN web portal: serve the app to browsers on the local network while the
  // desktop app runs. OFF by default; the access token stays in the main
  // process (portal URLs from portalGetStatus already carry it).
  webPortalEnabled: boolean;
  webPortalPort: number;
  // Voice (dictation, call mode, read-aloud) — powered by the OpenAI key.
  sttModel: string; // speech-to-text model
  ttsModel: string; // text-to-speech model
  ttsVoice: string; // text-to-speech voice name
  // One root folder (e.g. a network share) holding all file-based app data
  // plus rolling database backups. '' = not configured.
  dataRootPath: string;
  // Local image generation via a user-run ComfyUI instance.
  comfyUrl: string;
  comfyCheckpoint: string;
  // Which sampler family the checkpoint needs: '' = auto-detect from the
  // filename, or an explicit 'flux' / 'sdxl' override. Wrong family = melted
  // anatomy, so users can pin it when the filename isn't obvious.
  comfyModelFamily: '' | 'flux' | 'sdxl';
  comfyWorkflow: string; // optional custom API-format workflow with {{PROMPT}}/{{SEED}}
  // ComfyUI folder (or launch script) that WICKED starts in the background at
  // app launch and stops on quit. '' = the user manages ComfyUI themselves.
  comfyLaunchPath: string;
  // FluxGym folder (Pinokio install or plain checkout) used to train Person
  // LoRAs. '' = auto-detect the usual Pinokio locations.
  fluxGymPath: string;
}

// Local image generation (ComfyUI) status + installed models.
export interface ComfyStatus {
  reachable: boolean;
  deviceName: string;
  vramTotal: number;
  vramFree: number;
  managed: boolean; // a launch path is configured
  processRunning: boolean; // WICKED's managed ComfyUI process is alive
  lastLog?: string; // last console line from the managed process (diagnostics)
  error?: string;
}

export interface ComfyModels {
  checkpoints: string[];
  loras: string[];
}

// FluxGym (LoRA trainer) install/run state, shown in the Person wizard.
export interface FluxGymStatus {
  installed: boolean; // a FluxGym folder was found (configured or auto-detected)
  root: string; // the resolved folder ('' when not found)
  autoDetected: boolean; // root came from probing Pinokio's usual locations
  running: boolean; // the Gradio UI answers on its port
  url: string; // where the UI lives (http://127.0.0.1:7860)
  processRunning: boolean; // WICKED's own managed FluxGym process is alive
  error?: string;
}

// An image chosen for LoRA training: full path stays in the main process;
// only a small thumbnail crosses the IPC boundary.
export interface TrainingImage {
  path: string;
  name: string;
  thumb: string; // small data-URL preview
}

// Poll result while a Person's LoRA is training in FluxGym.
export interface TrainingCheck {
  started: boolean; // FluxGym created its output folder — the run was actually started
  done: boolean; // the final <slug>.safetensors exists
  loraFile: string; // absolute path of the finished file ('' until done)
  checkpoints: number; // intermediate epoch saves seen so far (rough progress)
}

// Where everything lives on disk (Settings → Data & backup).
export interface DataLocations {
  dataRootPath: string;
  dbPath: string; // the live SQLite database (always local — see dataRoot.ts)
  vaultPath: string;
  projectBoardPath: string;
  lastBackupAt: number | null;
}

// Live state of the LAN web portal (Settings → Web portal).
export interface PortalStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  urls: string[]; // ready-to-open http://<lan-ip>:<port>/?token=… links
  error?: string;
}

export const VAULT_CATEGORIES = [
  'Ideas',
  'Projects',
  'Workflows',
  'Decisions',
  'People',
  'Reference',
  'Uncategorized',
] as const;

export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

// ---------- Chat streaming over IPC ----------
// Provider calls run in the MAIN process (API keys never reach the renderer).
// The renderer starts a stream with a requestId, receives cumulative text via
// the `ai-chat:stream-token` push event, and the invoke resolves with the
// final text (which is also how the LAN portal — no push events — gets it).

export interface ChatStreamRequest {
  provider: Provider;
  modelVersion: string;
  // Full assembled history: context/system messages + trimmed chat history.
  messages: Message[];
}

export interface StreamTokenEvent {
  requestId: string;
  text: string; // cumulative text so far
}

// Presence booleans for the shell's central key vault (never values).
export type ApiKeyStatus = Record<string, boolean>;

// The typed API surface the renderer uses (built in lib/bridge.ts on top of
// window.wicked.invoke — the standalone app's window.polyglot equivalent).
export interface WickedAPI {
  // Chats
  getChats(): Promise<Chat[]>;
  createChat(data: {
    title?: string;
    folderId?: string | null;
    provider: Provider;
    modelVersion: string;
  }): Promise<Chat>;
  updateChatTitle(id: string, title: string): Promise<void>;
  updateChatFolder(id: string, folderId: string | null): Promise<void>;
  updateChatModel(id: string, provider: Provider, modelVersion: string): Promise<void>;
  deleteChat(id: string): Promise<void>;
  updateChatSystemPrompt(id: string, prompt: string): Promise<void>;
  updateChatAgentPersona(id: string, personaId: string | null): Promise<void>;
  branchChat(id: string, uptoCreatedAt: number): Promise<Chat | null>;
  setChatNoMemory(id: string, noMemory: boolean): Promise<void>;
  setChatCommitted(id: string, ts: number): Promise<void>;
  getDeletedChats(): Promise<DeletedChat[]>;
  restoreChat(id: string): Promise<void>;
  purgeChat(id: string): Promise<void>;

  // Folders
  getFolders(): Promise<Folder[]>;
  createFolder(name: string, parentId?: string | null): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<void>;
  moveFolder(id: string, parentId: string | null): Promise<void>;
  deleteFolder(id: string): Promise<void>;

  // Messages
  getMessages(chatId: string): Promise<Message[]>;
  saveMessage(msg: {
    id?: string;
    chatId: string;
    role: Message['role'];
    content: ContentPart[];
    provider?: Provider;
    modelVersion?: string;
  }): Promise<Message>;
  deleteMessage(id: string): Promise<void>;
  deleteMessagesFrom(chatId: string, createdAt: number): Promise<void>;
  searchMessages(query: string): Promise<MessageSearchHit[]>;

  // Prompt templates
  getTemplates(): Promise<PromptTemplate[]>;
  saveTemplate(name: string, body: string): Promise<PromptTemplate>;
  deleteTemplate(id: string): Promise<void>;

  // Chat links
  getChatLinks(chatId: string): Promise<string[]>;
  addChatLink(sourceChatId: string, linkedChatId: string): Promise<void>;
  removeChatLink(sourceChatId: string, linkedChatId: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  saveSettings(partial: Partial<Settings>): Promise<void>;

  // File dialogs
  openFileDialog(): Promise<{ name: string; mime: string; data: string; text?: string } | null>;
  openVaultFolderDialog(): Promise<string | null>;

  // Vault operations
  vaultReadAll(): Promise<VaultNote[]>;
  vaultWriteNote(category: string, filename: string, content: string): Promise<string>;
  vaultWriteNoteForChat(
    category: string,
    filename: string,
    content: string,
    sourceChatId: string
  ): Promise<string>;
  vaultReadNote(path: string): Promise<string>;
  vaultSearch(query: string): Promise<VaultNote[]>;
  vaultGetEmbeddings(): Promise<Record<string, number[]>>;
  vaultSaveEmbedding(path: string, embedding: number[]): Promise<void>;
  vaultRegenerateIndex(): Promise<void>;
  vaultGitStatus(): Promise<{ isRepo: boolean; hasRemote: boolean; branch: string; dirtyCount: number }>;
  vaultGitSync(message: string): Promise<string>;

  // Export
  exportMarkdown(filename: string, content: string): Promise<string | null>;
  exportPDF(filename: string, html: string): Promise<string | null>;

  // MCP servers
  mcpGetServers(): Promise<McpServerConfig[]>;
  mcpSaveServers(servers: McpServerConfig[]): Promise<void>;
  mcpListTools(): Promise<McpToolInfo[]>;
  mcpCallTool(qualifiedName: string, args: Record<string, unknown>): Promise<string>;
  mcpTestServer(server: McpServerConfig): Promise<{ ok: boolean; tools: number; error?: string }>;
  mcpDisconnect(id: string): Promise<void>;

  // Provider calls (run in the main process; keys come from the shell vault)
  chatStream(requestId: string, req: ChatStreamRequest): Promise<string>;
  chatAbort(requestId: string): Promise<void>;
  completeText(provider: Provider, modelVersion: string, prompt: string): Promise<string>;
  generateImage(preferredModel: string, prompt: string): Promise<{ url: string; model: string }>;
  embedText(text: string): Promise<number[]>;
  voiceTranscribe(base64: string, mime: string): Promise<string>;
  voiceSpeak(text: string, voice: string): Promise<string>; // base64 mp3

  // Model discovery (main process — CORS + key access)
  modelsListChat(provider: Provider): Promise<{ id: string; label: string }[]>;
  modelsListImage(): Promise<{ id: string; label: string }[]>;

  // Central key vault presence booleans (mirrored for the LAN portal)
  apiKeysStatus(): Promise<ApiKeyStatus>;

  // Agent personas (vault-backed brains)
  agentGetPersonas(): Promise<AgentPersona[]>;
  agentCreatePersona(data: {
    name: string;
    avatar?: string;
    systemPrompt: string;
    vaultPath: string;
  }): Promise<AgentPersona>;
  agentUpdatePersona(
    id: string,
    patch: Partial<Pick<AgentPersona, 'name' | 'avatar' | 'systemPrompt' | 'vaultPath'>>
  ): Promise<void>;
  agentDeletePersona(id: string): Promise<void>;
  // Read/search the markdown docs inside a brain folder
  brainFolderDigest(folderPath: string): Promise<{ fileCount: number; sample: string }>;
  brainFolderSearch(folderPath: string, query: string, limit?: number): Promise<BrainDoc[]>;

  // Project Board — file-backed freeform boards, one per project
  pbGetDataFolder(): Promise<string>;
  pbChooseDataFolder(): Promise<string | null>;
  pbSetDataFolder(path: string, migrate: boolean): Promise<void>;
  pbGetProjects(): Promise<Project[]>;
  pbCreateProject(name: string, icon?: string): Promise<Project>;
  pbRenameProject(id: string, name: string): Promise<void>;
  pbDeleteProject(id: string): Promise<void>;
  pbLoadBoard(projectId: string): Promise<BoardData>;
  pbSaveBoard(projectId: string, data: BoardData): Promise<void>;
  pbSaveAsset(projectId: string, dataUrl: string): Promise<{ assetId: string }>;
  pbGetAsset(projectId: string, assetId: string): Promise<string | null>;
  pbImportImage(projectId: string): Promise<{ assetId: string; dataUrl: string } | null>;

  // Web portal
  portalGetStatus(): Promise<PortalStatus>;

  // Data root & backups
  dataGetLocations(): Promise<DataLocations>;
  dataConsolidate(root: string): Promise<string[]>;

  // Local image generation (ComfyUI)
  comfyGetStatus(): Promise<ComfyStatus>;
  comfyListModels(): Promise<ComfyModels>;
  comfyFreeVram(): Promise<void>;
  comfyLoadModel(): Promise<void>;
  comfyGenerate(opts: {
    prompt: string;
    loraName?: string;
    loraStrength?: number;
    width?: number;
    height?: number;
    steps?: number;
    seed?: number;
  }): Promise<{ image: string; seed: number }>;
  comfyLaunch(): Promise<void>;
  comfyChooseFolder(): Promise<string | null>;

  // FluxGym — in-app LoRA training pipeline for Persons
  fluxGymGetStatus(): Promise<FluxGymStatus>;
  fluxGymChooseFolder(): Promise<string | null>;
  fluxGymPickImages(): Promise<TrainingImage[]>;
  fluxGymPrepareDataset(
    slug: string,
    triggerWord: string,
    imagePaths: string[]
  ): Promise<{ dir: string; count: number }>;
  fluxGymCheckTraining(slug: string): Promise<TrainingCheck>;
  fluxGymInstallLora(slug: string): Promise<string>; // → lora filename now visible to ComfyUI
  fluxGymLaunch(): Promise<{ started: boolean; message: string }>;
  fluxGymOpenUi(): Promise<void>;
  fluxGymOpenDataset(slug: string): Promise<void>;

  // Shell
  openExternal(path: string): Promise<void>;
}

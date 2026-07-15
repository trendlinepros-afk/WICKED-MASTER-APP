import type { WickedAPI } from '../types';

/**
 * Single source of truth mapping every renderer API method to its IPC channel.
 * Port of the standalone app's rpcMap.ts: every original channel `x:y` is now
 * `ai-chat:x-y` per the WICKED module contract (the module id is the
 * namespace). Three surfaces are generated from this map so they can never
 * drift apart:
 *   - lib/bridge.ts    — the renderer's typed `api` object over window.wicked
 *   - ipc.ts           — the main-process handler registry (each channel gets
 *                        exactly one handler)
 *   - ipc/webPortal.ts — the LAN portal's browser bridge + RPC allow-list
 *
 * Port notes: the standalone updater channels (app:getVersion,
 * app:checkForUpdates, update:install) were dropped — the shell owns updates.
 * models:listOpenAICompat (which shipped an API key over IPC) was replaced by
 * key-less models-listChat/models-listImage. All provider calls (chat
 * streaming, completions, image gen, embeddings, voice STT/TTS) moved into the
 * main process so key values never transit IPC.
 */
export const RPC_CHANNELS: Record<keyof WickedAPI, string> = {
  // Chats
  getChats: 'ai-chat:chats-getAll',
  createChat: 'ai-chat:chats-create',
  updateChatTitle: 'ai-chat:chats-updateTitle',
  updateChatFolder: 'ai-chat:chats-updateFolder',
  updateChatModel: 'ai-chat:chats-updateModel',
  deleteChat: 'ai-chat:chats-delete',
  updateChatSystemPrompt: 'ai-chat:chats-updateSystemPrompt',
  updateChatAgentPersona: 'ai-chat:chats-updateAgentPersona',
  branchChat: 'ai-chat:chats-branch',
  setChatNoMemory: 'ai-chat:chats-setNoMemory',
  setChatCommitted: 'ai-chat:chats-setCommitted',
  getDeletedChats: 'ai-chat:chats-getDeleted',
  restoreChat: 'ai-chat:chats-restore',
  purgeChat: 'ai-chat:chats-purge',

  // Messages
  getMessages: 'ai-chat:messages-getAll',
  saveMessage: 'ai-chat:messages-save',
  deleteMessage: 'ai-chat:messages-delete',
  deleteMessagesFrom: 'ai-chat:messages-deleteFrom',
  searchMessages: 'ai-chat:search-messages',

  // Prompt templates
  getTemplates: 'ai-chat:templates-getAll',
  saveTemplate: 'ai-chat:templates-save',
  deleteTemplate: 'ai-chat:templates-delete',

  // Folders
  getFolders: 'ai-chat:folders-getAll',
  createFolder: 'ai-chat:folders-create',
  renameFolder: 'ai-chat:folders-rename',
  moveFolder: 'ai-chat:folders-move',
  deleteFolder: 'ai-chat:folders-delete',

  // Chat links
  getChatLinks: 'ai-chat:links-get',
  addChatLink: 'ai-chat:links-add',
  removeChatLink: 'ai-chat:links-remove',

  // Settings
  getSettings: 'ai-chat:settings-get',
  saveSettings: 'ai-chat:settings-save',

  // Dialogs
  openFileDialog: 'ai-chat:dialog-openFile',
  openVaultFolderDialog: 'ai-chat:dialog-openVaultFolder',

  // Vault
  vaultReadAll: 'ai-chat:vault-readAll',
  vaultWriteNote: 'ai-chat:vault-writeNote',
  vaultWriteNoteForChat: 'ai-chat:vault-writeNoteForChat',
  vaultReadNote: 'ai-chat:vault-readNote',
  vaultSearch: 'ai-chat:vault-search',
  vaultGetEmbeddings: 'ai-chat:vault-getEmbeddings',
  vaultSaveEmbedding: 'ai-chat:vault-saveEmbedding',
  vaultRegenerateIndex: 'ai-chat:vault-regenerateIndex',
  vaultGitStatus: 'ai-chat:vault-gitStatus',
  vaultGitSync: 'ai-chat:vault-gitSync',

  // Export
  exportMarkdown: 'ai-chat:export-markdown',
  exportPDF: 'ai-chat:export-pdf',

  // MCP servers
  mcpGetServers: 'ai-chat:mcp-getServers',
  mcpSaveServers: 'ai-chat:mcp-saveServers',
  mcpListTools: 'ai-chat:mcp-listTools',
  mcpCallTool: 'ai-chat:mcp-callTool',
  mcpTestServer: 'ai-chat:mcp-testServer',
  mcpDisconnect: 'ai-chat:mcp-disconnect',

  // Provider calls (main process; keys from the shell's central vault)
  chatStream: 'ai-chat:chat-stream',
  chatAbort: 'ai-chat:chat-abort',
  completeText: 'ai-chat:chat-completeText',
  generateImage: 'ai-chat:image-generate',
  embedText: 'ai-chat:embed-text',
  voiceTranscribe: 'ai-chat:voice-transcribe',
  voiceSpeak: 'ai-chat:voice-speak',

  // Model discovery
  modelsListChat: 'ai-chat:models-listChat',
  modelsListImage: 'ai-chat:models-listImage',

  // Key vault presence (booleans only, mirrors the shell's status)
  apiKeysStatus: 'ai-chat:apiKeys-status',

  // Agent personas (vault-backed brains)
  agentGetPersonas: 'ai-chat:agent-getPersonas',
  agentCreatePersona: 'ai-chat:agent-createPersona',
  agentUpdatePersona: 'ai-chat:agent-updatePersona',
  agentDeletePersona: 'ai-chat:agent-deletePersona',
  brainFolderDigest: 'ai-chat:brain-folderDigest',
  brainFolderSearch: 'ai-chat:brain-folderSearch',

  // Project Board
  pbGetDataFolder: 'ai-chat:pb-getDataFolder',
  pbChooseDataFolder: 'ai-chat:pb-chooseDataFolder',
  pbSetDataFolder: 'ai-chat:pb-setDataFolder',
  pbGetProjects: 'ai-chat:pb-getProjects',
  pbCreateProject: 'ai-chat:pb-createProject',
  pbRenameProject: 'ai-chat:pb-renameProject',
  pbDeleteProject: 'ai-chat:pb-deleteProject',
  pbLoadBoard: 'ai-chat:pb-loadBoard',
  pbSaveBoard: 'ai-chat:pb-saveBoard',
  pbSaveAsset: 'ai-chat:pb-saveAsset',
  pbGetAsset: 'ai-chat:pb-getAsset',
  pbImportImage: 'ai-chat:pb-importImage',

  // Web portal
  portalGetStatus: 'ai-chat:portal-getStatus',

  // Data root & backups
  dataGetLocations: 'ai-chat:data-getLocations',
  dataConsolidate: 'ai-chat:data-consolidate',

  // Local image generation (ComfyUI)
  comfyGetStatus: 'ai-chat:comfy-getStatus',
  comfyListModels: 'ai-chat:comfy-listModels',
  comfyFreeVram: 'ai-chat:comfy-freeVram',
  comfyLoadModel: 'ai-chat:comfy-loadModel',
  comfyGenerate: 'ai-chat:comfy-generate',
  comfyLaunch: 'ai-chat:comfy-launch',
  comfyChooseFolder: 'ai-chat:comfy-chooseFolder',

  // FluxGym (LoRA training)
  fluxGymGetStatus: 'ai-chat:fluxgym-getStatus',
  fluxGymChooseFolder: 'ai-chat:fluxgym-chooseFolder',
  fluxGymPickImages: 'ai-chat:fluxgym-pickImages',
  fluxGymPrepareDataset: 'ai-chat:fluxgym-prepareDataset',
  fluxGymCheckTraining: 'ai-chat:fluxgym-checkTraining',
  fluxGymInstallLora: 'ai-chat:fluxgym-installLora',
  fluxGymLaunch: 'ai-chat:fluxgym-launch',
  fluxGymOpenUi: 'ai-chat:fluxgym-openUi',
  fluxGymOpenDataset: 'ai-chat:fluxgym-openDataset',

  // Shell
  openExternal: 'ai-chat:shell-openExternal',
};

/** Main → renderer push event: cumulative chat-stream text per requestId. */
export const STREAM_TOKEN_EVENT = 'ai-chat:stream-token';

/**
 * Channels that only make sense in the desktop app (native dialogs, opening
 * host folders/files, PDF export). The LAN portal's browser bridge replaces
 * some of them with browser-native equivalents; the portal server refuses the
 * rest as a backstop.
 */
export const DESKTOP_ONLY_CHANNELS: string[] = [
  RPC_CHANNELS.openFileDialog,
  RPC_CHANNELS.openVaultFolderDialog,
  RPC_CHANNELS.pbChooseDataFolder,
  RPC_CHANNELS.pbImportImage,
  RPC_CHANNELS.exportMarkdown,
  RPC_CHANNELS.exportPDF,
  RPC_CHANNELS.openExternal,
  RPC_CHANNELS.comfyChooseFolder,
  RPC_CHANNELS.fluxGymChooseFolder,
  RPC_CHANNELS.fluxGymPickImages,
  RPC_CHANNELS.fluxGymOpenUi,
  RPC_CHANNELS.fluxGymOpenDataset,
];

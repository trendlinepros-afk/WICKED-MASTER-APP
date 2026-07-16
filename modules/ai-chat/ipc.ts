import { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { ModuleIpcContext } from '../../src/main/module-ipc';
import type { ModuleDataPath } from '@shared/types';
import { RPC_CHANNELS as C, STREAM_TOKEN_EVENT } from './shared/rpc';
import type { ChatStreamRequest, Provider, Settings } from './types';
import * as db from './ipc/db';
import * as importStandalone from './ipc/importStandalone';
import * as vault from './ipc/vault';
import * as brainFolder from './ipc/brainFolder';
import * as projectBoard from './ipc/projectBoard';
import * as dataRoot from './ipc/dataRoot';
import * as comfy from './ipc/comfy';
import * as comfyLauncher from './ipc/comfyLauncher';
import * as fluxGym from './ipc/fluxGym';
import * as mcp from './ipc/mcp';
import type { McpServerConfig } from './ipc/mcp';
import * as providers from './ipc/providers';
import * as webPortal from './ipc/webPortal';

/**
 * ai-chat module IPC registration (port of the standalone app's main.ts
 * registerIpc plus its startup wiring).
 *
 * Port notes vs the standalone app:
 *  - Window/menu/tray/second-instance/lifecycle code removed — the shell owns
 *    the window. PDF export still uses its own offscreen BrowserWindow.
 *  - Updater channels (app:getVersion / app:checkForUpdates / update:install)
 *    removed — the shell owns updates.
 *  - Provider API keys come from the shell's central vault (ctx.getApiKey);
 *    all provider calls (chat streaming, completions, embeddings, image gen,
 *    voice STT/TTS, model discovery) run HERE so key values never transit IPC.
 *  - Every channel is registered through handle(), which also records it in a
 *    registry handed to the LAN web portal — the portal mirrors exactly this
 *    ai-chat:* surface. The portal is OFF by default and only starts when the
 *    user enables it in the module's settings.
 */
export default function register(ctx: ModuleIpcContext): void {
  const { ipcMain, app, shell, dialog, getMainWindow } = ctx;

  db.initDb();
  providers.initKeyResolver(ctx.getApiKey);

  // Explicit channel → handler registry: one handler per channel, mirrored by
  // the LAN portal (ipc/webPortal.ts) so the two surfaces can't drift apart.
  type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
  const registry = new Map<string, webPortal.PortalHandler>();
  const handle = (channel: string, fn: IpcHandler): void => {
    registry.set(channel, fn as unknown as webPortal.PortalHandler);
    ipcMain.handle(channel, fn);
  };

  const openDialog = (
    options: OpenDialogOptions
  ): Promise<Electron.OpenDialogReturnValue> => {
    const win = getMainWindow();
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
  };

  // ----- Import from the old standalone Wicked app -----
  // Registered as plain module channels (not part of the typed WickedAPI/LAN
  // portal surface): desktop-only, and reachable by the shell MCP via the
  // channel registry. `ai-chat:import-scan` is read-only; `ai-chat:import-run`
  // additively imports the chosen database into this module's DB.
  ipcMain.handle('ai-chat:import-scan', () =>
    importStandalone.scanForStandalone(db.dbFilePath())
  );
  ipcMain.handle('ai-chat:import-run', (_e: IpcMainInvokeEvent, sourcePath: unknown) => {
    if (typeof sourcePath !== 'string' || !sourcePath)
      return { ok: false, error: 'A database path is required.' };
    return db.importFromStandalone(sourcePath);
  });

  // ----- Chats -----
  handle(C.getChats, () => db.getChats());
  handle(C.createChat, (_e, data) => db.createChat(data));
  handle(C.updateChatTitle, (_e, id: string, title: string) => db.updateChatTitle(id, title));
  handle(C.updateChatFolder, (_e, id: string, folderId: string | null) =>
    db.updateChatFolder(id, folderId)
  );
  handle(C.updateChatModel, (_e, id: string, provider: Provider, modelVersion: string) =>
    db.updateChatModel(id, provider, modelVersion)
  );
  handle(C.deleteChat, (_e, id: string) => db.deleteChat(id));
  handle(C.updateChatSystemPrompt, (_e, id: string, prompt: string) =>
    db.updateChatSystemPrompt(id, prompt)
  );
  handle(C.updateChatAgentPersona, (_e, id: string, personaId: string | null) =>
    db.updateChatAgentPersona(id, personaId)
  );
  handle(C.branchChat, (_e, id: string, upto: number) => db.branchChat(id, upto));
  handle(C.setChatNoMemory, (_e, id: string, v: boolean) => db.updateChatNoMemory(id, v));
  handle(C.setChatCommitted, (_e, id: string, ts: number) => db.updateChatCommitted(id, ts));
  handle(C.getDeletedChats, () => db.getDeletedChats());
  handle(C.restoreChat, (_e, id: string) => db.restoreChat(id));
  handle(C.purgeChat, (_e, id: string) => db.purgeChat(id));

  // ----- Messages (edit/branch) + global search -----
  handle(C.getMessages, (_e, chatId: string) => db.getMessages(chatId));
  handle(C.saveMessage, (_e, msg) => db.saveMessage(msg));
  handle(C.deleteMessage, (_e, id: string) => db.deleteMessage(id));
  handle(C.deleteMessagesFrom, (_e, chatId: string, createdAt: number) =>
    db.deleteMessagesFrom(chatId, createdAt)
  );
  handle(C.searchMessages, (_e, query: string) => db.searchMessages(query));

  // ----- Prompt templates -----
  handle(C.getTemplates, () => db.getTemplates());
  handle(C.saveTemplate, (_e, name: string, body: string) => db.saveTemplate(name, body));
  handle(C.deleteTemplate, (_e, id: string) => db.deleteTemplate(id));

  // ----- Folders -----
  handle(C.getFolders, () => db.getFolders());
  handle(C.createFolder, (_e, name: string, parentId?: string | null) =>
    db.createFolder(name, parentId ?? null)
  );
  handle(C.renameFolder, (_e, id: string, name: string) => db.renameFolder(id, name));
  handle(C.moveFolder, (_e, id: string, parentId: string | null) => db.moveFolder(id, parentId));
  handle(C.deleteFolder, (_e, id: string) => db.deleteFolder(id));

  // ----- Chat links -----
  handle(C.getChatLinks, (_e, chatId: string) => db.getChatLinks(chatId));
  handle(C.addChatLink, (_e, src: string, linked: string) => db.addChatLink(src, linked));
  handle(C.removeChatLink, (_e, src: string, linked: string) => db.removeChatLink(src, linked));

  // ----- Agent personas (vault-backed brains) -----
  handle(C.agentGetPersonas, () => db.agentGetPersonas());
  handle(C.agentCreatePersona, (_e, data) => db.agentCreatePersona(data));
  handle(C.agentUpdatePersona, (_e, id: string, patch) => db.agentUpdatePersona(id, patch));
  handle(C.agentDeletePersona, (_e, id: string) => db.agentDeletePersona(id));
  handle(C.brainFolderDigest, (_e, folderPath: string) => brainFolder.digest(folderPath));
  handle(C.brainFolderSearch, (_e, folderPath: string, query: string, limit?: number) =>
    brainFolder.search(folderPath, query, limit)
  );

  // ----- Project Board -----
  handle(C.pbGetDataFolder, () => projectBoard.getDataFolder());
  handle(C.pbChooseDataFolder, async () => {
    const result = await openDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where Project Board data is stored',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  handle(C.pbSetDataFolder, (_e, folder: string, migrate: boolean) => {
    if (migrate) projectBoard.migrateData(folder);
    db.saveSettings({ projectBoardPath: folder });
  });
  handle(C.pbGetProjects, () => projectBoard.listProjects());
  handle(C.pbCreateProject, (_e, name: string, icon?: string) =>
    projectBoard.createProject(name, icon)
  );
  handle(C.pbRenameProject, (_e, id: string, name: string) => projectBoard.renameProject(id, name));
  handle(C.pbDeleteProject, (_e, id: string) => projectBoard.deleteProject(id));
  handle(C.pbLoadBoard, (_e, projectId: string) => projectBoard.loadBoard(projectId));
  handle(C.pbSaveBoard, (_e, projectId: string, data) => projectBoard.saveBoard(projectId, data));
  handle(C.pbSaveAsset, (_e, projectId: string, dataUrl: string) =>
    projectBoard.saveAsset(projectId, dataUrl)
  );
  handle(C.pbGetAsset, (_e, projectId: string, assetId: string) =>
    projectBoard.getAsset(projectId, assetId)
  );
  handle(C.pbImportImage, async (_e, projectId: string) => {
    const result = await openDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return projectBoard.saveAssetFromFile(projectId, result.filePaths[0]);
  });

  // ----- Settings -----
  handle(C.getSettings, () => db.getSettings());
  handle(C.saveSettings, (_e, partial: Partial<Settings>) => {
    db.saveSettings(partial);
    // Apply web-portal changes (enable/disable/port) immediately.
    if ('webPortalEnabled' in partial || 'webPortalPort' in partial) webPortal.sync();
  });

  // ----- Web portal -----
  handle(C.portalGetStatus, () => webPortal.getStatus());

  // ----- Data root & backups -----
  handle(C.dataGetLocations, () => dataRoot.getLocations());
  handle(C.dataConsolidate, (_e, root: string) => dataRoot.consolidate(root));

  // ----- Data paths (Settings → Modules) -----
  // Read live from the module's own settings/db so the list reflects current
  // state. Registered directly on ipcMain (not `handle`) so it is NOT mirrored
  // onto the LAN web portal — it is a shell-shell channel. Paths only, no
  // secrets (the portal token / API keys are never surfaced here).
  ipcMain.handle('ai-chat:data-paths', (): ModuleDataPath[] => {
    const s = db.getSettings();
    const dbFile = db.dbFilePath();
    const boardFolder = projectBoard.getDataFolder();
    return [
      {
        label: 'Brain vault',
        path: s.vaultPath || null,
        note: 'Obsidian-compatible memory vault (WickedBrain)',
      },
      {
        label: 'Database',
        path: fs.existsSync(dbFile) ? dbFile : null,
        note: 'Chats, folders, personas, settings (SQLite)',
      },
      {
        label: 'Project Boards',
        path: boardFolder || null,
        note: 'Configured folder, or the default under the module data folder',
      },
      {
        label: 'Data root',
        path: s.dataRootPath || null,
        note: 'Consolidated root (e.g. a network share) with rolling DB backups',
      },
      {
        label: 'ComfyUI folder',
        path: s.comfyLaunchPath || null,
        note: 'Local image generation launcher',
      },
      {
        label: 'FluxGym folder',
        path: s.fluxGymPath || null,
        note: 'LoRA training for Persons',
      },
    ];
  });

  // ----- Local image generation (ComfyUI) -----
  handle(C.comfyGetStatus, () => comfy.getStatus());
  handle(C.comfyListModels, () => comfy.listModels());
  handle(C.comfyFreeVram, () => comfy.freeVram());
  handle(C.comfyLoadModel, () => comfy.loadModel());
  handle(C.comfyGenerate, (_e, opts: comfy.GenerateOpts) => comfy.generate(opts));
  handle(C.comfyLaunch, () => comfyLauncher.launch());
  handle(C.comfyChooseFolder, async () => {
    const result = await openDialog({
      properties: ['openDirectory'],
      title: 'Choose your ComfyUI folder (the one containing run_nvidia_gpu.bat)',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ----- FluxGym (LoRA training for Persons) -----
  handle(C.fluxGymGetStatus, () => fluxGym.getStatus());
  handle(C.fluxGymChooseFolder, async () => {
    const result = await openDialog({
      properties: ['openDirectory'],
      title: 'Choose your FluxGym folder (contains app.py — e.g. pinokio\\api\\fluxgym.git)',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  handle(C.fluxGymPickImages, () => fluxGym.pickImages(getMainWindow()));
  handle(C.fluxGymPrepareDataset, (_e, slug: string, triggerWord: string, imagePaths: string[]) =>
    fluxGym.prepareDataset(slug, triggerWord, imagePaths)
  );
  handle(C.fluxGymCheckTraining, (_e, slug: string) => fluxGym.checkTraining(slug));
  handle(C.fluxGymInstallLora, (_e, slug: string) => fluxGym.installLora(slug));
  handle(C.fluxGymLaunch, () => fluxGym.launch());
  handle(C.fluxGymOpenUi, () => fluxGym.openUi());
  handle(C.fluxGymOpenDataset, (_e, slug: string) => fluxGym.openDataset(slug));

  // ----- File dialogs -----
  handle(C.openFileDialog, async () => {
    const result = await openDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Supported', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'txt', 'md'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath);
    const buffer = fs.readFileSync(filePath);
    const mime = mimeFromExt(ext);
    const data = buffer.toString('base64');
    // Extract text from documents so the model can actually read them.
    const text = await extractText(buffer, ext.toLowerCase());
    return { name: path.basename(filePath), mime, data, text };
  });

  handle(C.openVaultFolderDialog, async () => {
    const result = await openDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose your WICKED Brain vault location',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // ----- Vault -----
  handle(C.vaultReadAll, () => safeVault(() => vault.readAll(), []));
  handle(C.vaultWriteNote, (_e, category: string, filename: string, content: string) =>
    vault.writeNote(category, filename, content)
  );
  handle(
    C.vaultWriteNoteForChat,
    (_e, category: string, filename: string, content: string, sourceChatId: string) =>
      vault.writeNoteForChat(category, filename, content, sourceChatId)
  );
  handle(C.vaultReadNote, (_e, p: string) => vault.readNote(p));
  handle(C.vaultSearch, (_e, query: string) => safeVault(() => vault.search(query), []));
  handle(C.vaultGetEmbeddings, () => safeVault(() => vault.getEmbeddings(), {}));
  handle(C.vaultSaveEmbedding, (_e, p: string, embedding: number[]) =>
    vault.saveEmbedding(p, embedding)
  );
  handle(C.vaultRegenerateIndex, () => safeVault(() => vault.regenerateIndex(), undefined));
  handle(C.vaultGitStatus, () =>
    safeVault(() => vault.gitStatus(), { isRepo: false, hasRemote: false, branch: '', dirtyCount: 0 })
  );
  handle(C.vaultGitSync, (_e, message: string) =>
    safeVault(() => vault.gitSync(message), 'Vault not configured.')
  );

  // ----- Export -----
  handle(C.exportMarkdown, async (_e, filename: string, content: string) => {
    const win = getMainWindow();
    const options = {
      defaultPath: `${filename}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return result.filePath;
  });

  handle(C.exportPDF, async (_e, filename: string, html: string) => {
    const win = getMainWindow();
    const options = {
      defaultPath: `${filename}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    // Render the HTML in an offscreen window and print to PDF — no extra deps.
    const pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await pdfWin.webContents.printToPDF({ printBackground: true });
    fs.writeFileSync(result.filePath, data);
    pdfWin.destroy();
    return result.filePath;
  });

  // ----- MCP servers -----
  handle(C.mcpGetServers, () => mcp.getServers());
  handle(C.mcpSaveServers, (_e, servers: McpServerConfig[]) => mcp.saveServers(servers));
  handle(C.mcpListTools, () => mcp.listAllTools());
  handle(C.mcpCallTool, (_e, name: string, args: Record<string, unknown>) =>
    mcp.callTool(name, args)
  );
  handle(C.mcpTestServer, (_e, server: McpServerConfig) => mcp.testServer(server));
  handle(C.mcpDisconnect, (_e, id: string) => mcp.disconnect(id));

  // ----- Provider calls (keys from the shell's central vault) -----
  handle(C.chatStream, async (_e, requestId: string, req: ChatStreamRequest) => {
    const id = String(requestId);
    const controller = providers.beginStream(id);
    try {
      return await providers.streamChat({
        provider: req.provider,
        modelVersion: req.modelVersion,
        messages: req.messages,
        signal: controller.signal,
        onToken: (full) => {
          getMainWindow()?.webContents.send(STREAM_TOKEN_EVENT, { requestId: id, text: full });
        },
      });
    } finally {
      providers.endStream(id);
    }
  });
  handle(C.chatAbort, (_e, requestId: string) => providers.abortStream(String(requestId)));
  handle(C.completeText, (_e, provider: Provider, modelVersion: string, prompt: string) =>
    providers.completeText(provider, modelVersion, prompt)
  );
  handle(C.generateImage, (_e, preferredModel: string, prompt: string) =>
    providers.generateImage(preferredModel, prompt)
  );
  handle(C.embedText, (_e, text: string) => providers.embedText(text));
  handle(C.voiceTranscribe, (_e, base64: string, mime: string) =>
    providers.voiceTranscribe(base64, mime)
  );
  handle(C.voiceSpeak, (_e, text: string, voice: string) => providers.voiceSpeak(text, voice));

  // ----- Model discovery -----
  handle(C.modelsListChat, (_e, provider: Provider) => providers.listChatModels(provider));
  handle(C.modelsListImage, () => providers.listImageModels());

  // ----- Key vault presence (booleans only — mirrors the shell's status so
  // the LAN portal can show accurate indicators too) -----
  handle(C.apiKeysStatus, () => providers.keyStatus());

  // ----- Shell -----
  handle(C.openExternal, (_e, p: string) => {
    // Treat as a file path inside the vault when relative.
    let target = p;
    const settings = db.getSettings();
    if (settings.vaultPath && !path.isAbsolute(p)) {
      target = path.join(settings.vaultPath, 'WickedBrain', p);
    }
    if (fs.existsSync(target)) return shell.openPath(target);
    return shell.openExternal(p);
  });

  // ----- Startup wiring (was app.whenReady in the standalone main.ts) -----
  webPortal.setHandlers(registry);
  webPortal.init();
  webPortal.sync(); // no-op unless the user enabled the portal (off by default)
  dataRoot.startBackupSchedule();
  void comfyLauncher.autoLaunch(); // no-op unless a ComfyUI launch path is configured

  app.on('before-quit', () => {
    providers.abortAllStreams();
    void mcp.disconnectAll();
    comfyLauncher.stop(); // fluxGym.stop() keeps a live training run alive — see ipc/fluxGym.ts
    fluxGym.stop();
    webPortal.stop();
  });
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

// Pull readable text out of an attachment when possible (PDF / txt / md).
async function extractText(buffer: Buffer, ext: string): Promise<string | undefined> {
  try {
    if (ext === '.txt' || ext === '.md') return buffer.toString('utf-8').slice(0, 100_000);
    if (ext === '.pdf') {
      const mod = (await import('pdf-parse')) as unknown as {
        default: (b: Buffer) => Promise<{ text: string }>;
      };
      const parsed = await mod.default(buffer);
      return parsed.text.slice(0, 100_000);
    }
  } catch (err) {
    console.warn('[ai-chat extractText]', (err as Error).message);
  }
  return undefined;
}

// Vault ops throw when no vault is configured yet; degrade gracefully.
function safeVault<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.warn('[ai-chat vault]', (err as Error).message);
    return fallback;
  }
}

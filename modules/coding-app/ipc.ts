import { writeFileSync } from 'fs'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import { IPC } from './shared/ipc'
import type { AppConfig, ProviderId } from './shared/config'
import type { ChatRequest, Conversation, GeminiAnalysisData } from './shared/types'
import { configStore } from './ipc/services/config-persistence'
import { listModels } from './ipc/services/models'
import { ollamaService } from './ipc/services/ollama'
import { apiProviderService } from './ipc/services/api-providers'
import { chatOrchestrator } from './ipc/services/chat'
import { conversationStore } from './ipc/services/conversation-store'
import { fileManager } from './ipc/services/file-manager'
import { previewManager } from './ipc/services/preview-manager'
import { runnerService } from './ipc/services/runner'
import { screenshotService } from './ipc/services/screenshot-service'
import { geminiAnalyzer } from './ipc/services/gemini-analyzer'
import { checkPrereqs } from './ipc/services/prereqs'
import { detectVramGb } from './ipc/services/gpu'
import { initKeyResolver } from './ipc/services/keys'
import { logger } from './ipc/services/logger'

/**
 * coding-app module IPC registration. Bridges the renderer's `api` calls (see
 * lib/bridge.ts) to the main-process services. Channel strings come from the
 * shared IPC contract (all namespaced `coding-app:*`) so both sides stay in
 * sync.
 *
 * Port notes vs the standalone app:
 *  - update:* channels (electron-updater) removed — the shell owns updates.
 *  - app lifecycle / window creation removed — the shell owns the window.
 *  - Cleanup of the preview server, run processes and file watcher is
 *    registered on 'before-quit' here so no orphan processes remain.
 */
export default function register(ctx: ModuleIpcContext): void {
  const { ipcMain, app, shell, dialog, getMainWindow } = ctx

  // API keys come from the shell's central vault (Settings → API Keys); hand
  // the getter to the services. Key values never cross to the renderer.
  initKeyResolver(ctx.getApiKey)

  // ---- Config ----
  ipcMain.handle(IPC.configGet, () => configStore.load())
  ipcMain.handle(IPC.configUpdate, (_e, patch: Partial<AppConfig>) =>
    configStore.update(patch)
  )
  ipcMain.handle(IPC.configPath, () => configStore.path())
  ipcMain.handle(IPC.configRestoreBackup, () => configStore.restoreBackup())

  // ---- Models ----
  ipcMain.handle(IPC.modelsList, () => listModels())

  // ---- Ollama ----
  ipcMain.handle(IPC.ollamaStatus, () => ollamaService.status())
  ipcMain.handle(IPC.ollamaStart, () => ollamaService.start())
  ipcMain.handle(IPC.ollamaLoadModel, (_e, name: string) =>
    ollamaService.loadModel(name)
  )
  ipcMain.handle(IPC.ollamaUnloadModel, (_e, name: string) =>
    ollamaService.unloadModel(name)
  )
  ipcMain.handle(IPC.ollamaPullModel, (_e, name: string) =>
    ollamaService.pullModel(name, (status, percent) => {
      getMainWindow()?.webContents.send(IPC.ollamaPullProgress, {
        name,
        status,
        percent
      })
    })
  )
  ipcMain.handle(IPC.ollamaCancelPull, (_e, name: string) =>
    ollamaService.cancelPull(name)
  )

  // ---- Providers ----
  ipcMain.handle(IPC.providerTest, (_e, provider: ProviderId) =>
    apiProviderService.testProvider(provider)
  )

  // ---- Chat ----
  ipcMain.handle(IPC.chatSend, async (_e, req: ChatRequest) => {
    const requestId = chatOrchestrator.newRequestId()
    // Fire-and-forget; tokens stream over the chat channel.
    void chatOrchestrator.run(requestId, req, (event) => {
      getMainWindow()?.webContents.send(IPC.chatStream, event)
    })
    return { requestId }
  })
  ipcMain.handle(IPC.chatStop, (_e, requestId: string) =>
    chatOrchestrator.stop(requestId)
  )
  ipcMain.handle(IPC.chatEstimateCost, (_e, req: ChatRequest) =>
    chatOrchestrator.estimateCost(req)
  )

  // ---- Conversations ----
  ipcMain.handle(IPC.convList, () => conversationStore.list())
  ipcMain.handle(IPC.convLoad, (_e, id: string) => conversationStore.load(id))
  ipcMain.handle(IPC.convSave, (_e, conv: Conversation) =>
    conversationStore.save(conv)
  )
  ipcMain.handle(IPC.convDelete, (_e, id: string) => conversationStore.delete(id))

  // ---- Projects / files ----
  ipcMain.handle(IPC.projectCreate, (_e, name: string) =>
    fileManager.createProject(name)
  )
  ipcMain.handle(IPC.projectOpen, (_e, rootPath: string) =>
    fileManager.openProject(rootPath)
  )
  ipcMain.handle(IPC.projectSetActive, (_e, rootPath: string) =>
    fileManager.setActive(rootPath)
  )
  ipcMain.handle(IPC.fileTree, () => fileManager.getFileTree())
  ipcMain.handle(IPC.fileRead, (_e, relPath: string) =>
    fileManager.readFile(relPath)
  )
  ipcMain.handle(IPC.fileWrite, (_e, relPath: string, content: string) =>
    fileManager.writeFile(relPath, content)
  )
  ipcMain.handle(IPC.fileDelete, (_e, relPath: string) =>
    fileManager.deleteFile(relPath)
  )
  ipcMain.handle(IPC.fileRename, (_e, relPath: string, newRelPath: string) =>
    fileManager.renameFile(relPath, newRelPath)
  )
  ipcMain.handle(IPC.fileApplyBlocks, (_e, raw: string) =>
    fileManager.applyFileBlocks(raw)
  )
  ipcMain.handle(IPC.filePreviewBlocks, (_e, raw: string) =>
    fileManager.previewFileBlocks(raw)
  )

  // ---- Preview ----
  ipcMain.handle(IPC.previewStart, () => previewManager.start())
  ipcMain.handle(IPC.previewStop, () => previewManager.stop())
  ipcMain.handle(IPC.previewStatus, () => previewManager.getStatus())

  // ---- Run ----
  runnerService.setListeners(
    (line) => getMainWindow()?.webContents.send(IPC.runLog, line),
    (code) => getMainWindow()?.webContents.send(IPC.runExit, code)
  )
  ipcMain.handle(IPC.runStart, () => runnerService.start())
  ipcMain.handle(IPC.runStop, () => runnerService.stop())
  ipcMain.handle(IPC.runStatus, () => runnerService.getStatus())
  ipcMain.handle(IPC.runCommand, (_e, command: string) =>
    runnerService.runCommand(command)
  )

  // ---- Screenshot + Gemini ----
  ipcMain.handle(IPC.screenshotCapture, () => screenshotService.capture())
  ipcMain.handle(IPC.geminiAnalyze, (_e, base64: string) =>
    geminiAnalyzer.analyze(base64)
  )
  ipcMain.handle(IPC.geminiApplyFix, (_e, analysis: GeminiAnalysisData) =>
    geminiAnalyzer.applyFix(analysis)
  )

  // ---- Dialogs / misc ----
  ipcMain.handle(IPC.dialogPickFolder, async () => {
    const win = getMainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.logsExport, async () => {
    const win = getMainWindow()
    const opts = {
      defaultPath: join(app.getPath('desktop'), 'coding-app-logs.txt'),
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return null
    try {
      writeFileSync(result.filePath, logger.read(), 'utf-8')
      shell.showItemInFolder(result.filePath)
      return result.filePath
    } catch (err) {
      logger.error('Export logs failed', err)
      return null
    }
  })
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    // Only allow http(s) links to be opened externally.
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    return undefined
  })
  ipcMain.handle(IPC.prereqsCheck, () => checkPrereqs())
  ipcMain.handle(IPC.gpuDetectVram, () => detectVramGb())

  // Forward file-watcher changes to the renderer.
  fileManager.setChangeListener((path) => {
    getMainWindow()?.webContents.send(IPC.fileChanged, path)
  })

  // Clean up preview server / run processes / watchers so no orphans remain.
  app.on('before-quit', () => {
    previewManager.stop().catch(() => {})
    runnerService.stop()
    fileManager.dispose()
  })
}

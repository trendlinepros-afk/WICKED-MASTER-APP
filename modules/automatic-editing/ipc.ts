/**
 * Automatic Editing — main-process registration for the WICKED shell.
 *
 * Ports the standalone Zirtola AI Video Editor's src/main/ipc.ts. All channels
 * are renamed to the `automatic-editing:` namespace (see shared/channels.ts).
 * Menu, Help window, and the auto-updater were dropped (the shell owns those);
 * provider API keys come from the shell's central vault via ctx.getApiKey.
 *
 * CUSTOM MEDIA PROTOCOL (wcmedia://): the renderer streams preview.mp4 (and
 * other work-dir media) through a privileged custom scheme so webSecurity
 * stays on. protocol.registerSchemesAsPrivileged MUST run before app ready —
 * module ipc.ts files are imported at main-bundle load time (before ready),
 * so the call lives at module scope below. protocol.handle() requires the app
 * to be ready and therefore runs inside register() (the shell calls register
 * from app.whenReady()). The handler is root-restricted: it only serves files
 * under the module's data dir, the configured projects folder, and the work
 * dirs of currently-open projects. The shell CSP already allows wcmedia: for
 * img/media sources.
 */
import { protocol } from 'electron'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import { CH } from './shared/channels'
import { EXPORT_PRESETS, type AppSettings, type EDL, type GraphicEvent, type StageId, type TimeRegion } from './shared/types'
import { setApiKeyGetter } from './ipc/keys'
import { setWindowGetter, sendToRenderer } from './ipc/push'
import * as projects from './ipc/project'
import { ensureLayout, masterDir } from './ipc/storage'
import { moduleDataDir } from './ipc/paths'
import { getSettingsStore } from './ipc/settings'
import { renderQueue, enqueueAndWait } from './ipc/queue'
import {
  runFullPipeline,
  runSingleStage,
  replanGraphics,
  approveGraphicsAndRender,
  transcriptEstimate,
  pushProject,
  renderKeep,
  latestArtifact,
  markStaleForEdlChange,
  startAutoEdit
} from './ipc/pipeline/runner'
import { submitRevision } from './ipc/pipeline/revisions'
import { exportFinal } from './ipc/media/render'
import { buildAssFile } from './ipc/media/captions'
import { generateShorts, refreshShorts } from './ipc/shorts/opusclip'

// -- wcmedia scheme (MUST run before app ready — module scope) --------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'wcmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

/** Canonical roots the wcmedia:// scheme is allowed to read from — the
 *  module's data dir (default projects location) and the configured projects
 *  folder. Anything else is denied so the scheme can never be used to read
 *  arbitrary files off disk. */
function mediaRoots(): string[] {
  const roots = [path.resolve(moduleDataDir())]
  const dir = getSettingsStore().getSettings().projectsDir
  if (dir) roots.push(path.resolve(dir))
  // Projects opened from outside the master folder (via "Open Project…")
  // stream their preview from their own work dir.
  for (const wd of projects.openProjectWorkDirs()) roots.push(path.resolve(wd))
  return roots
}

function mimeForFile(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    default:
      return 'application/octet-stream'
  }
}

function registerWcmediaHandler(): void {
  // wcmedia://<absolute-path> → stream a local file to the <video> element,
  // confined to the module's own media roots (never arbitrary disk paths).
  // Honors HTTP Range so <video> can seek and won't stall after the first
  // buffer (the reason plain net.fetch playback stops after a few seconds).
  protocol.handle('wcmedia', async (request) => {
    try {
      const decoded = decodeURIComponent(request.url.slice('wcmedia://'.length))
      const resolved = path.resolve(decoded)
      const allowed = mediaRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep))
      if (!allowed) return new Response('Forbidden', { status: 403 })

      const total = (await fs.promises.stat(resolved)).size
      const type = mimeForFile(resolved)
      const rangeHeader = request.headers.get('Range')

      if (rangeHeader) {
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
        let start = m && m[1] ? parseInt(m[1], 10) : 0
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= total) end = total - 1
        if (start > end || start >= total) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } })
        }
        const body = Readable.toWeb(fs.createReadStream(resolved, { start, end })) as ReadableStream
        return new Response(body, {
          status: 206,
          headers: {
            'Content-Type': type,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes'
          }
        })
      }

      const body = Readable.toWeb(fs.createReadStream(resolved)) as ReadableStream
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' }
      })
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

// ---------------------------------------------------------------------------

export default function register(ctx: ModuleIpcContext): void {
  const { ipcMain, dialog, app } = ctx

  // Wire module plumbing to the shell context FIRST — key vault + push target.
  setApiKeyGetter(ctx.getApiKey)
  setWindowGetter(ctx.getMainWindow)

  // Post-ready protocol handler (register() runs inside app.whenReady()).
  registerWcmediaHandler()

  // Kill queued/running child processes (ffmpeg, HyperFrames) on quit.
  app.on('before-quit', () => renderQueue.cancelAll())

  // -- Projects ------------------------------------------------------------
  ipcMain.handle(CH.pickSourceFile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a source video',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(CH.pickProjectFile, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open an Automatic Editing project',
      filters: [{ name: 'Project file', extensions: ['json'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(CH.projectCreate, (_e, name: string, sourcePath?: string) => projects.createProject(name, sourcePath))
  ipcMain.handle(CH.projectSetSource, (_e, id: string, sourcePath: string) => projects.setProjectSource(id, sourcePath))
  ipcMain.handle(CH.projectImport, (_e, filePath: string) => projects.importProjectFromFile(filePath))

  // -- Media pool ----------------------------------------------------------
  ipcMain.handle(CH.mediaImport, (_e, projectId: string, paths: string[]) => projects.addProjectMedia(projectId, paths))
  ipcMain.handle(CH.mediaRemove, (_e, projectId: string, itemId: string) => projects.removeProjectMedia(projectId, itemId))
  ipcMain.handle(CH.mediaSetOrder, (_e, projectId: string, itemId: string, order: number | null) =>
    projects.setMediaOrder(projectId, itemId, order)
  )

  ipcMain.handle(CH.autoEditStart, async (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    startAutoEdit(project).catch((err) => console.error('[automatic-editing:auto-edit]', err))
  })

  ipcMain.handle(CH.pickMediaFiles, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Import video files',
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', 'mts', 'm2ts', '3gp'] }],
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(CH.pickMediaFolder, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Import a folder of videos',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle(CH.projectOpen, (_e, id: string) => projects.openProject(id))
  ipcMain.handle(CH.projectList, () => projects.listProjects())
  ipcMain.handle(CH.projectDelete, (_e, id: string) => {
    projects.deleteProject(id)
  })
  ipcMain.handle(CH.projectSave, (_e, id: string) => projects.saveProject(projects.openProject(id)))
  ipcMain.handle(CH.projectDuplicate, (_e, id: string) => projects.duplicateProject(id))

  // -- Pipeline ------------------------------------------------------------
  ipcMain.handle(CH.pipelineRun, async (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    runFullPipeline(project).catch((err) => console.error('[automatic-editing:pipeline]', err))
  })

  ipcMain.handle(CH.pipelineRunStage, async (_e, projectId: string, stage: StageId, region?: TimeRegion) => {
    const project = projects.openProject(projectId)
    // Explicit stage-4 re-run = fresh AI plan behind the approval gate;
    // revisions go through runSingleStage which re-renders without re-planning.
    const run = stage === 'graphics' ? replanGraphics(project) : runSingleStage(project, stage, region)
    run.catch((err) => console.error('[automatic-editing:stage]', err))
  })

  ipcMain.handle(CH.pipelineApproveGraphics, async (_e, projectId: string, approvedIds: string[], edits: GraphicEvent[]) => {
    const project = projects.openProject(projectId)
    approveGraphicsAndRender(project, approvedIds, edits).catch((err) => console.error('[automatic-editing:graphics]', err))
  })

  ipcMain.handle(CH.transcriptEstimate, (_e, projectId: string) => transcriptEstimate(projects.openProject(projectId)))

  // -- EDL / revisions -------------------------------------------------------
  ipcMain.handle(CH.edlUpdate, (_e, projectId: string, edl: EDL) => {
    const project = projects.openProject(projectId)
    const before = project.edl
    project.edl = { ...edl, version: project.edl.version + 1 }
    // Manual edits invalidate downstream renders exactly like stage re-runs.
    markStaleForEdlChange(project, before, project.edl)
    return projects.saveProject(project)
  })

  ipcMain.handle(CH.revisionSubmit, async (_e, projectId: string, text: string, region?: TimeRegion, segmentIds?: string[]) => {
    const project = projects.openProject(projectId)
    return submitRevision(project, text, region, segmentIds)
  })

  // -- Approval + final export ----------------------------------------------
  ipcMain.handle(CH.approveFinal, (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    project.approved = true
    projects.saveProject(project)
    pushProject(project)
  })

  ipcMain.handle(CH.exportFinal, (_e, projectId: string, presetId: string) => {
    const project = projects.openProject(projectId)
    const preset = EXPORT_PRESETS.find((p) => p.id === presetId)
    // Run the checks INSIDE the job so a failure shows as a failed queue job
    // (visible to the user) instead of a silently-swallowed IPC rejection.
    enqueueAndWait('final-export', preset ? `Final export: ${preset.label}` : 'Final export', project.id, async (jobCtx) => {
      if (!preset) throw new Error(`Unknown export preset "${presetId}".`)
      const base = latestArtifact(project, 'audio')
      if (!base) throw new Error('Nothing to export yet — run the pipeline first.')
      const ass = project.transcript
        ? buildAssFile(project.workDir, project.transcript, project.edl.captions, project.brandKit, renderKeep(project), {
            width: preset.width,
            height: preset.height
          })
        : null
      project.finalPath = await exportFinal(project, base, ass, preset, {
        signal: jobCtx.signal,
        onProgress: (f) => jobCtx.progress(f, preset.label)
      })
      projects.saveProject(project)
      pushProject(project)
    }).catch((err) => console.error('[automatic-editing:export]', err))
  })

  // -- Shorts ----------------------------------------------------------------
  ipcMain.handle(CH.shortsGenerate, (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    enqueueAndWait('opusclip-submit', 'Generate shorts (OpusClip)', project.id, (jobCtx) => generateShorts(project, jobCtx)).catch(
      (err) => console.error('[automatic-editing:shorts]', err)
    )
  })

  ipcMain.handle(CH.shortsRefresh, async (_e, projectId: string) => {
    const project = projects.openProject(projectId)
    await refreshShorts(project)
    return project
  })

  // -- Queue -----------------------------------------------------------------
  ipcMain.handle(CH.queueList, () => renderQueue.list())
  ipcMain.handle(CH.queueCancel, (_e, jobId: string) => renderQueue.cancel(jobId))
  renderQueue.on('job', (job) => sendToRenderer(CH.queueEvent, job))

  // -- Settings ----------------------------------------------------------------
  // NOTE: no set-key handler — provider keys live in the shell's central vault
  // (Settings → API Keys); this module only reads them via ctx.getApiKey.
  ipcMain.handle(CH.settingsGet, () => getSettingsStore().getSettings())
  ipcMain.handle(CH.settingsUpdate, (_e, patch: Partial<AppSettings>) => getSettingsStore().update(patch))

  ipcMain.handle(CH.settingsSetProjectsDir, (_e, dir: string | null) => {
    const store = getSettingsStore()
    let saved
    if (dir) {
      // Validate we can actually create/write the chosen folder before saving.
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      saved = store.update({ projectsDir: dir, onboarded: true })
    } else {
      // null → accept the default location under the module data dir.
      saved = store.update({ onboarded: true })
    }
    // Scan the master folder for Projects/ and Assets/ subfolders, mapping to
    // them if present and creating them if not.
    ensureLayout(masterDir())
    return saved
  })

  ipcMain.handle(CH.settingsPickFont, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a font file',
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
      properties: ['openFile']
    })
    if (res.canceled) return null
    const p = res.filePaths[0]
    return { name: path.parse(p).name, path: p }
  })

  ipcMain.handle(CH.settingsPickDir, async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(CH.settingsPickLogo, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Pick a logo image',
      filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0]
  })
}

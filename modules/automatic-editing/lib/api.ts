/**
 * Typed renderer API over the WICKED bridge (window.wicked.invoke/on).
 * Replaces the standalone app's preload-exposed `window.zirtola` object.
 *
 * Dropped vs the standalone API: updates (shell auto-updater owns those),
 * menu events (shell owns menus), setApiKey (keys live in the shell's central
 * vault → Settings → API Keys), and pathForFile (webUtils is not exposed by
 * the shell preload, so drag-and-drop path resolution is unavailable — the
 * Import buttons cover it).
 */
import { CH } from '../shared/channels'
import type {
  AppSettings,
  EDL,
  GraphicEvent,
  Project,
  ProjectSummary,
  RenderJob,
  RevisionInstruction,
  StageId,
  TimeRegion
} from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(channel, ...args) as Promise<T>

export const api = {
  // Projects
  pickSourceFile: () => invoke<string | null>(CH.pickSourceFile),
  pickProjectFile: () => invoke<string | null>(CH.pickProjectFile),
  createProject: (name: string, sourcePath?: string) => invoke<Project>(CH.projectCreate, name, sourcePath),
  setProjectSource: (id: string, sourcePath: string) => invoke<Project>(CH.projectSetSource, id, sourcePath),
  importProject: (filePath: string) => invoke<Project>(CH.projectImport, filePath),
  openProject: (id: string) => invoke<Project>(CH.projectOpen, id),
  listProjects: () => invoke<ProjectSummary[]>(CH.projectList),
  deleteProject: (id: string) => invoke<void>(CH.projectDelete, id),
  saveProject: (id: string) => invoke<Project>(CH.projectSave, id),
  duplicateProject: (id: string) => invoke<Project>(CH.projectDuplicate, id),

  // Media pool
  importMedia: (projectId: string, paths: string[]) => invoke<Project>(CH.mediaImport, projectId, paths),
  removeMedia: (projectId: string, itemId: string) => invoke<Project>(CH.mediaRemove, projectId, itemId),
  setMediaOrder: (projectId: string, itemId: string, order: number | null) =>
    invoke<Project>(CH.mediaSetOrder, projectId, itemId, order),
  startAutoEdit: (projectId: string) => invoke<void>(CH.autoEditStart, projectId),
  pickMediaFiles: () => invoke<string[]>(CH.pickMediaFiles),
  pickMediaFolder: () => invoke<string | null>(CH.pickMediaFolder),

  // Pipeline
  runPipeline: (projectId: string) => invoke<void>(CH.pipelineRun, projectId),
  runStage: (projectId: string, stage: StageId, region?: TimeRegion) =>
    invoke<void>(CH.pipelineRunStage, projectId, stage, region),
  approveGraphics: (projectId: string, approvedIds: string[], edits: GraphicEvent[]) =>
    invoke<void>(CH.pipelineApproveGraphics, projectId, approvedIds, edits),
  estimateTranscription: (projectId: string) =>
    invoke<{ minutes: number; estUsd: number }>(CH.transcriptEstimate, projectId),

  // Edits
  updateEdl: (projectId: string, edl: EDL) => invoke<Project>(CH.edlUpdate, projectId, edl),
  submitRevision: (projectId: string, text: string, region?: TimeRegion, segmentIds?: string[]) =>
    invoke<RevisionInstruction>(CH.revisionSubmit, projectId, text, region, segmentIds),

  // Approval / export
  approveFinal: (projectId: string) => invoke<void>(CH.approveFinal, projectId),
  exportFinal: (projectId: string, presetId: string) => invoke<void>(CH.exportFinal, projectId, presetId),

  // Shorts
  generateShorts: (projectId: string) => invoke<void>(CH.shortsGenerate, projectId),
  refreshShorts: (projectId: string) => invoke<Project>(CH.shortsRefresh, projectId),

  // Queue
  listJobs: () => invoke<RenderJob[]>(CH.queueList),
  cancelJob: (jobId: string) => invoke<void>(CH.queueCancel, jobId),
  onQueueEvent: (cb: (job: RenderJob) => void): (() => void) =>
    window.wicked.on(CH.queueEvent, (job) => cb(job as RenderJob)),

  // Settings
  getSettings: () => invoke<AppSettings>(CH.settingsGet),
  updateSettings: (patch: Partial<AppSettings>) => invoke<AppSettings>(CH.settingsUpdate, patch),
  setProjectsDir: (dir: string | null) => invoke<AppSettings>(CH.settingsSetProjectsDir, dir),
  pickFontFile: () => invoke<{ name: string; path: string } | null>(CH.settingsPickFont),
  pickDirectory: () => invoke<string | null>(CH.settingsPickDir),
  pickLogoFile: () => invoke<string | null>(CH.settingsPickLogo),

  // Push events
  onProjectEvent: (cb: (project: Project) => void): (() => void) =>
    window.wicked.on(CH.projectEvent, (p) => cb(p as Project))
}

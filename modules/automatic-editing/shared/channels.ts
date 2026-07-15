/**
 * IPC channel names shared by the module's main-process handlers (ipc.ts /
 * ipc/**) and its renderer (lib/api.ts). Every channel is namespaced with the
 * module id per the WICKED module contract.
 *
 * Mapping from the standalone app (src/shared/ipc.ts):
 *   `domain:action` → `automatic-editing:domain-action`
 * Renderer-bound push events keep the same convention
 * (queue:event → automatic-editing:queue-event).
 */

export const MODULE_ID = 'automatic-editing'

export const CH = {
  // Projects
  projectCreate: `${MODULE_ID}:project-create`,
  projectOpen: `${MODULE_ID}:project-open`,
  projectList: `${MODULE_ID}:project-list`,
  projectSave: `${MODULE_ID}:project-save`,
  projectDelete: `${MODULE_ID}:project-delete`,
  projectDuplicate: `${MODULE_ID}:project-duplicate`,
  projectImport: `${MODULE_ID}:project-import`,
  projectSetSource: `${MODULE_ID}:project-set-source`,
  pickSourceFile: `${MODULE_ID}:project-pick-source`,
  pickProjectFile: `${MODULE_ID}:project-pick-file`,

  // Media pool
  mediaImport: `${MODULE_ID}:media-import`,
  mediaRemove: `${MODULE_ID}:media-remove`,
  mediaSetOrder: `${MODULE_ID}:media-set-order`,
  pickMediaFiles: `${MODULE_ID}:media-pick-files`,
  pickMediaFolder: `${MODULE_ID}:media-pick-folder`,

  // Auto-edit (build sequence + run pipeline)
  autoEditStart: `${MODULE_ID}:auto-edit-start`,

  // Pipeline
  pipelineRun: `${MODULE_ID}:pipeline-run`,
  pipelineRunStage: `${MODULE_ID}:pipeline-run-stage`,
  pipelineApproveGraphics: `${MODULE_ID}:pipeline-approve-graphics`,
  transcriptEstimate: `${MODULE_ID}:pipeline-transcript-estimate`,

  // EDL / edits
  edlUpdate: `${MODULE_ID}:edl-update`,
  revisionSubmit: `${MODULE_ID}:revision-submit`,

  // Review / approval
  approveFinal: `${MODULE_ID}:project-approve-final`,
  exportFinal: `${MODULE_ID}:export-final`,

  // Shorts
  shortsGenerate: `${MODULE_ID}:shorts-generate`,
  shortsRefresh: `${MODULE_ID}:shorts-refresh`,

  // Queue
  queueList: `${MODULE_ID}:queue-list`,
  queueCancel: `${MODULE_ID}:queue-cancel`,

  // Settings
  settingsGet: `${MODULE_ID}:settings-get`,
  settingsUpdate: `${MODULE_ID}:settings-update`,
  settingsSetKey: `${MODULE_ID}:settings-set-key`,
  settingsSetProjectsDir: `${MODULE_ID}:settings-set-projects-dir`,
  settingsPickFont: `${MODULE_ID}:settings-pick-font`,
  settingsPickDir: `${MODULE_ID}:settings-pick-dir`,
  settingsPickLogo: `${MODULE_ID}:settings-pick-logo`,

  // Renderer-bound push events
  queueEvent: `${MODULE_ID}:queue-event`,
  projectEvent: `${MODULE_ID}:project-event`
} as const

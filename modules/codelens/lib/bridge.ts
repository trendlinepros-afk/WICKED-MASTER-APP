// Rebuilds the standalone app's `window.codelens` preload API on top of the
// WICKED shell bridge (`window.wicked.invoke`) with the codelens:* channels.
// Renderer code imports `codelensApi` from here instead of touching window.
import { CHANNELS } from '../shared/api'
import type { CodeLensApi } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(channel, ...args) as Promise<T>

export const codelensApi: CodeLensApi = {
  selectFolder: () => invoke(CHANNELS.selectFolder),
  scanProject: (rootPath) => invoke(CHANNELS.scanProject, rootPath),
  readFile: (relPath) => invoke(CHANNELS.readFile, relPath),
  getSettings: () => invoke(CHANNELS.getSettings),
  setCustomIgnores: (ignores) => invoke(CHANNELS.setCustomIgnores, ignores),
  testApiKey: () => invoke(CHANNELS.testApiKey),
  setAiConfig: (provider, model) => invoke(CHANNELS.setAiConfig, provider, model),
  explainFile: (relPath) => invoke(CHANNELS.explainFile, relPath),
  explainConnections: (relPath) => invoke(CHANNELS.explainConnections, relPath),
  explainIssue: (issueId) => invoke(CHANNELS.explainIssue, issueId),
  summarizeProject: () => invoke(CHANNELS.summarizeProject),
  exportReport: (markdown, format) => invoke(CHANNELS.exportReport, markdown, format)
}

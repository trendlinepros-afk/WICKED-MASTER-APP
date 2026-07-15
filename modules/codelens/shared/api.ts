import type { AiProvider, ExplainResult, IpcResult, ScanResult, Settings } from './types'

/**
 * IPC channel names shared by the module's main-process ipc.ts and the renderer
 * bridge. All channels are namespaced `codelens:<action>` per the WICKED module
 * contract (original standalone-app channels are noted for reference).
 */
export const CHANNELS = {
  /** was dialog:select-folder */
  selectFolder: 'codelens:select-folder',
  /** was project:scan */
  scanProject: 'codelens:scan',
  /** was project:read-file */
  readFile: 'codelens:read-file',
  /** was settings:get */
  getSettings: 'codelens:settings-get',
  /** was settings:set-ignores */
  setCustomIgnores: 'codelens:settings-set-ignores',
  /** was apikey:test — keys themselves now live in the WICKED central vault */
  testApiKey: 'codelens:apikey-test',
  /** was ai:set-config */
  setAiConfig: 'codelens:ai-set-config',
  /** was ai:explain-file */
  explainFile: 'codelens:ai-explain-file',
  /** was ai:explain-connections */
  explainConnections: 'codelens:ai-explain-connections',
  /** was ai:explain-issue */
  explainIssue: 'codelens:ai-explain-issue',
  /** was ai:summarize */
  summarizeProject: 'codelens:ai-summarize',
  /** was report:export */
  exportReport: 'codelens:report-export'
} as const

/**
 * The API surface the renderer consumes. In the standalone app this was exposed
 * as `window.codelens` by a dedicated preload; in WICKED it is rebuilt on top of
 * `window.wicked.invoke` — see lib/bridge.ts.
 */
export interface CodeLensApi {
  selectFolder(): Promise<string | null>
  scanProject(rootPath: string): Promise<IpcResult<ScanResult>>
  readFile(relPath: string): Promise<IpcResult<{ content: string; truncated: boolean }>>
  getSettings(): Promise<Settings>
  setCustomIgnores(ignores: string[]): Promise<Settings>
  /**
   * Tests the active provider + model with a tiny live request, using the key
   * from the WICKED central vault (Settings → API Keys).
   */
  testApiKey(): Promise<IpcResult<string>>
  /** Sets the active provider and its model. */
  setAiConfig(provider: AiProvider, model: string): Promise<Settings>
  explainFile(relPath: string): Promise<IpcResult<ExplainResult>>
  explainConnections(relPath: string): Promise<IpcResult<string>>
  explainIssue(issueId: string): Promise<IpcResult<string>>
  summarizeProject(): Promise<IpcResult<string>>
  exportReport(markdown: string, format: 'md' | 'pdf'): Promise<IpcResult<string | null>>
}

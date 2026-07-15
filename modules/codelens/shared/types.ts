/** Languages CodeLens understands. `config` covers JSON/YAML/TOML/env-style files. */
export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'csharp'
  | 'php'
  | 'go'
  | 'config'
  | 'markdown'
  | 'other'

export type Severity = 'low' | 'medium' | 'high' | 'critical'

export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
}

export interface FileInfo {
  /** Path relative to the project root, posix separators. */
  relPath: string
  name: string
  /** Directory portion of relPath ('' for root-level files). */
  dir: string
  ext: string
  language: Language
  size: number
  lines: number
  /** Rough branch-density score, 1 (simple) to 10 (gnarly). */
  complexity: number
  /** True when the file content was read and parsed for imports/issues. */
  parsed: boolean
  /** Package/module names imported from outside the project (capped). */
  externalImports: string[]
}

export interface TreeNode {
  relPath: string
  name: string
  type: 'dir' | 'file'
  language?: Language
  issueCount: number
  maxSeverity?: Severity
  children?: TreeNode[]
}

export type EdgeKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 'reexport'
  | 'from-import'
  | 'include'
  | 'using'
  | 'package'

export interface GraphEdge {
  id: string
  /** relPath of the importing file. */
  source: string
  /** relPath of the imported file. */
  target: string
  kind: EdgeKind
}

export interface VulnIssue {
  id: string
  ruleId: string
  title: string
  severity: Severity
  file: string
  line: number
  snippet: string
  description: string
  recommendation: string
}

export interface ScanResult {
  rootPath: string
  projectName: string
  scannedAt: number
  durationMs: number
  fileCount: number
  dirCount: number
  skippedCount: number
  truncated: boolean
  tree: TreeNode
  files: FileInfo[]
  edges: GraphEdge[]
  issues: VulnIssue[]
}

export interface ExplainResult {
  summary: string
  detail: string
}

export type AiProvider = 'claude' | 'openai' | 'gemini' | 'deepseek'

export interface AiConfig {
  /** The provider AI calls are routed to. */
  provider: AiProvider
  /** Model for the active provider. */
  model: string
  /** Remembered model choice per provider. */
  models: Record<AiProvider, string>
  /** Whether an API key is stored, per provider. */
  hasKey: Record<AiProvider, boolean>
}

export interface Settings {
  ai: AiConfig
  recentProjects: string[]
  customIgnores: string[]
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

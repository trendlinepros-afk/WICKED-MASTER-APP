import { promises as fs } from 'fs'
import * as path from 'path'
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import { SEVERITY_RANK } from '../shared/types'
import type { FileInfo, Language, TreeNode, VulnIssue } from '../shared/types'

export interface ScannedProject {
  rootPath: string
  tree: TreeNode
  files: FileInfo[]
  /** Contents of every parsed file, keyed by relPath. Discarded after scan. */
  contents: Map<string, string>
  dirCount: number
  skippedCount: number
  truncated: boolean
}

const MAX_FILES = 8000
const MAX_PARSE_BYTES = 1_500_000
const MAX_DEPTH = 16

/** Always ignored, on top of .gitignore and the user's custom list. */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/',
  '.git/',
  '.hg/',
  '.svn/',
  'dist/',
  'build/',
  'out/',
  'dist-electron/',
  '.next/',
  '.nuxt/',
  '.cache/',
  '.parcel-cache/',
  '.turbo/',
  'coverage/',
  '.nyc_output/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.idea/',
  '.vs/',
  '.vscode/',
  'bin/',
  'obj/',
  'vendor/',
  'target/',
  'Pods/',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  '*.pyc',
  '*.dll',
  '*.exe',
  '*.so',
  '*.dylib',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.webp',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp4',
  '*.mp3',
  '*.pdf',
  '*.zip',
  '*.gz',
  '*.tar',
  '.DS_Store',
  'Thumbs.db'
]

const LANG_BY_EXT: Record<string, Language> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.cs': 'csharp',
  '.php': 'php',
  '.go': 'go',
  '.json': 'config',
  '.yml': 'config',
  '.yaml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.env': 'config',
  '.cfg': 'config',
  '.conf': 'config',
  '.properties': 'config',
  '.xml': 'config',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'other',
  '.html': 'other',
  '.css': 'other',
  '.scss': 'other',
  '.sh': 'other',
  '.ps1': 'other',
  '.sql': 'other'
}

const PARSEABLE = new Set<Language>([
  'javascript',
  'typescript',
  'python',
  'csharp',
  'php',
  'go',
  'config',
  'markdown',
  'other'
])

const BRANCH_RE = /\b(if|else if|elif|for|foreach|while|case|when|catch|except|rescue)\b|(&&|\|\||\?\?)/g

export function detectLanguage(ext: string, name: string): Language {
  const lower = name.toLowerCase()
  if (lower.startsWith('.env')) return 'config'
  if (lower === 'dockerfile' || lower === 'makefile' || lower === '.gitignore' || lower === 'go.mod') {
    return 'config'
  }
  return LANG_BY_EXT[ext] ?? 'other'
}

function computeComplexity(content: string): number {
  const matches = content.match(BRANCH_RE)
  const count = matches ? matches.length : 0
  return Math.max(1, Math.min(10, Math.round(Math.sqrt(count))))
}

export async function scanProject(rootPath: string, customIgnores: string[]): Promise<ScannedProject> {
  const rootStat = await fs.stat(rootPath)
  if (!rootStat.isDirectory()) throw new Error('Selected path is not a folder')

  const baseIg = ignore().add(DEFAULT_IGNORE_PATTERNS)
  if (customIgnores.length > 0) baseIg.add(customIgnores)

  // Stack of .gitignore matchers, each scoped to the directory that contains it.
  const igStack: { base: string; ig: Ignore }[] = []

  const files: FileInfo[] = []
  const contents = new Map<string, string>()
  let dirCount = 0
  let skippedCount = 0
  let truncated = false

  function isIgnored(rel: string, isDir: boolean): boolean {
    const probe = isDir ? `${rel}/` : rel
    if (baseIg.ignores(probe) || (isDir && baseIg.ignores(rel))) return true
    for (const { base, ig } of igStack) {
      const sub = base ? rel.slice(base.length + 1) : rel
      if (!sub) continue
      const p = isDir ? `${sub}/` : sub
      if (ig.ignores(p) || (isDir && ig.ignores(sub))) return true
    }
    return false
  }

  async function readGitignore(absDir: string): Promise<Ignore | null> {
    try {
      const txt = await fs.readFile(path.join(absDir, '.gitignore'), 'utf8')
      return ignore().add(txt)
    } catch {
      return null
    }
  }

  async function collectFile(absPath: string, rel: string, name: string): Promise<FileInfo | null> {
    let st
    try {
      st = await fs.stat(absPath)
    } catch {
      return null
    }
    const ext = path.extname(name).toLowerCase()
    const language = detectLanguage(ext, name)
    const info: FileInfo = {
      relPath: rel,
      name,
      dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
      ext,
      language,
      size: st.size,
      lines: 0,
      complexity: 1,
      parsed: false,
      externalImports: []
    }
    if (PARSEABLE.has(language) && st.size > 0 && st.size <= MAX_PARSE_BYTES) {
      try {
        let content = await fs.readFile(absPath, 'utf8')
        // Strip a UTF-8 BOM — it breaks line-anchored regexes on the first line.
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
        if (!content.includes(String.fromCharCode(0))) {
          contents.set(rel, content)
          info.lines = content.split('\n').length
          info.complexity = computeComplexity(content)
          info.parsed = true
        }
      } catch {
        // unreadable file — keep the stat-only entry
      }
    }
    return info
  }

  async function walk(absDir: string, relDir: string, depth: number): Promise<TreeNode[]> {
    if (depth > MAX_DEPTH) return []
    dirCount++
    const gi = await readGitignore(absDir)
    if (gi) igStack.push({ base: relDir, ig: gi })

    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      skippedCount++
      if (gi) igStack.pop()
      return []
    }

    const nodes: TreeNode[] = []
    for (const ent of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        break
      }
      if (ent.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (isIgnored(rel, true)) continue
        const children = await walk(path.join(absDir, ent.name), rel, depth + 1)
        if (children.length > 0) {
          nodes.push({ relPath: rel, name: ent.name, type: 'dir', issueCount: 0, children })
        }
      } else if (ent.isFile()) {
        if (isIgnored(rel, false)) continue
        const info = await collectFile(path.join(absDir, ent.name), rel, ent.name)
        if (info) {
          files.push(info)
          nodes.push({
            relPath: rel,
            name: ent.name,
            type: 'file',
            language: info.language,
            issueCount: 0
          })
        } else {
          skippedCount++
        }
      }
    }

    if (gi) igStack.pop()
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  const children = await walk(rootPath, '', 0)
  const tree: TreeNode = {
    relPath: '',
    name: path.basename(rootPath) || rootPath,
    type: 'dir',
    issueCount: 0,
    children
  }

  return { rootPath, tree, files, contents, dirCount, skippedCount, truncated }
}

/** Fill issueCount / maxSeverity onto every tree node (files, then bubbled up to dirs). */
export function annotateTree(tree: TreeNode, issues: VulnIssue[]): void {
  const byFile = new Map<string, VulnIssue[]>()
  for (const issue of issues) {
    const list = byFile.get(issue.file)
    if (list) list.push(issue)
    else byFile.set(issue.file, [issue])
  }

  function visit(node: TreeNode): { count: number; max?: VulnIssue['severity'] } {
    if (node.type === 'file') {
      const list = byFile.get(node.relPath) ?? []
      node.issueCount = list.length
      node.maxSeverity = list.length
        ? list.reduce((m, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[m] ? i.severity : m), list[0].severity)
        : undefined
      return { count: node.issueCount, max: node.maxSeverity }
    }
    let count = 0
    let max: VulnIssue['severity'] | undefined
    for (const child of node.children ?? []) {
      const res = visit(child)
      count += res.count
      if (res.max && (!max || SEVERITY_RANK[res.max] > SEVERITY_RANK[max])) max = res.max
    }
    node.issueCount = count
    node.maxSeverity = max
    return { count, max }
  }

  visit(tree)
}

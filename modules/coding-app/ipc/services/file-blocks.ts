import type { ParsedFileBlock } from '../../shared/types'

/**
 * Pure parsing of assistant file blocks — no Electron/fs imports so it can be
 * unit-tested in isolation. `FileManager` consumes `parseFileBlocks` from here.
 */

// Fenced-code languages that are shell/terminal snippets, not files to write.
const NON_FILE_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'console', 'shell-session', 'powershell',
  'ps1', 'text', 'plaintext', 'txt', 'output', 'log', 'diff'
])

// Default filename to use when a code block names no path — inferred from its
// language so single-file answers ("here's the code") still land on disk.
const LANG_DEFAULT_FILE: Record<string, string> = {
  python: 'main.py', py: 'main.py',
  javascript: 'index.js', js: 'index.js', mjs: 'index.js',
  typescript: 'index.ts', ts: 'index.ts',
  jsx: 'App.jsx', tsx: 'App.tsx',
  html: 'index.html', htm: 'index.html',
  css: 'style.css', scss: 'style.scss',
  java: 'Main.java',
  c: 'main.c', cpp: 'main.cpp', 'c++': 'main.cpp',
  csharp: 'Program.cs', cs: 'Program.cs',
  go: 'main.go',
  rust: 'main.rs', rs: 'main.rs',
  ruby: 'main.rb', rb: 'main.rb',
  php: 'index.php',
  json: 'data.json',
  yaml: 'config.yaml', yml: 'config.yaml',
  markdown: 'README.md', md: 'README.md',
  vue: 'App.vue', svelte: 'App.svelte', sql: 'schema.sql'
}

interface RawFence {
  lang: string
  header: string
  body: string
  precededBy: string
}

/**
 * Extract file blocks from an assistant response. A file's path is resolved in
 * priority order:
 *   1. the fence info string (`title="x"`, `file=x`, `path:x`, or `lang x.ext`)
 *   2. a filename comment on the first line of the block (`# main.py`, `// x`,
 *      `<!-- index.html -->`, `# file: x`)
 *   3. a `FILE: x` directive on the line just before the fence
 * If NO block names a path, we infer filenames from each code block's language
 * (skipping shell/terminal snippets and ambiguous duplicate languages) so the
 * common "here's a single script" case still writes a file.
 */
export function parseFileBlocks(raw: string): ParsedFileBlock[] {
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g
  const fences: RawFence[] = []
  let match: RegExpExecArray | null
  let lastIndex = 0
  while ((match = fenceRe.exec(raw)) !== null) {
    const header = match[1].trim()
    fences.push({
      lang: (header.split(/\s+/)[0] ?? '').toLowerCase(),
      header,
      body: match[2],
      precededBy: raw.slice(lastIndex, match.index)
    })
    lastIndex = fenceRe.lastIndex
  }

  const blocks: ParsedFileBlock[] = []
  const unlabeled: RawFence[] = []
  for (const f of fences) {
    const action = f.body.trim() === 'DELETE' ? 'delete' : 'update'
    const path =
      extractPathFromHeader(f.header) ??
      pathFromFirstLine(f.body) ??
      pathFromPreceding(f.precededBy)
    if (path) {
      blocks.push({ path, content: action === 'delete' ? '' : f.body, action })
    } else if (f.lang && !NON_FILE_LANGS.has(f.lang)) {
      unlabeled.push(f)
    }
  }

  // Fallback only when nothing was explicitly labelled — infer per language,
  // skipping languages that appear more than once (can't safely disambiguate).
  if (blocks.length === 0 && unlabeled.length > 0) {
    const seen = new Set<string>()
    const dup = new Set<string>()
    for (const f of unlabeled) {
      if (seen.has(f.lang)) dup.add(f.lang)
      seen.add(f.lang)
    }
    for (const f of unlabeled) {
      if (dup.has(f.lang)) continue
      const inferred = LANG_DEFAULT_FILE[f.lang]
      if (inferred) blocks.push({ path: inferred, content: f.body, action: 'update' })
    }
  }

  return blocks
}

function extractPathFromHeader(header: string): string | null {
  const title = header.match(/title=["']([^"']+)["']/)
  if (title) return title[1]
  const file = header.match(/(?:file|path)[:=]["']?([^\s"']+)["']?/i)
  if (file) return file[1]
  // `lang path/to/file.ext` — take a token that looks like a path.
  for (const t of header.split(/\s+/)) {
    if (/[./\\]/.test(t) && /\.\w+$/.test(t)) return t
  }
  return null
}

/** Detect a filename comment on the first non-empty line of a code block. */
function pathFromFirstLine(body: string): string | null {
  const first = body.split('\n').find((l) => l.trim() !== '')
  if (!first) return null
  const labelled = first.match(
    /^\s*(?:#|\/\/|<!--)\s*(?:file|filename|path)\s*[:=]\s*([\w./\\-]+\.\w+)\s*(?:-->)?\s*$/i
  )
  if (labelled) return labelled[1]
  const bareHtml = first.match(/^\s*<!--\s*([\w./\\-]+\.\w+)\s*-->\s*$/)
  if (bareHtml) return bareHtml[1]
  const bare = first.match(/^\s*(?:#|\/\/)\s*([\w./\\-]+\.\w+)\s*$/)
  if (bare) return bare[1]
  return null
}

/** Detect a `FILE: path` (or bold/heading path) directive before a fence. */
function pathFromPreceding(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1]
  if (!last) return null
  const directive = last.match(/(?:\/\/|#|<!--)?\s*FILE:\s*(.+?)\s*(?:-->)?$/i)
  if (directive) return directive[1].trim()
  const marked = last.match(/^[#*`\s]*([\w./\\-]+\.\w+)[`*:\s]*$/)
  if (marked && /[./]/.test(marked[1])) return marked[1]
  return null
}

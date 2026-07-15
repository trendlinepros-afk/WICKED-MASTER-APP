import type { EdgeKind, GraphEdge } from '../shared/types'
import type { ScannedProject } from './scanner'

const JS_EXT_CANDIDATES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']
const MAX_EXTERNALS_PER_FILE = 30
const MAX_EDGES_PER_NAMESPACE = 10
const MAX_EDGES_PER_GO_PACKAGE = 8

interface Builder {
  edges: GraphEdge[]
  seen: Set<string>
  nextId: number
}

function addEdge(b: Builder, source: string, target: string, kind: EdgeKind): void {
  if (source === target) return
  const key = `${source}|${target}`
  if (b.seen.has(key)) return
  b.seen.add(key)
  b.edges.push({ id: `e${b.nextId++}`, source, target, kind })
}

function posixNormalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return '' // escaped above the project root
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts.join('/')
}

function stripQuery(spec: string): string {
  return spec.split('?')[0].split('#')[0]
}

export function buildGraph(project: ScannedProject): GraphEdge[] {
  const b: Builder = { edges: [], seen: new Set(), nextId: 0 }
  const fileSet = new Set(project.files.map((f) => f.relPath))
  const byFile = new Map(project.files.map((f) => [f.relPath, f]))

  // --- shared resolution helpers -------------------------------------------

  function resolveJsLike(fromDir: string, rawSpec: string): string | null {
    const spec = stripQuery(rawSpec).replace(/\/+$/, '')
    if (!spec) return null
    let base: string | null = null
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      base = posixNormalize(fromDir ? `${fromDir}/${spec}` : spec)
    } else if (spec.startsWith('@/')) {
      // common Vite/webpack alias for src/
      const rest = spec.slice(2)
      return tryCandidates(`src/${rest}`) ?? tryCandidates(rest)
    } else if (spec.startsWith('~/')) {
      return tryCandidates(spec.slice(2))
    } else if (spec.startsWith('@') && spec.includes('/')) {
      // Either an npm scope (@scope/pkg) or a tsconfig path alias (@shared/types).
      // Try it as a local alias first; fall back to external if nothing matches.
      const rest = spec.slice(1)
      return tryCandidates(`src/${rest}`) ?? tryCandidates(rest)
    } else {
      return null // bare specifier → external package
    }
    if (base === null || base === '') return null
    return tryCandidates(base)
  }

  function tryCandidates(base: string): string | null {
    if (fileSet.has(base)) return base
    for (const ext of JS_EXT_CANDIDATES) {
      if (fileSet.has(base + ext)) return base + ext
    }
    for (const ext of JS_EXT_CANDIDATES) {
      if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`
    }
    return null
  }

  function externalName(spec: string): string {
    return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  }

  // --- C# namespace index ----------------------------------------------------

  const nsToFiles = new Map<string, string[]>()
  for (const file of project.files) {
    if (file.language !== 'csharp') continue
    const content = project.contents.get(file.relPath)
    if (!content) continue
    const nsRe = /\bnamespace\s+([\w.]+)/g
    let m: RegExpExecArray | null
    while ((m = nsRe.exec(content)) !== null) {
      const list = nsToFiles.get(m[1])
      if (list) list.push(file.relPath)
      else nsToFiles.set(m[1], [file.relPath])
    }
  }

  // --- Go module name --------------------------------------------------------

  let goModule: string | null = null
  const goMod = project.contents.get('go.mod')
  if (goMod) {
    const m = goMod.match(/^module\s+(\S+)/m)
    if (m) goModule = m[1]
  }
  const goFilesByDir = new Map<string, string[]>()
  for (const file of project.files) {
    if (file.language !== 'go') continue
    const list = goFilesByDir.get(file.dir)
    if (list) list.push(file.relPath)
    else goFilesByDir.set(file.dir, [file.relPath])
  }

  // --- PHP basename index ----------------------------------------------------

  const phpFiles = project.files.filter((f) => f.language === 'php').map((f) => f.relPath)

  // --- per-file extraction ---------------------------------------------------

  for (const file of project.files) {
    const content = project.contents.get(file.relPath)
    if (!content) continue
    const externals = new Set<string>()

    if (file.language === 'javascript' || file.language === 'typescript') {
      const patterns: { kind: EdgeKind; re: RegExp }[] = [
        { kind: 'reexport', re: /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g },
        { kind: 'import', re: /\bimport\s+(?:type\s+)?(?:[\w*\s{},$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g },
        { kind: 'require', re: /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
        { kind: 'dynamic-import', re: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g }
      ]
      for (const { kind, re } of patterns) {
        let m: RegExpExecArray | null
        while ((m = re.exec(content)) !== null) {
          const spec = m[1]
          const resolved = resolveJsLike(file.dir, spec)
          if (resolved) {
            addEdge(b, file.relPath, resolved, kind)
          } else if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/')) {
            externals.add(externalName(stripQuery(spec)))
          }
        }
      }
    } else if (file.language === 'python') {
      const sourceRoots = [file.dir, '', 'src']

      function resolvePyModule(module: string): string | null {
        const asPath = module.replace(/\./g, '/')
        for (const root of sourceRoots) {
          const base = root ? `${root}/${asPath}` : asPath
          if (fileSet.has(`${base}.py`)) return `${base}.py`
          if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`
        }
        return null
      }

      const importRe = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm
      let m: RegExpExecArray | null
      while ((m = importRe.exec(content)) !== null) {
        for (const mod of m[1].split(',').map((s) => s.trim())) {
          const resolved = resolvePyModule(mod)
          if (resolved) addEdge(b, file.relPath, resolved, 'import')
          else externals.add(mod.split('.')[0])
        }
      }

      const fromRe = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([\w*,\s()]+)/gm
      while ((m = fromRe.exec(content)) !== null) {
        const dots = m[1].length
        const module = m[2]
        if (dots === 0) {
          const resolved = resolvePyModule(module)
          if (resolved) addEdge(b, file.relPath, resolved, 'from-import')
          else if (module) externals.add(module.split('.')[0])
        } else {
          // relative import: 1 dot = current dir, each extra dot = one level up
          let baseDir = file.dir
          for (let i = 1; i < dots && baseDir; i++) {
            baseDir = baseDir.includes('/') ? baseDir.slice(0, baseDir.lastIndexOf('/')) : ''
          }
          const modPath = module ? module.replace(/\./g, '/') : ''
          const tryResolve = (rel: string): string | null => {
            const base = posixNormalize(rel)
            if (!base) return null
            if (fileSet.has(`${base}.py`)) return `${base}.py`
            if (fileSet.has(`${base}/__init__.py`)) return `${base}/__init__.py`
            return null
          }
          if (modPath) {
            const target = tryResolve(baseDir ? `${baseDir}/${modPath}` : modPath)
            if (target) addEdge(b, file.relPath, target, 'from-import')
          } else {
            // `from . import a, b` — each imported name is a sibling module
            for (const name of m[3].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) {
              if (!/^\w+$/.test(name)) continue
              const target = tryResolve(baseDir ? `${baseDir}/${name}` : name)
              if (target) addEdge(b, file.relPath, target, 'from-import')
            }
          }
        }
      }
    } else if (file.language === 'go') {
      const specs: string[] = []
      const singleRe = /^import\s+(?:\w+\s+)?"([^"]+)"/gm
      let m: RegExpExecArray | null
      while ((m = singleRe.exec(content)) !== null) specs.push(m[1])
      const blockRe = /import\s*\(([^)]*)\)/g
      while ((m = blockRe.exec(content)) !== null) {
        const inner = m[1]
        const lineRe = /"([^"]+)"/g
        let lm: RegExpExecArray | null
        while ((lm = lineRe.exec(inner)) !== null) specs.push(lm[1])
      }
      for (const spec of specs) {
        if (goModule && (spec === goModule || spec.startsWith(`${goModule}/`))) {
          const dir = spec === goModule ? '' : spec.slice(goModule.length + 1)
          const targets = goFilesByDir.get(dir) ?? []
          for (const target of targets.slice(0, MAX_EDGES_PER_GO_PACKAGE)) {
            addEdge(b, file.relPath, target, 'package')
          }
        } else if (!spec.includes('.')) {
          externals.add(spec) // stdlib
        } else {
          externals.add(spec)
        }
      }
    } else if (file.language === 'csharp') {
      const usingRe = /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/gm
      let m: RegExpExecArray | null
      while ((m = usingRe.exec(content)) !== null) {
        const ns = m[1]
        const targets = nsToFiles.get(ns)
        if (targets) {
          for (const target of targets.slice(0, MAX_EDGES_PER_NAMESPACE)) {
            addEdge(b, file.relPath, target, 'using')
          }
        } else {
          externals.add(ns.split('.')[0])
        }
      }
    } else if (file.language === 'php') {
      const incRe = /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"\n]+)['"]/g
      let m: RegExpExecArray | null
      while ((m = incRe.exec(content)) !== null) {
        const spec = m[1].replace(/^\//, '')
        const fromFileDir = posixNormalize(file.dir ? `${file.dir}/${spec}` : spec)
        if (fromFileDir && fileSet.has(fromFileDir)) {
          addEdge(b, file.relPath, fromFileDir, 'include')
        } else if (fileSet.has(posixNormalize(spec))) {
          addEdge(b, file.relPath, posixNormalize(spec), 'include')
        }
      }
      const useRe = /^\s*use\s+([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm
      while ((m = useRe.exec(content)) !== null) {
        const parts = m[1].split('\\').filter(Boolean)
        if (parts.length === 0) continue
        let found: string | null = null
        // try the longest suffix match first: A\B\C → A/B/C.php, then B/C.php, then C.php
        for (let i = 0; i < parts.length && !found; i++) {
          const suffix = `${parts.slice(i).join('/')}.php`
          found = phpFiles.find((p) => p === suffix || p.endsWith(`/${suffix}`)) ?? null
        }
        if (found) addEdge(b, file.relPath, found, 'using')
        else externals.add(parts[0])
      }
    }

    const info = byFile.get(file.relPath)
    if (info) info.externalImports = Array.from(externals).slice(0, MAX_EXTERNALS_PER_FILE)
  }

  return b.edges
}

import { join, dirname, relative, sep, isAbsolute, resolve } from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync
} from 'fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { configStore } from './config-persistence'
import { logger } from './logger'
import { parseFileBlocks } from './file-blocks'
import type { FileNode, ProjectInfo, FileChange } from '../../shared/types'

// Re-export so existing importers (and tests) can keep using it from here.
export { parseFileBlocks }

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache'
])

/**
 * Project + file operations, Claude-Code style: the AI emits file blocks with
 * paths relative to the active project root; we write them to disk (creating
 * folders recursively). A chokidar watcher notifies the renderer of external
 * changes so the file tree / preview stay live.
 */
export class FileManager {
  private activeRoot: string | null = null
  private watcher: FSWatcher | null = null
  private onChange: ((path: string) => void) | null = null

  setChangeListener(cb: (path: string) => void): void {
    this.onChange = cb
  }

  getActiveRoot(): string | null {
    return this.activeRoot
  }

  createProject(name: string): ProjectInfo {
    const root = configStore.load().projectsRootPath
    if (!root) throw new Error('Projects root folder is not set in Settings.')
    const safe = sanitizeName(name)
    if (!safe) throw new Error('Invalid project name.')
    const projectPath = join(root, safe)
    if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true })
    return this.setActive(projectPath)
  }

  openProject(rootPath: string): ProjectInfo {
    if (!existsSync(rootPath)) throw new Error('Project folder does not exist.')
    return this.setActive(rootPath)
  }

  setActive(rootPath: string): ProjectInfo {
    this.activeRoot = rootPath
    this.startWatching(rootPath)
    return { name: rootPath.split(/[\\/]/).pop() ?? rootPath, rootPath }
  }

  private requireRoot(): string {
    if (!this.activeRoot) throw new Error('No active project.')
    return this.activeRoot
  }

  /** Resolve a relative path safely inside the active project (prevents escapes). */
  private resolveSafe(relPath: string): string {
    const root = this.requireRoot()
    const cleaned = relPath.replace(/^[\\/]+/, '')
    const abs = isAbsolute(cleaned) ? cleaned : resolve(root, cleaned)
    const rel = relative(root, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes project root: ${relPath}`)
    }
    return abs
  }

  getFileTree(): FileNode[] {
    const root = this.requireRoot()
    return this.readDir(root, root)
  }

  private readDir(dir: string, root: string): FileNode[] {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue
      const abs = join(dir, entry)
      let s
      try {
        s = statSync(abs)
      } catch {
        continue
      }
      const relPath = relative(root, abs).split(sep).join('/')
      if (s.isDirectory()) {
        nodes.push({
          name: entry,
          path: relPath,
          isDirectory: true,
          children: this.readDir(abs, root)
        })
      } else {
        nodes.push({ name: entry, path: relPath, isDirectory: false })
      }
    }
    // Directories first, then files, alphabetically.
    return nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  readFile(relPath: string): string {
    return readFileSync(this.resolveSafe(relPath), 'utf-8')
  }

  writeFile(relPath: string, content: string): void {
    const abs = this.resolveSafe(relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }

  deleteFile(relPath: string): void {
    const abs = this.resolveSafe(relPath)
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true })
  }

  renameFile(relPath: string, newRelPath: string): void {
    const from = this.resolveSafe(relPath)
    const to = this.resolveSafe(newRelPath)
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  }

  /**
   * Parse an assistant message for fenced file blocks and write them to disk.
   * Supported header forms (first line inside or just before a fence):
   *   ```ts title="src/a.ts"    ```js file=src/a.js    ```path:src/a.py
   * or an explicit directive line before a fence:  // FILE: src/a.ts
   * A block whose body is exactly `DELETE` removes the file.
   */
  applyFileBlocks(raw: string): FileChange[] {
    const blocks = parseFileBlocks(raw)
    const changes: FileChange[] = []
    for (const b of blocks) {
      try {
        if (b.action === 'delete') {
          this.deleteFile(b.path)
          changes.push({ path: b.path, action: 'delete' })
        } else {
          const existed = existsSync(this.resolveSafe(b.path))
          this.writeFile(b.path, b.content)
          changes.push({
            path: b.path,
            action: existed ? 'update' : 'create'
          })
        }
      } catch (err) {
        logger.error('applyFileBlocks failed for', b.path, err)
      }
    }
    return changes
  }

  /**
   * Parse file blocks WITHOUT writing anything — used by "ask" mode to show the
   * user what would change so they can approve or reject first.
   */
  previewFileBlocks(raw: string): FileChange[] {
    return parseFileBlocks(raw).map((b) => {
      if (b.action === 'delete') return { path: b.path, action: 'delete' as const }
      let existed = false
      try {
        existed = existsSync(this.resolveSafe(b.path))
      } catch {
        existed = false
      }
      return { path: b.path, action: existed ? ('update' as const) : ('create' as const) }
    })
  }

  private startWatching(root: string): void {
    this.watcher?.close()
    this.watcher = chokidar.watch(root, {
      ignored: (p: string) =>
        [...IGNORED_DIRS].some((d) => p.includes(`${sep}${d}${sep}`) || p.endsWith(`${sep}${d}`)),
      ignoreInitial: true,
      depth: 20
    })
    const notify = (p: string): void => {
      const rel = relative(root, p).split(sep).join('/')
      this.onChange?.(rel)
    }
    this.watcher
      .on('add', notify)
      .on('change', notify)
      .on('unlink', notify)
      .on('addDir', notify)
      .on('unlinkDir', notify)
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
}

export const fileManager = new FileManager()

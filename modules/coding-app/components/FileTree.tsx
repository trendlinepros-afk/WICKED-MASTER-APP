import { useState } from 'react'
import type { FileNode } from '../shared/types'
import { useStore } from '../store'
import { api } from '../lib/bridge'

/**
 * Recursive file tree for the active project. Reads everything it needs from the
 * store (fileTree, openFilePath, openFile, deleteFile, refreshFileTree) and
 * exposes a small toolbar for New File / Rename / Delete operations that talk to
 * the main process directly via the bridge.
 */
export function FileTree(): JSX.Element {
  const fileTree = useStore((s) => s.fileTree)
  const openFilePath = useStore((s) => s.openFilePath)
  const openFile = useStore((s) => s.openFile)
  const deleteFile = useStore((s) => s.deleteFile)
  const refreshFileTree = useStore((s) => s.refreshFileTree)
  const setBanner = useStore((s) => s.setBanner)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Inline prompt (Electron has no window.prompt). mode drives the action.
  const [prompt, setPrompt] = useState<{ mode: 'new' | 'rename'; value: string } | null>(
    null
  )

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const submitPrompt = async (): Promise<void> => {
    if (!prompt) return
    const value = prompt.value.trim()
    if (!value) return
    try {
      if (prompt.mode === 'new') {
        await api.writeFile(value, '')
        await refreshFileTree()
        await openFile(value)
      } else if (prompt.mode === 'rename' && openFilePath && value !== openFilePath) {
        await api.renameFile(openFilePath, value)
        await refreshFileTree()
        await openFile(value)
      }
      setPrompt(null)
    } catch (err) {
      setBanner({ kind: 'error', text: `Operation failed: ${(err as Error).message}` })
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!openFilePath) return
    if (!window.confirm(`Delete ${openFilePath}?`)) return
    try {
      await deleteFile(openFilePath)
    } catch (err) {
      setBanner({ kind: 'error', text: `Cannot delete: ${(err as Error).message}` })
    }
  }

  const btnClass =
    'rounded border border-edge px-2 py-0.5 text-xs text-ink hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b border-edge p-2">
        <button
          className={btnClass}
          onClick={() => setPrompt({ mode: 'new', value: '' })}
        >
          New File
        </button>
        <button
          className={btnClass}
          disabled={!openFilePath}
          onClick={() => setPrompt({ mode: 'rename', value: openFilePath ?? '' })}
        >
          Rename
        </button>
        <button className={btnClass} disabled={!openFilePath} onClick={() => void handleDelete()}>
          Delete
        </button>
      </div>

      {prompt && (
        <div className="border-b border-edge bg-raised p-2">
          <label className="text-xs text-muted">
            {prompt.mode === 'new'
              ? 'New file path (relative to project root)'
              : 'New path for this file'}
          </label>
          <input
            autoFocus
            type="text"
            value={prompt.value}
            onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitPrompt()
              if (e.key === 'Escape') setPrompt(null)
            }}
            placeholder="src/components/Button.tsx"
            className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
          <div className="mt-1.5 flex justify-end gap-1">
            <button
              className="rounded border border-edge px-2 py-0.5 text-xs hover:bg-surface"
              onClick={() => setPrompt(null)}
            >
              Cancel
            </button>
            <button
              className="rounded bg-accent px-2 py-0.5 text-xs text-accent-ink hover:opacity-90 disabled:opacity-40"
              disabled={!prompt.value.trim()}
              onClick={() => void submitPrompt()}
            >
              {prompt.mode === 'new' ? 'Create' : 'Rename'}
            </button>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto py-1">
        {fileTree.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted">No files yet.</p>
        ) : (
          fileTree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              openFilePath={openFilePath}
              onOpenFile={(p) => void openFile(p)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface TreeRowProps {
  node: FileNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  openFilePath: string | null
  onOpenFile: (path: string) => void
}

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  openFilePath,
  onOpenFile
}: TreeRowProps): JSX.Element {
  const isOpen = expanded.has(node.path)
  const isActive = !node.isDirectory && node.path === openFilePath
  const indent = { paddingLeft: `${depth * 14 + 8}px` }

  return (
    <div>
      <button
        style={indent}
        className={`flex w-full items-center gap-1 py-1 pr-2 text-left text-sm text-ink hover:bg-raised ${
          isActive ? 'bg-accent/20' : ''
        }`}
        onClick={() => (node.isDirectory ? toggle(node.path) : onOpenFile(node.path))}
      >
        <span className="w-3 shrink-0 text-xs text-muted">
          {node.isDirectory ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <span className="shrink-0">{node.isDirectory ? '📁' : '📄'}</span>
        <span className="truncate">{node.name}</span>
      </button>
      {node.isDirectory && isOpen && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              openFilePath={openFilePath}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}

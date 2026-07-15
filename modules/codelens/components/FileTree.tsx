import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileCog,
  FileText,
  Folder,
  FolderOpen
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ScanResult, TreeNode } from '../shared/types'
import { LANG_META, SEVERITY_META } from '../utils/lang'

interface Props {
  scan: ScanResult
  selected: string | null
  onSelect(relPath: string): void
}

function FileIcon({ node }: { node: TreeNode }) {
  const lang = node.language ?? 'other'
  const color = LANG_META[lang].color
  if (lang === 'config') return <FileCog size={14} style={{ color }} />
  if (lang === 'markdown' || lang === 'other') return <FileText size={14} style={{ color }} />
  return <FileCode2 size={14} style={{ color }} />
}

function IssueBadge({ node }: { node: TreeNode }) {
  if (node.issueCount === 0) return null
  const meta = SEVERITY_META[node.maxSeverity ?? 'low']
  return (
    <span
      className="ml-auto shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4"
      style={{ background: meta.bg, color: meta.color }}
      title={`${node.issueCount} potential issue${node.issueCount > 1 ? 's' : ''} (worst: ${meta.label})`}
    >
      {node.issueCount}
    </span>
  )
}

function Row({
  node,
  depth,
  selected,
  expanded,
  onSelect,
  onToggle
}: {
  node: TreeNode
  depth: number
  selected: string | null
  expanded: Set<string>
  onSelect(relPath: string): void
  onToggle(relPath: string): void
}) {
  const pad = { paddingLeft: `${8 + depth * 14}px` }

  if (node.type === 'dir') {
    const open = expanded.has(node.relPath)
    return (
      <>
        <div
          className="flex cursor-pointer select-none items-center gap-1.5 py-[3px] pr-2 text-[13px] text-ink hover:bg-raised"
          style={pad}
          onClick={() => onToggle(node.relPath)}
        >
          {open ? (
            <ChevronDown size={13} className="shrink-0 text-muted" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-muted" />
          )}
          {open ? (
            <FolderOpen size={14} className="shrink-0 text-warn/80" />
          ) : (
            <Folder size={14} className="shrink-0 text-warn/80" />
          )}
          <span className="truncate">{node.name}</span>
          <IssueBadge node={node} />
        </div>
        {open &&
          node.children?.map((child) => (
            <Row
              key={child.relPath}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
      </>
    )
  }

  const isSelected = selected === node.relPath
  return (
    <div
      className={`flex cursor-pointer select-none items-center gap-1.5 py-[3px] pr-2 text-[13px] ${
        isSelected
          ? 'bg-accent/15 text-ink shadow-[inset_2px_0_0_0_rgb(var(--wk-accent))]'
          : 'text-ink/80 hover:bg-raised'
      }`}
      style={pad}
      onClick={() => onSelect(node.relPath)}
    >
      <span className="w-[13px] shrink-0" />
      <FileIcon node={node} />
      <span className="truncate">{node.name}</span>
      <IssueBadge node={node} />
    </div>
  )
}

export function FileTree({ scan, selected, onSelect }: Props) {
  // Expand the first two directory levels by default.
  const initialExpanded = useMemo(() => {
    const set = new Set<string>()
    for (const child of scan.tree.children ?? []) {
      if (child.type === 'dir') {
        set.add(child.relPath)
        for (const grand of child.children ?? []) {
          if (grand.type === 'dir') set.add(grand.relPath)
        }
      }
    }
    return set
  }, [scan])

  const [expanded, setExpanded] = useState(initialExpanded)
  useEffect(() => setExpanded(initialExpanded), [initialExpanded])

  // When the selection comes from the graph, reveal the file in the tree.
  useEffect(() => {
    if (!selected) return
    setExpanded((prev) => {
      const next = new Set(prev)
      const parts = selected.split('/')
      let acc = ''
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i]
        next.add(acc)
      }
      return next
    })
  }, [selected])

  const toggle = (relPath: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })

  return (
    <div className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-edge px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Files
        </span>
        <span className="text-[11px] text-muted/70">{scan.fileCount}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {scan.tree.children?.map((child) => (
          <Row
            key={child.relPath}
            node={child}
            depth={0}
            selected={selected}
            expanded={expanded}
            onSelect={onSelect}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  )
}

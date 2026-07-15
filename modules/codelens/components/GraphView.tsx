import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow
} from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo } from 'react'
import type { ScanResult, Severity } from '../shared/types'
import { complexityColor, LANG_META, SEVERITY_META } from '../utils/lang'
import { layoutGraph, NODE_H, NODE_W } from '../utils/layout'

export type ColorMode = 'type' | 'complexity' | 'issues'

const MAX_NODES = 600

// WICKED theme tokens — resolved by CSS at paint time, so the graph follows
// light/dark theme switches (React Flow applies these via inline styles).
const ACCENT = 'rgb(var(--wk-accent))'
const EDGE_IDLE = 'rgb(var(--wk-edge))'
const CLEAN_NODE = '#64748b'

interface FileNodeData extends Record<string, unknown> {
  label: string
  dir: string
  color: string
  issueCount: number
  maxSeverity?: Severity
}

function FileNode({ data, selected }: NodeProps) {
  const d = data as FileNodeData
  return (
    <div
      className={`flex h-full w-full items-center gap-2 rounded-lg border bg-surface px-2.5 shadow-md transition-shadow ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-edge'
      }`}
      style={{ borderLeftColor: d.color, borderLeftWidth: 3 }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.color }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-ink">{d.label}</div>
        <div className="truncate text-[10px] text-muted">{d.dir || '.'}</div>
      </div>
      {d.issueCount > 0 && (
        <span
          className="shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-4"
          style={{
            background: SEVERITY_META[d.maxSeverity ?? 'low'].bg,
            color: SEVERITY_META[d.maxSeverity ?? 'low'].color
          }}
        >
          {d.issueCount}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { file: FileNode }

interface Props {
  scan: ScanResult
  selected: string | null
  colorMode: ColorMode
  hideIsolated: boolean
  onSelect(relPath: string | null): void
  onColorMode(mode: ColorMode): void
  onHideIsolated(hide: boolean): void
}

function GraphInner({
  scan,
  selected,
  colorMode,
  hideIsolated,
  onSelect,
  onColorMode,
  onHideIsolated
}: Props) {
  const issueInfo = useMemo(() => {
    const map = new Map<string, { count: number; max: Severity }>()
    for (const issue of scan.issues) {
      const cur = map.get(issue.file)
      if (!cur) {
        map.set(issue.file, { count: 1, max: issue.severity })
      } else {
        cur.count++
        const rank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }
        if (rank[issue.severity] > rank[cur.max]) cur.max = issue.severity
      }
    }
    return map
  }, [scan])

  // Visible node set + layout: independent of color mode and selection.
  const { visibleFiles, positions, visibleEdges, hiddenCount } = useMemo(() => {
    const degree = new Map<string, number>()
    for (const e of scan.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
    }
    let files = scan.files
    if (hideIsolated) files = files.filter((f) => (degree.get(f.relPath) ?? 0) > 0)
    let hidden = scan.files.length - files.length
    if (files.length > MAX_NODES) {
      files = files
        .slice()
        .sort((a, b) => (degree.get(b.relPath) ?? 0) - (degree.get(a.relPath) ?? 0))
        .slice(0, MAX_NODES)
      hidden = scan.files.length - files.length
    }
    const idSet = new Set(files.map((f) => f.relPath))
    const edges = scan.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target))
    const positions = layoutGraph(
      files.map((f) => f.relPath),
      edges
    )
    return { visibleFiles: files, positions, visibleEdges: edges, hiddenCount: hidden }
  }, [scan, hideIsolated])

  // Node/edge decoration: cheap, recomputed on selection or color change.
  const nodes: Node[] = useMemo(
    () =>
      visibleFiles.map((f) => {
        const issues = issueInfo.get(f.relPath)
        let color = LANG_META[f.language].color
        if (colorMode === 'complexity') color = complexityColor(f.complexity)
        if (colorMode === 'issues') {
          color = issues ? SEVERITY_META[issues.max].text : CLEAN_NODE
        }
        return {
          id: f.relPath,
          type: 'file',
          position: positions.get(f.relPath) ?? { x: 0, y: 0 },
          width: NODE_W,
          height: NODE_H,
          selected: selected === f.relPath,
          data: {
            label: f.name,
            dir: f.dir,
            color,
            issueCount: issues?.count ?? 0,
            maxSeverity: issues?.max
          } satisfies FileNodeData
        }
      }),
    [visibleFiles, positions, colorMode, selected, issueInfo]
  )

  const edges: Edge[] = useMemo(
    () =>
      visibleEdges.map((e) => {
        const touched = selected !== null && (e.source === selected || e.target === selected)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          animated: touched,
          style: {
            stroke: touched ? ACCENT : EDGE_IDLE,
            strokeWidth: touched ? 1.8 : 1.1
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 13,
            height: 13,
            color: touched ? ACCENT : EDGE_IDLE
          }
        }
      }),
    [visibleEdges, selected]
  )

  const rf = useReactFlow()
  useEffect(() => {
    if (selected && positions.has(selected)) {
      void rf.fitView({ nodes: [{ id: selected }], duration: 350, maxZoom: 1.15, padding: 2 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const select = 'rounded border border-edge bg-raised px-1.5 py-1 text-[11px] text-ink'

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      fitView
      minZoom={0.05}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={false}
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color={EDGE_IDLE} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => ((n.data as FileNodeData).color ?? CLEAN_NODE) as string}
        maskColor="rgb(var(--wk-bg) / 0.75)"
        style={{ background: 'rgb(var(--wk-surface))' }}
      />
      <Panel position="top-left">
        <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface/90 px-2.5 py-1.5">
          <label className="text-[11px] text-muted">Color by</label>
          <select
            className={select}
            value={colorMode}
            onChange={(e) => onColorMode(e.target.value as ColorMode)}
          >
            <option value="type">File type</option>
            <option value="complexity">Complexity</option>
            <option value="issues">Vulnerabilities</option>
          </select>
          <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={hideIsolated}
              onChange={(e) => onHideIsolated(e.target.checked)}
              className="accent-accent"
            />
            Hide unconnected
          </label>
          {hiddenCount > 0 && (
            <span className="text-[11px] text-muted/70">({hiddenCount} hidden)</span>
          )}
        </div>
      </Panel>
      <Panel position="bottom-left">
        <Legend scan={scan} colorMode={colorMode} />
      </Panel>
    </ReactFlow>
  )
}

function Legend({ scan, colorMode }: { scan: ScanResult; colorMode: ColorMode }) {
  let entries: { label: string; color: string }[] = []
  if (colorMode === 'type') {
    const present = new Set(scan.files.map((f) => f.language))
    entries = [...present].map((l) => ({ label: LANG_META[l].label, color: LANG_META[l].color }))
  } else if (colorMode === 'complexity') {
    entries = [
      { label: 'Simple', color: complexityColor(2) },
      { label: 'Moderate', color: complexityColor(5) },
      { label: 'Busy', color: complexityColor(7) },
      { label: 'Gnarly', color: complexityColor(9) }
    ]
  } else {
    entries = [
      { label: 'Clean', color: CLEAN_NODE },
      ...(['low', 'medium', 'high', 'critical'] as const).map((s) => ({
        label: SEVERITY_META[s].label,
        color: SEVERITY_META[s].text
      }))
    ]
  }
  return (
    <div className="flex max-w-md flex-wrap gap-x-3 gap-y-1 rounded-lg border border-edge bg-surface/90 px-2.5 py-1.5">
      {entries.map((e) => (
        <span key={e.label} className="flex items-center gap-1.5 text-[10px] text-ink/80">
          <span className="h-2 w-2 rounded-full" style={{ background: e.color }} />
          {e.label}
        </span>
      ))}
    </div>
  )
}

export function GraphView(props: Props) {
  return (
    <div className="relative min-w-0 flex-1 bg-bg">
      <ReactFlowProvider>
        <GraphInner {...props} />
      </ReactFlowProvider>
    </div>
  )
}

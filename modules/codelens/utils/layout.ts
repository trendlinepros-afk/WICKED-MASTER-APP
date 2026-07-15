import dagre from '@dagrejs/dagre'
import type { GraphEdge } from '../shared/types'

export const NODE_W = 190
export const NODE_H = 52

export interface Point {
  x: number
  y: number
}

/** Hierarchical left-to-right layout for the dependency graph. */
export function layoutGraph(nodeIds: string[], edges: GraphEdge[]): Map<string, Point> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 110, edgesep: 14, marginx: 40, marginy: 40 })
  g.setDefaultEdgeLabel(() => ({}))

  const idSet = new Set(nodeIds)
  for (const id of nodeIds) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const e of edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  const positions = new Map<string, Point>()
  for (const id of nodeIds) {
    const n = g.node(id)
    positions.set(id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 })
  }
  return positions
}

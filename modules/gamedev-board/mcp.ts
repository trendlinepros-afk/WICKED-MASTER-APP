import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * GAMEDEV BOARD is a renderer-only module: its data (boards, cards, time logs)
 * lives entirely in the renderer's IndexedDB (see db.ts) and there is no ipc.ts /
 * no main-process channel to delegate to. There is therefore nothing to expose to
 * MCP — this file exists only to satisfy the module contract (mcp.ts is required
 * even when the tool list is empty, so the decision to expose nothing is explicit
 * rather than forgotten).
 */
export default function register(_ctx: McpModuleContext): McpToolDef[] {
  return []
}

import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * SECRET KEY GENERATOR is a renderer-only module: all key/password generation
 * runs in the renderer using the Web Crypto API, and there is no ipc.ts / no
 * main-process channel to delegate to. There is therefore nothing to expose to
 * MCP — this file exists only to satisfy the module contract (mcp.ts is required
 * even when the tool list is empty, so the decision to expose nothing is explicit
 * rather than forgotten). Exposing generation over MCP would also mean returning
 * freshly generated secrets across the MCP boundary, which we deliberately avoid.
 */
export default function register(_ctx: McpModuleContext): McpToolDef[] {
  return []
}

import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for ADVANCED CHARTS. The tool is a visual charting workspace; the
 * only agent-useful action is checking its setup state. Market data itself is
 * exposed by stock-planner's read-only tools.
 */
const ID = 'advanced-charts'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report the Advanced Charts setup state: whether the licensed TradingView charting_library folder is configured (and where), whether a Massive key is present for the datafeed, and the local chart-host URL when running. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    }
  ]
}

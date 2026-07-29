import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for ADVANCED CHARTS. The tool is a visual candlestick workspace
 * (Lightweight Charts) fed by Massive data; the only agent-useful action is
 * checking its setup state. Market data itself is exposed by stock-planner's
 * read-only tools.
 */
const ID = 'advanced-charts'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report Advanced Charts setup state: whether a Massive key is present (charts render when it is). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    }
  ]
}

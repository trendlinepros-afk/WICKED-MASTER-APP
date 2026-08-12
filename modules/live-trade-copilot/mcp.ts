import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP for the LIVE TRADE COPILOT. Only a read-only status probe is exposed —
 * the analysis loop consumes vault AI keys continuously and stays OFF MCP per
 * the module contract convention.
 */
const ID = 'live-trade-copilot'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Read-only: whether a Live Trade Copilot session is running, which ticker it is watching, how many checks it has made, and the last BUY/SELL/HOLD/WAIT verdict with patterns and levels. Cannot start sessions or consume AI tokens.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    }
  ]
}

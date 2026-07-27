import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/** MCP tools for MARKET NEWS — read-only headlines. */
const ID = 'market-news'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__headlines`,
      description:
        'Market-wide news headlines (Finnhub general category, cached until the 6 AM ET rollover), or per-ticker company news for the last 30 days when `symbol` is given. Read-only.',
      inputSchema: {
        symbol: z.string().optional().describe('Optional ticker to get company news instead of market-wide.')
      },
      handler: (args) => ctx.invoke(`${ID}:news`, args.symbol ?? '')
    }
  ]
}

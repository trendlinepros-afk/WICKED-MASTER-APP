import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRADE REVIEW. The session lives in the renderer (nothing is
 * persisted — ported behavior), so the useful agent surface is the candle
 * endpoint. AI review/chat consume vault AI keys and stay off MCP per the
 * module contract; execution data itself is available via the Trade Journal's
 * trade-analytics__list-executions.
 */
const ID = 'trade-review'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__candles`,
      description:
        'Single-day 1-minute candles for a symbol (the execution-chart data). Read-only; requires the Massive key.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol, e.g. JBLU.'),
        ymd: z.string().describe('Session date, YYYY-MM-DD (ET).')
      },
      handler: (args) => ctx.invoke(`${ID}:candles`, { symbol: args.symbol, ymd: args.ymd })
    }
  ]
}

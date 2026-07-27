import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for FIND TRADES. Only the DETERMINISTIC screen is exposed — it
 * takes explicit numeric criteria and returns matching tickers from the live
 * market snapshot. The AI chat agent (which consumes vault AI keys) stays OFF
 * MCP per the module contract; an agent can compose its own criteria and call
 * this read-only screen directly.
 */
const ID = 'find-trades'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__screen`,
      description:
        'Screen the live US market for stocks matching explicit numeric criteria (price, % change, volume, market cap, sector). Read-only; requires the Massive key. Percentages are whole numbers; market caps are in dollars.',
      inputSchema: {
        source: z
          .enum(['movers', 'premarket', 'afterhours', 'ipos', 'tickers'])
          .optional()
          .describe('Universe: movers = full market snapshot (default), premarket/afterhours = session movers, ipos, or explicit tickers.'),
        tickers: z.array(z.string()).optional().describe('Explicit symbols when source = "tickers".'),
        direction: z.enum(['up', 'down', 'any']).optional().describe('Keep only up movers, down movers, or any.'),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        minChangePct: z.number().optional().describe('Minimum % change today (e.g. 5 for +5%).'),
        maxChangePct: z.number().optional(),
        minVolume: z.number().optional(),
        maxVolume: z.number().optional(),
        minMarketCap: z.number().optional().describe('In dollars (e.g. 10000000000 for $10B).'),
        maxMarketCap: z.number().optional(),
        sectors: z.array(z.string()).optional().describe('Broad sectors to keep, e.g. ["Technology","Healthcare"].'),
        needsNews: z.boolean().optional().describe('Require recent company news.'),
        keywords: z.array(z.string()).optional().describe('Name/news keywords to match, e.g. ["FDA","earnings"].'),
        limit: z.number().int().optional().describe('Max results (default 12, cap 30).')
      },
      handler: (args) => ctx.invoke(`${ID}:screen`, args)
    }
  ]
}

import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for the OPTIONS ASSISTANT. Read-only market lookups and watchlist
 * edits are exposed; the AI scan/chat (which consumes vault AI keys) stays OFF
 * MCP per the module contract — an agent can pull the chain itself and reason
 * over it.
 */
const ID = 'options-assistant'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Options Assistant status: whether Webull OpenAPI credentials, AI keys and market-data keys are configured, plus the current watchlist. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__watchlist`,
      description: 'The Options Assistant watchlist (the tickers scanned for option plays). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:watchlist-get`)
    },
    {
      name: `${ID}__watchlist-add`,
      description: 'Add a ticker to the Options Assistant watchlist (capped at 50).',
      inputSchema: { symbol: z.string().describe('Ticker symbol, e.g. AAPL.') },
      handler: (args) => ctx.invoke(`${ID}:watchlist-add`, { symbol: args.symbol })
    },
    {
      name: `${ID}__watchlist-remove`,
      description: 'Remove a ticker from the Options Assistant watchlist.',
      inputSchema: { symbol: z.string().describe('Ticker symbol to remove.') },
      handler: (args) => ctx.invoke(`${ID}:watchlist-remove`, { symbol: args.symbol })
    },
    {
      name: `${ID}__chain`,
      description:
        'Near-the-money option contracts for one ticker within an expiration window, via the Webull OpenAPI (needs the Webull App Key/Secret in the vault). direction up = calls, down = puts. Horizons: 0d | 1d | 2d | 3d | 5d | 10d | 21d (market days). Read-only.',
      inputSchema: {
        symbol: z.string().describe('Underlying ticker, e.g. AAPL.'),
        direction: z.enum(['up', 'down']).optional().describe('up = CALL chain (default), down = PUT chain.'),
        horizon: z.enum(['0d', '1d', '2d', '3d', '5d', '10d', '21d']).optional().describe('Expiration window (default 2d).')
      },
      handler: (args) => ctx.invoke(`${ID}:chain`, args)
    },
    {
      name: `${ID}__history`,
      description: 'Past Options Assistant scans (direction, horizon, summary and the picked contract). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:history`)
    }
  ]
}

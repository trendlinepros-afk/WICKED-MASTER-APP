import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for PAPER TRADING — read-only. Placing/closing trades is a
 * deliberate human action, so those stay off MCP; agents can read the accounts,
 * positions, closed trades and live quotes.
 */
const ID = 'paper-trading'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__accounts`,
      description: 'List paper-trading accounts with cash, starting balance, open positions and closed trades. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:get`)
    },
    {
      name: `${ID}__quotes`,
      description: 'Live last prices for tickers from Polygon/Massive. Read-only.',
      inputSchema: { symbols: z.array(z.string()).describe('Tickers, e.g. ["AAPL","NVDA"].') },
      handler: (args) => ctx.invoke(`${ID}:quotes`, args.symbols)
    }
  ]
}

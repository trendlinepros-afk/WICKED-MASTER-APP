import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRADE NOW — a position tracker. A position has a ledger of
 * buy/sell legs and stays "in trade" until sold out. Everything delegates to
 * the same IPC channels the UI uses. Deleting a position is the only fully
 * destructive operation.
 */
const ID = 'trade-now'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list`,
      description:
        'List all Trade Now positions (newest first): id, symbol, company name, 52-week high/low, notes, the full buy/sell leg ledger, and a computed summary (open shares, average buy price, total bought/sold, realized P/L, and status open|closed). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list`)
    },
    {
      name: `${ID}__snapshot`,
      description:
        'Open a Trade Now position for a ticker RIGHT NOW: captures company name and 52-week high/low, and records the first BUY leg. Pass the quantity of shares; optionally a buyPrice (defaults to the current 15-min-delayed market price) and reason/prediction notes. Uses the Massive/Polygon key.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol that was just bought (e.g. JBLU).'),
        quantity: z.number().optional().describe('Shares bought (the first buy leg).'),
        buyPrice: z.number().optional().describe('Price paid per share; omit to use the current market price.'),
        reason: z.string().optional().describe('Why the stock was bought.'),
        prediction: z.string().optional().describe('The prediction for this position.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:create`, {
          symbol: args.symbol,
          quantity: args.quantity,
          buyPrice: args.buyPrice,
          reason: args.reason,
          prediction: args.prediction
        })
    },
    {
      name: `${ID}__add-leg`,
      description:
        'Add a BUY (average down / add) or SELL (scale out / close) order to an existing position. Selling shares equal to the shares held closes the trade (status → closed). Find the position id via list.',
      inputSchema: {
        id: z.string().describe('Position id from trade-now__list.'),
        side: z.enum(['buy', 'sell']).describe('buy = add shares, sell = reduce/close.'),
        price: z.number().describe('Price per share for this order.'),
        quantity: z.number().describe('Number of shares.'),
        at: z.number().optional().describe('When it happened (ms epoch). Defaults to now.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:add-leg`, {
          id: args.id,
          side: args.side,
          price: args.price,
          quantity: args.quantity,
          at: args.at
        })
    },
    {
      name: `${ID}__update-notes`,
      description: 'Update the reason and/or prediction notes on a position (find ids via list).',
      inputSchema: {
        id: z.string().describe('Position id from trade-now__list.'),
        reason: z.string().optional().describe('New "why I bought" text.'),
        prediction: z.string().optional().describe('New prediction text.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:update-notes`, { id: args.id, reason: args.reason, prediction: args.prediction })
    },
    {
      name: `${ID}__delete`,
      description:
        'Delete a position permanently. DESTRUCTIVE: its ledger and notes are gone for good, so it requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Position id from trade-now__list.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Permanently delete this position (its buy/sell ledger and notes cannot be recovered).'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:delete`, { id: args.id })
      }
    }
  ]
}

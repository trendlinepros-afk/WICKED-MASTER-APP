import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRADE NOW. Everything delegates to the same IPC channels the
 * UI uses. Snapshots are frozen buy-moment records; deleting one is the only
 * destructive operation.
 */
const ID = 'trade-now'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list`,
      description:
        'List all buy-moment snapshots (newest first): id, symbol, company name, when it was bought, price at buy, 52-week high/low, and the reason/prediction notes. Chart bars are omitted. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list`)
    },
    {
      name: `${ID}__snapshot`,
      description:
        'Take a buy-moment snapshot of a ticker RIGHT NOW: freezes the current (15-min-delayed) price, 52-week high/low, company name and ~90 days of 4h chart bars, and stores it permanently in the Trade Now journal. Optionally attach the "why I bought" reason and a prediction. Uses the Massive/Polygon key.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol that was just bought (e.g. JBLU).'),
        reason: z.string().optional().describe('Why the stock was bought.'),
        prediction: z.string().optional().describe('The prediction for this position.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:create`, { symbol: args.symbol, reason: args.reason, prediction: args.prediction })
    },
    {
      name: `${ID}__update-notes`,
      description: 'Update the reason and/or prediction notes on an existing snapshot (find ids via list).',
      inputSchema: {
        id: z.string().describe('Snapshot id from trade-now__list.'),
        reason: z.string().optional().describe('New "why I bought" text.'),
        prediction: z.string().optional().describe('New prediction text.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:update-notes`, { id: args.id, reason: args.reason, prediction: args.prediction })
    },
    {
      name: `${ID}__delete`,
      description:
        'Delete a buy-moment snapshot permanently. DESTRUCTIVE: the frozen chart and notes for that buy are gone for good, so it requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Snapshot id from trade-now__list.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Permanently delete this buy snapshot (its frozen chart and notes cannot be recovered).'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:delete`, { id: args.id })
      }
    }
  ]
}

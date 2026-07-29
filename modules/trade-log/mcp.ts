import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRADE LOG — read and write the hand-written trade journal.
 * Every tool delegates to the same `trade-log:*` IPC channel the UI uses.
 * Deleting an entry is irreversible, so it gates on ctx.confirm.
 */
const ID = 'trade-log'

const FIELDS = {
  symbol: z.string().optional().describe('Ticker traded, e.g. NVDA.'),
  buyAt: z.string().optional().describe('Datetime bought, "YYYY-MM-DDTHH:mm" (local).'),
  shares: z.number().optional().describe('Shares bought.'),
  buyPrice: z.number().optional().describe('Price per share you bought at.'),
  entryNote: z.string().optional().describe('Why you bought.'),
  sellAt: z.string().optional().describe('Datetime sold, "YYYY-MM-DDTHH:mm" (blank if still open).'),
  sellPrice: z.number().optional().describe('Price per share you sold at (blank if still open).'),
  exitNote: z.string().optional().describe('Why you left the trade.'),
  finalReview: z.string().optional().describe('Your final thoughts on the trade.')
}

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list`,
      description: 'List every trade journal entry (newest first), with entry/exit details and notes.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list`)
    },
    {
      name: `${ID}__create`,
      description: 'Create a new trade journal entry. Record the entry side now; fill in the exit + final review later via update.',
      inputSchema: FIELDS,
      handler: (args) => ctx.invoke(`${ID}:create`, args)
    },
    {
      name: `${ID}__update`,
      description: 'Update an existing journal entry — e.g. add the sold price, exit reason, or final review.',
      inputSchema: { id: z.string().describe('Entry id (from trade-log__list).'), ...FIELDS },
      handler: (args) => {
        const { id, ...patch } = args
        return ctx.invoke(`${ID}:update`, id, patch)
      }
    },
    {
      name: `${ID}__remove`,
      description: 'Permanently delete a journal entry. Irreversible.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Entry id to delete.'),
        confirm: z.boolean().optional().describe('Must be true to actually delete.')
      },
      handler: (args, c) => {
        const withhold = c.confirm(args.confirm as boolean | undefined, `Permanently delete trade journal entry ${args.id}`)
        if (withhold) return withhold
        return c.invoke(`${ID}:remove`, args.id)
      }
    }
  ]
}

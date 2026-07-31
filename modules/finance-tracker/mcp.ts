import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for FINANCE TRACKER. Read tools return the computed views (spending
 * by category, subscriptions, transactions); import delegates to the same IPC
 * channel the UI uses (additive + de-duplicated). Clear is destructive and
 * confirm-gated. Editing (rename/category/sub flags) stays a manual action.
 */
const ID = 'finance-tracker'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__accounts`,
      description: 'List credit-card accounts with their transaction counts. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:bootstrap`)
    },
    {
      name: `${ID}__spending`,
      description:
        'Spending by category (net dollars + transaction counts), excluding card payments. Optionally scope to one month. Read-only.',
      inputSchema: { month: z.string().optional().describe('Month as YYYY-MM (e.g. "2026-07"). Omit for all time.') },
      handler: (args) => ctx.invoke(`${ID}:spending`, args.month)
    },
    {
      name: `${ID}__subscriptions`,
      description:
        'Detected subscriptions grouped by merchant: charge count, last charge, cadence and estimated monthly cost, plus the total per month. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:subscriptions`)
    },
    {
      name: `${ID}__transactions`,
      description: 'Raw imported transactions (date, name, category, amount, subscription flag), newest first. Optionally scope to one account id. Read-only.',
      inputSchema: { account: z.string().optional().describe('Account id to scope to. Omit for all accounts.') },
      handler: (args) => ctx.invoke(`${ID}:transactions`, args.account)
    },
    {
      name: `${ID}__import`,
      description:
        'Import one or more credit-card statement CSV files by absolute path into an account (id or name; defaults to the first). Additive and de-duplicated — re-importing overlapping statements never double-counts. Learned merchant rules are applied automatically.',
      inputSchema: {
        paths: z.array(z.string()).describe('Absolute path(s) to statement .csv file(s).'),
        account: z.string().optional().describe('Account id or name to import into.')
      },
      handler: (args) => ctx.invoke(`${ID}:import-file`, args.paths, args.account)
    },
    {
      name: `${ID}__clear`,
      description:
        'Delete imported transactions (one account, or ALL). Destructive — learned merchant rules and accounts are kept; statements can be re-imported. Requires confirmation.',
      destructive: true,
      inputSchema: {
        account: z.string().optional().describe('Account id to clear. Omit to clear every account.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Delete imported statement transactions from the Finance Tracker database. Accounts and learned merchant rules are kept; you can re-import your CSVs anytime.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:clear`, args.account)
      }
    }
  ]
}

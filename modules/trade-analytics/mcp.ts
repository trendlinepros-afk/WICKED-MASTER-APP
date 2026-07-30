import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRADE ANALYTICS. Read tools return the stored executions so an
 * agent can compute/inspect trades; import and clear delegate to the same IPC
 * channels the UI uses. AI coaching is done in the module UI (it consumes vault
 * keys); the MCP surface stays data-only so no vault secret is auto-used here.
 */
const ID = 'trade-analytics'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__accounts`,
      description:
        'List the trading accounts (id, name, execution count). Use an account id OR name to scope the summary / trades / list-executions tools. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:accounts-list`)
    },
    {
      name: `${ID}__summary`,
      description:
        'PRECISE account P&L and stats, computed exactly like the app UI (FIFO round-trips per symbol, accounts kept fully separate). Returns realized P&L, closed/open trade counts, win rate, profit factor, expectancy, gross/avg win & loss, largest win/loss, best/worst symbol, per-symbol P&L, and current open positions with cost basis. This is the correct tool for "how much did I make / how am I doing" — do NOT sum raw executions yourself. Optionally scope with `account` (id or name); omit to get every account reported independently plus a combined view. Read-only.',
      inputSchema: {
        account: z
          .string()
          .optional()
          .describe('Account id or name to scope to, e.g. "Webull - TrendLine Trading". Omit for all accounts + combined.')
      },
      handler: (args) => ctx.invoke(`${ID}:summary`, args.account)
    },
    {
      name: `${ID}__trades`,
      description:
        'The matched round-trip trades and open positions, computed FIFO per symbol per account — each with direction, quantity, average entry & exit price, realized P&L, % return, entry/exit timestamps, hold time and status (closed/open). Use this to inspect or list individual trades. Read-only.',
      inputSchema: {
        account: z.string().optional().describe('Account id or name to scope to. Omit for all accounts (kept FIFO-separate).'),
        status: z.enum(['all', 'open', 'closed']).optional().describe('Filter by trade status (default all).'),
        limit: z.number().optional().describe('Max trades to return, newest first (default 100, max 500).')
      },
      handler: (args) => ctx.invoke(`${ID}:trades`, args)
    },
    {
      name: `${ID}__list-executions`,
      description:
        'Raw imported executions — the low-level audit trail (symbol, side, qty, price, status, filled/placed times, de-dup hash). Large and unaggregated: for P&L or trade lists use trade-analytics__summary or trade-analytics__trades instead, which match the app exactly. Optionally scope with `account` (id or name). Read-only.',
      inputSchema: {
        account: z.string().optional().describe('Account id or name to scope to. Omit for all executions.')
      },
      handler: (args) => ctx.invoke(`${ID}:executions`, args.account)
    },
    {
      name: `${ID}__import`,
      description:
        'Import one or more Webull "Orders Records" CSV files by absolute path. Additive and de-duplicated: rows already present (same order fingerprint) are skipped, so re-importing overlapping reports never double-counts. Returns per-file counts and the full execution set.',
      inputSchema: {
        paths: z
          .array(z.string())
          .describe('Absolute path(s) to Webull order-records .csv file(s) to import.')
      },
      handler: (args) => ctx.invoke(`${ID}:import-file`, args.paths)
    },
    {
      name: `${ID}__clear`,
      description:
        'Delete ALL imported executions from the analytics database. Destructive (the imported history is removed — the Webull account is untouched and CSVs can be re-imported). Requires confirmation.',
      destructive: true,
      inputSchema: { confirm: z.boolean().optional() },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Delete all imported trade executions from the Trade Journal database. This clears the local analytics only (your Webull account and CSV files are untouched); you can re-import anytime.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:clear`)
      }
    }
  ]
}

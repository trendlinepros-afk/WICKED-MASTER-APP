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
      name: `${ID}__list-executions`,
      description:
        'Return every imported Webull execution (symbol, side, qty, price, status, filled/placed times, de-dup hash). Read-only. Round-trip trades and open positions can be derived from these (buy = +qty, sell/short = −qty, FIFO per symbol; a symbol left net non-zero is an open position).',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:executions`)
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
          'Delete all imported trade executions from the Trade Analytics database. This clears the local analytics only (your Webull account and CSV files are untouched); you can re-import anytime.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:clear`)
      }
    }
  ]
}

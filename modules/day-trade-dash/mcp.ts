import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'
import type { DashState } from './types'

/**
 * MCP tools for DAY TRADE DASH. Each tool delegates to the SAME main-process
 * channels the module UI calls (see ipc.ts) — no logic is duplicated here.
 * Everything is either read-only market data or a watchlist edit; nothing
 * consumes AI tokens or credentials.
 */
const ID = 'day-trade-dash'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__overview`,
      description:
        'The dashboard at a glance: the three chart slots (ticker + timeframe), watchlist (each entry carries ' +
        'addedAt/addedPrice — the anchor for its "% since added" metric), tape symbols, and live quotes ' +
        '(price + day %) for all of them, plus the current market session. Read-only.',
      inputSchema: {},
      handler: async () => {
        const st = (await ctx.invoke(`${ID}:state-get`)) as { state: DashState }
        const syms = [
          ...new Set(
            [...st.state.tape, ...st.state.watch.map((w) => w.symbol), ...st.state.charts.map((c) => c.symbol)].filter(Boolean)
          )
        ]
        const [quotes, session] = await Promise.all([
          ctx.invoke(`${ID}:quotes`, { symbols: syms }),
          ctx.invoke(`${ID}:session`)
        ])
        return { state: st.state, quotes, session }
      }
    },
    {
      name: `${ID}__news`,
      description: 'Latest market-wide day-trading headlines (title, source, age, related tickers). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:news`, { limit: 30 })
    },
    {
      name: `${ID}__watch-add`,
      description: 'Add a ticker to the Day Trade Dash watchlist.',
      inputSchema: { symbol: z.string().describe('Ticker symbol, e.g. NVDA.') },
      handler: (args) => ctx.invoke(`${ID}:watch-add`, { symbol: args.symbol })
    },
    {
      name: `${ID}__watch-remove`,
      description: 'Remove a ticker from the Day Trade Dash watchlist.',
      inputSchema: { symbol: z.string().describe('Ticker symbol to remove.') },
      handler: (args) => ctx.invoke(`${ID}:watch-remove`, { symbol: args.symbol })
    }
  ]
}

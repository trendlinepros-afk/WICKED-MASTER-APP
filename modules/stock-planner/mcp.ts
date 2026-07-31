import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for STOCK PLANNER — the read-only market-data surface. The AI
 * report/chat channels consume shell-vault AI keys with no caller-credential
 * path, so per the module contract they are NOT exposed here (same policy as
 * ai-chat). Agents can read quotes, screeners, IPOs and saved docs.
 */
const ID = 'stock-planner'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__search`,
      description: 'Search US stocks by ticker or company name (Massive reference data). Read-only.',
      inputSchema: { q: z.string().describe('Ticker or company-name fragment.') },
      handler: (args) => ctx.invoke(`${ID}:search`, args.q)
    },
    {
      name: `${ID}__ticker-data`,
      description:
        'Full research snapshot for one ticker: resolved quote (0/negative prices treated as missing), company details, market cap, trailing P/E (a real NEGATIVE value on a net loss; null only when income data is missing), annual revenue/net income, next-earnings date with confirmed/estimated flag ({date,isEstimate,source} or null — never guessed), and recent headlines. Read-only.',
      inputSchema: { symbol: z.string().describe('Ticker symbol, e.g. JBLU.') },
      handler: (args) => ctx.invoke(`${ID}:ticker-data`, args.symbol)
    },
    {
      name: `${ID}__screener`,
      description:
        'Run a gainers screener: kind=premarket (4:00–9:30 ET only), afterhours (after the close), daily, or period with days=7|30|182|365. Session-gated screeners return ok:false with a reason outside their window. Filters: price ≥ $1, volume ≥ 1k (extended) / 50k (daily+period). Read-only.',
      inputSchema: {
        kind: z.enum(['premarket', 'afterhours', 'daily', 'period']),
        days: z.number().optional().describe('For kind=period: 7, 30, 182 or 365.')
      },
      handler: (args) => ctx.invoke(`${ID}:screener`, { kind: args.kind, days: args.days })
    },
    {
      name: `${ID}__ipos`,
      description: 'IPO calendar: upcoming and recently listed US IPOs (5-min cache). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:ipos`)
    },
    {
      name: `${ID}__compare`,
      description: 'Compare up to 6 tickers side by side (price, change, market cap, P/E). Read-only.',
      inputSchema: { symbols: z.array(z.string()).describe('1–6 ticker symbols.') },
      handler: (args) => ctx.invoke(`${ID}:compare`, args.symbols)
    },
    {
      name: `${ID}__get-doc`,
      description:
        'Read the saved analysis doc for a ticker: the AI report (structured sections), chat history and screenshot count. Read-only.',
      inputSchema: { symbol: z.string().describe('Ticker symbol.') },
      handler: (args) => ctx.invoke(`${ID}:doc-get`, args.symbol)
    }
  ]
}

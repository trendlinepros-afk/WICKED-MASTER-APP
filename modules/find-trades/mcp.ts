import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for FIND TRADES. Only the DETERMINISTIC screen is exposed — it
 * takes explicit numeric criteria and returns matching tickers from the live
 * market snapshot. The AI chat agent (which consumes vault AI keys) stays OFF
 * MCP per the module contract; an agent can compose its own criteria and call
 * this read-only screen directly.
 */
const ID = 'find-trades'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__screen`,
      description:
        'Screen the live US market for stocks matching explicit numeric criteria (price, % change, volume, market cap, sector). Read-only; requires the Massive key. Percentages are whole numbers; market caps are in dollars.',
      inputSchema: {
        source: z
          .enum(['movers', 'premarket', 'afterhours', 'ipos', 'tickers'])
          .optional()
          .describe('Universe: movers = full market snapshot (default), premarket/afterhours = session movers, ipos, or explicit tickers.'),
        tickers: z.array(z.string()).optional().describe('Explicit symbols when source = "tickers".'),
        direction: z.enum(['up', 'down', 'any']).optional().describe('Keep only up movers, down movers, or any.'),
        minPrice: z.number().optional(),
        maxPrice: z.number().optional(),
        minChangePct: z.number().optional().describe('Minimum % change today (e.g. 5 for +5%).'),
        maxChangePct: z.number().optional(),
        minVolume: z.number().optional(),
        maxVolume: z.number().optional(),
        minMarketCap: z.number().optional().describe('In dollars (e.g. 10000000000 for $10B).'),
        maxMarketCap: z.number().optional(),
        sectors: z.array(z.string()).optional().describe('Broad sectors to keep, e.g. ["Technology","Healthcare"].'),
        needsNews: z.boolean().optional().describe('Require recent company news.'),
        keywords: z.array(z.string()).optional().describe('Name/news keywords to match, e.g. ["FDA","earnings"].'),
        minRvol: z.number().optional().describe('Minimum relative volume (2 = twice the 20-day average). Filters real moves from noise.'),
        minGapPct: z.number().optional().describe('Minimum open-vs-prev-close gap %.'),
        maxGapPct: z.number().optional().describe('Maximum gap %.'),
        nearHigh: z.boolean().optional().describe('Keep only stocks within ~5% of their 52-week high (breakout candidates).'),
        minAtrPct: z.number().optional().describe('Minimum ATR as % of price (true movers).'),
        requireUptrend: z.boolean().optional().describe('Require a short-term uptrend (above 20-day SMA and 20 > 50).'),
        minScore: z.number().optional().describe('Minimum unified Trade Score 0-100 (use 60+ for only the strongest setups).'),
        insiderBuying: z.boolean().optional().describe('Require net insider buying over ~90 days (needs Finnhub).'),
        minAnalystBull: z.number().optional().describe('Minimum % of bullish analysts, 0-100 (needs Finnhub).'),
        minShortPctFloat: z.number().optional().describe('Minimum short interest as % of float — squeeze candidates (needs Finnhub plan with short data).'),
        maxDaysToEarnings: z.number().optional().describe('Only stocks reporting earnings within N days (earnings-runup plays).'),
        avoidEarnings: z.boolean().optional().describe('Exclude stocks with earnings within ~2 days (avoid holding through the report).'),
        limit: z.number().int().optional().describe('Max results (default 12, cap 30).')
      },
      handler: (args) => ctx.invoke(`${ID}:screen`, args)
    },
    {
      name: `${ID}__trending`,
      description:
        'The stock tickers mentioned MOST on X (Twitter) over a time window, each rated by buzz + price momentum + tweet sentiment. Read-only. Needs the X Bearer Token (and the Massive key for price + junk-cashtag filtering). Windows are 24h | 7d | 14d | 30d | 90d | 180d; anything over 7 days needs X API Pro (full-archive access). Results are cached ~30 min to respect X quota.',
      inputSchema: {
        window: z
          .enum(['24h', '7d', '14d', '30d', '90d', '180d'])
          .optional()
          .describe('Look-back window (default 24h). Over 7 days requires X API Pro.'),
        force: z.boolean().optional().describe('Bypass the 30-minute cache and re-pull from X.')
      },
      handler: (args) => ctx.invoke(`${ID}:x-trending`, { window: args.window ?? '24h', force: args.force === true })
    },
    {
      name: `${ID}__mentions`,
      description:
        'Exact X (Twitter) mention COUNTS for ONE ticker over time, bucketed per hour (24h window) or per day (longer). Read-only. Uses X\'s counts endpoint — precise and cheap (does not draw down the tweet-pull quota). Needs the X Bearer Token. Windows are 24h | 7d | 14d | 30d | 90d | 180d; over 7 days needs X API Pro. Returns per-bucket counts, the total, granularity, and endpoint.',
      inputSchema: {
        ticker: z.string().describe('Ticker symbol, e.g. "NVDA" (the $ is optional).'),
        window: z
          .enum(['24h', '7d', '14d', '30d', '90d', '180d'])
          .optional()
          .describe('Look-back window (default 24h). Over 7 days requires X API Pro.'),
        force: z.boolean().optional().describe('Bypass the 30-minute cache and re-pull from X.')
      },
      handler: (args) => ctx.invoke(`${ID}:x-mentions`, { ticker: args.ticker, window: args.window ?? '24h', force: args.force === true })
    },
    {
      name: `${ID}__backtest`,
      description:
        'The last Trade Score backtest result: forward 1/5/20-day returns and win rate per score grade (A-F) vs the whole-universe baseline, measured over ~6 months of point-in-time market history. Read-only (returns the stored result; a fresh run is started from the app UI because it makes ~145 market-data calls). null if never run.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:backtest-last`)
    },
    {
      name: `${ID}__outcomes`,
      description:
        'How the picks this tool actually surfaced performed: every AI-search and preset pick is auto-logged, then graded against real forward closes (1/5/20 trading days). Returns overall stats plus breakdowns by score grade, setup, and source, and recent graded entries. Read-only; needs the Massive key.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:outcomes`)
    }
  ]
}

import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for RISK CALCULATOR — pure, read-only position-sizing math. Each
 * delegates to the same `risk-calculator:*` IPC handler the UI uses.
 */
const ID = 'risk-calculator'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__position-size`,
      description:
        'Size a stock trade to a fixed risk: given account, risk % per trade, entry and stop, returns shares to buy, dollar risk, position cost, % of account, and 1R/2R/3R target prices.',
      inputSchema: {
        account: z.number().describe('Account size in dollars.'),
        riskPercent: z.number().describe('Risk per trade, as a percent (e.g. 1 = 1%).'),
        entry: z.number().describe('Planned entry price.'),
        stop: z.number().describe('Stop-loss price.'),
        direction: z.enum(['long', 'short']).optional().describe('Trade direction (default long).')
      },
      handler: (args) => ctx.invoke(`${ID}:position-size`, args)
    },
    {
      name: `${ID}__risk-reward`,
      description:
        'Risk/reward for a trade: given entry, stop and target, returns the R:R ratio, the win rate needed to break even, and (with an optional winRate) the expectancy in R.',
      inputSchema: {
        entry: z.number(),
        stop: z.number(),
        target: z.number(),
        direction: z.enum(['long', 'short']).optional(),
        winRate: z.number().optional().describe('Optional win rate percent to compute expectancy in R.')
      },
      handler: (args) => ctx.invoke(`${ID}:risk-reward`, args)
    },
    {
      name: `${ID}__option`,
      description:
        'Long-option risk: given type/underlying/strike/premium/contracts, returns capital at risk (max loss), breakeven, % move to breakeven, and intrinsic/extrinsic value. With account + riskPercent it also returns the max contracts for that risk budget.',
      inputSchema: {
        optionType: z.enum(['call', 'put']),
        underlying: z.number().describe('Current underlying price.'),
        strike: z.number(),
        premium: z.number().describe('Option premium per share (e.g. 1.25).'),
        contracts: z.number(),
        multiplier: z.number().optional().describe('Shares per contract (default 100).'),
        account: z.number().optional(),
        riskPercent: z.number().optional()
      },
      handler: (args) => ctx.invoke(`${ID}:option`, args)
    },
    {
      name: `${ID}__expectancy`,
      description:
        'Edge math: given win rate %, average win and average loss (same units), returns per-trade expectancy, payoff ratio, profit factor, and the Kelly / half-Kelly fraction.',
      inputSchema: {
        winRate: z.number().describe('Win rate percent (0–100).'),
        avgWin: z.number().describe('Average winning trade (dollars or R).'),
        avgLoss: z.number().describe('Average losing trade, as a positive number (same units as avgWin).')
      },
      handler: (args) => ctx.invoke(`${ID}:expectancy`, args)
    }
  ]
}

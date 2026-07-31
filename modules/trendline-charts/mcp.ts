import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TRENDLINE CHARTS. Both tools hit TrendlineFinder's partner API,
 * so they are CREDENTIAL-GATED: per the WICKED contract, the MCP path must not
 * auto-use the stored vault key — the caller supplies the key as `apiKey`, which
 * is threaded through to the same IPC handlers the UI uses (the UI reads the
 * vault key in main instead). Fetching/saving a chart image is non-destructive.
 */
const ID = 'trendline-charts'
const CRED = 'TrendlineFinder API key (tlf_live_…)'

const HORIZONS = ['30d', '90d', '6mo', '1y'] as const
const INTERVALS = ['15m', '30m', '1h', '4h', '1d'] as const

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__health`,
      description:
        'Verify a TrendlineFinder API key by calling the partner /health endpoint. Returns the key name on success. Supply the key as apiKey.',
      inputSchema: {
        apiKey: z.string().optional().describe('TrendlineFinder API key (tlf_live_…).')
      },
      handler: (args) => {
        const gate = ctx.credential(CRED, args.apiKey as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:health`, { apiKey: args.apiKey })
      }
    },
    {
      name: `${ID}__chart`,
      description:
        'Fetch a support/resistance trendline chart PNG from TrendlineFinder for a US ticker and SAVE it to the Downloads/Trendline Charts folder, returning the file path plus how many days the image spans and which horizon pairs were drawn. The image auto-zooms to the longest horizon selected. Supply the key as apiKey.',
      inputSchema: {
        ticker: z.string().describe('US stock symbol, e.g. AAPL.'),
        horizons: z
          .array(z.enum(HORIZONS))
          .optional()
          .describe('Trendline pairs to draw. Omit for all four (30d, 90d, 6mo, 1y).'),
        interval: z.enum(INTERVALS).optional().describe('Candle size. Default 4h.'),
        width: z.number().int().optional().describe('Image width in px (320–2400). Default 1200.'),
        height: z.number().int().optional().describe('Chart height in px (240–1600). Default 640.'),
        branding: z.boolean().optional().describe('Set false to remove the TrendlineFinder footer. Default true.'),
        apiKey: z.string().optional().describe('TrendlineFinder API key (tlf_live_…).')
      },
      handler: (args) => {
        const gate = ctx.credential(CRED, args.apiKey as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:chart-file`, {
          ticker: args.ticker,
          horizons: args.horizons,
          interval: args.interval,
          width: args.width,
          height: args.height,
          branding: args.branding,
          apiKey: args.apiKey
        })
      }
    }
  ]
}

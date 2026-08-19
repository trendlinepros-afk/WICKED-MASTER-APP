/** Shared types for Day Trade Dash — used by main (ipc), the renderer and mcp. */

export const CHART_TFS = ['1m', '5m', '15m', '1h', 'D'] as const
export type ChartTf = (typeof CHART_TFS)[number]

export interface ChartSlot {
  symbol: string
  tf: ChartTf
}

export interface WatchEntry {
  symbol: string
  /** when the ticker was added (ms); 0 = unknown (migrated from an older layout) */
  addedAt: number
  /**
   * Price when the ticker was added — the anchor for the "% since added"
   * metric. null until a price is first seen (market data down at add time,
   * or a migrated entry); the renderer backfills it from the next quote poll.
   */
  addedPrice: number | null
}

export interface DashState {
  /** the three always-on charts across the top */
  charts: ChartSlot[]
  watch: WatchEntry[]
  /** watchlist ticker currently shown in the middle chart */
  selected: string
  selectedTf: ChartTf
  /** symbols on the rotating bottom tape */
  tape: string[]
  /** YouTube /embed URL for the live TV panel */
  tvUrl: string
  tvOn: boolean
}

/**
 * Bloomberg Television's 24/7 live stream on YouTube, via the evergreen
 * live_stream embed (always resolves to the channel's CURRENT live broadcast,
 * so the link never goes stale when they rotate streams). Muted autoplay —
 * browsers/webviews only allow autoplay muted; unmute inside the player.
 */
export const DEFAULT_TV_URL =
  'https://www.youtube.com/embed/live_stream?channel=UCIALMKvObZNtJ6AmdCLP7Lg&autoplay=1&mute=1'

export function defaultState(): DashState {
  return {
    charts: [
      { symbol: 'SPY', tf: '5m' },
      { symbol: 'QQQ', tf: '5m' },
      { symbol: 'IWM', tf: '15m' }
    ],
    watch: ['NVDA', 'TSLA', 'AAPL', 'AMD', 'META'].map((symbol) => ({ symbol, addedAt: 0, addedPrice: null })),
    selected: 'NVDA',
    selectedTf: '5m',
    // index/futures proxies day traders actually watch (ES→SPY, NQ→QQQ,
    // YM→DIA, RTY→IWM, CL→USO, GC→GLD, ZB→TLT, VIX→UVXY)
    tape: ['SPY', 'QQQ', 'DIA', 'IWM', 'SMH', 'TLT', 'GLD', 'USO', 'UVXY'],
    tvUrl: DEFAULT_TV_URL,
    tvOn: false
  }
}

export interface DashQuote {
  price: number | null
  changePct: number | null
}

export interface SessionInfo {
  session: 'premarket' | 'regular' | 'afterhours' | 'closed'
  /** "HH:MM" Eastern, for the header clock */
  etClock: string
  /** minutes until the next session transition (null on weekends/overnight) */
  minutesToNext: number | null
  /** what happens at that transition, e.g. "market opens" */
  nextLabel: string
}

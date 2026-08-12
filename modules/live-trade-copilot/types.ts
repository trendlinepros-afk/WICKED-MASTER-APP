/** Shared types for the Live Trade Copilot (main ⟷ renderer). */

export type Action = 'BUY' | 'SELL' | 'HOLD' | 'WAIT'

export interface PatternCall {
  name: string
  status: 'forming' | 'confirmed' | 'failed'
}

export interface Verdict {
  action: Action
  bias: 'bullish' | 'bearish' | 'neutral'
  /** 0-100 */
  confidence: number
  patterns: PatternCall[]
  levels: { support: number[]; resistance: number[] }
  oneLiner: string
  detail: string
  exitHint: string
}

export interface PositionState {
  inPosition: boolean
  entryPrice?: number
}

export interface QuoteLite {
  bid: number | null
  ask: number | null
  last: number | null
}

export type AnalyzeResult =
  | {
      ok: true
      verdict: Verdict
      t: number
      provider: string
      /** live Webull bars made it into this pass (false = vision-only tick) */
      barsOk: boolean
      barsError?: string
      quote: QuoteLite | null
    }
  | { ok: false; error: string }

export interface SessionSummary {
  symbol: string
  startedAt: number
  endedAt: number
  verdictCount: number
  /** action transitions into BUY/SELL */
  flips: number
  lastAction: Action | null
  note?: string
}

export interface CopilotStatus {
  running: boolean
  symbol: string | null
  startedAt: number | null
  verdictCount: number
  lastVerdict: (Verdict & { t: number }) | null
}

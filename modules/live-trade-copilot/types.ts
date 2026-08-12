/** Shared types for the Live Trade Copilot (main ⟷ renderer). */

/**
 * Position-explicit signals. WAIT is only legal when FLAT; in a position the
 * copilot must answer HOLD (stay) or the position's exit action — so "wait"
 * can never be misread as "flatten".
 */
export type Action = 'BUY_LONG' | 'SELL_LONG' | 'SELL_SHORT' | 'BUY_COVER' | 'HOLD' | 'WAIT'

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
  state: 'flat' | 'long' | 'short'
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
      /** hypothetical trades opened/closed by this tick (close precedes open) */
      signalEvents?: SignalEvent[]
    }
  | { ok: false; error: string }

export type SignalDir = 'long' | 'short'
/** 'flip' is the legacy name for 'signal' in old stored rows */
export type CloseReason = 'signal' | 'flip' | 'timeout' | 'session-end'

/** A hypothetical trade opened by a BUY/SELL flip, scored for the track record. */
export interface Signal {
  symbol: string
  dir: SignalDir
  entryT: number
  /** null = vision-only tick (no live quote) — excluded from P/L stats */
  entryP: number | null
  exitT?: number
  exitP?: number | null
  /** long: (exit-entry)/entry*100 · short: (entry-exit)/entry*100 */
  pct?: number | null
  reason?: CloseReason
  /** pattern names from the ENTRY verdict */
  patterns: string[]
  confidence: number
}

export interface SignalEvent {
  type: 'open' | 'close'
  signal: Signal
}

export interface DirStat {
  count: number
  winRate: number
  avgPct: number
}

export interface PatternStat extends DirStat {
  name: string
}

export interface Stats {
  /** priced closed signals */
  signals: number
  unpriced: number
  winRate: number
  avgPct: number
  netPct: number
  long: DirStat
  short: DirStat
  patterns: PatternStat[]
}

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

/** Shared types for Paper Trading — used by main (ipc), the pure engine and the renderer. */

export type PositionKind = 'stock' | 'option'
export type Side = 'long' | 'short'
export type OptionType = 'call' | 'put'
export type CloseReason = 'manual' | 'stop' | 'take-profit' | 'trailing-stop'

export interface Position {
  id: string
  kind: PositionKind
  /** underlying ticker, uppercase */
  symbol: string
  /** long/short for stock; options are long-only in v1 (always 'long') */
  side: Side
  /** shares (stock) or contracts (option) */
  qty: number
  /** per-share entry (stock) or premium per share (option) */
  entryPrice: number
  entryAt: number
  /** stop-loss on the instrument price (premium for options); null = none */
  stop: number | null
  /** take-profit on the instrument price; null = none */
  takeProfit: number | null
  /** trailing stop DISTANCE (follows the peak); null/0 = none. Stock only. */
  trailingStop?: number | null
  /** unit of trailingStop: 'usd' = $ distance, 'pct' = % of the peak. Default 'usd'. */
  trailingStopUnit?: 'usd' | 'pct'
  /** most-favorable price seen since entry — the trailing-stop anchor, persisted between reconciles. */
  peak?: number | null
  // option-only
  optionType?: OptionType
  strike?: number
  expiry?: string
  multiplier?: number
}

export interface ClosedTrade {
  id: string
  kind: PositionKind
  symbol: string
  side: Side
  qty: number
  entryPrice: number
  entryAt: number
  exitPrice: number
  exitAt: number
  /** realized dollar P&L */
  pnl: number
  reason: CloseReason
  optionType?: OptionType
  strike?: number
  expiry?: string
  multiplier?: number
}

export interface PaperAccount {
  id: string
  name: string
  startingBalance: number
  /** available cash */
  cash: number
  createdAt: number
  /** ms timestamp we last reconciled stops/targets against history (for backdating) */
  lastReconciledAt: number
  positions: Position[]
  closed: ClosedTrade[]
}

export interface PaperData {
  accounts: PaperAccount[]
  activeId: string
}

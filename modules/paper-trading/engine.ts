import type { ClosedTrade, CloseReason, PaperAccount, Position } from './types'

/**
 * Pure paper-trading math — cash accounting, P&L, equity, order execution and
 * offline stop/target backdating. No node/electron/react imports, so both the
 * main process (execution) and the renderer (display) share the exact logic.
 * Ids are passed in (callers generate them) to keep this dependency-free.
 */

export function mult(p: Pick<Position, 'kind' | 'multiplier'>): number {
  return p.kind === 'option' ? p.multiplier || 100 : 1
}

/** Unrealized dollar P&L of an open position at `mark`. */
export function unrealizedPnl(p: Position, mark: number): number {
  const m = mult(p)
  return p.side === 'short' ? (p.entryPrice - mark) * p.qty * m : (mark - p.entryPrice) * p.qty * m
}

/** Contribution to account equity (cash already reflects the open). */
export function positionEquity(p: Position, mark: number): number {
  const m = mult(p)
  return p.side === 'short' ? -mark * p.qty * m : mark * p.qty * m
}

/** Full account equity = cash + open position values (shorts are liabilities). */
export function accountEquity(acct: PaperAccount, mark: (sym: string) => number): number {
  let eq = acct.cash
  for (const p of acct.positions) eq += positionEquity(p, mark(p.symbol) || p.entryPrice)
  return eq
}

export interface OpenOrder {
  kind: 'stock' | 'option'
  symbol: string
  side: 'long' | 'short'
  qty: number
  price: number
  stop?: number | null
  takeProfit?: number | null
  optionType?: 'call' | 'put'
  strike?: number
  expiry?: string
  multiplier?: number
}

/** Open a position; long opens are a debit, short opens a credit. Rejects a buy that exceeds cash. */
export function openPosition(
  acct: PaperAccount,
  order: OpenOrder,
  now: number,
  id: string
): { ok: boolean; error?: string; account?: PaperAccount } {
  const m = order.kind === 'option' ? order.multiplier || 100 : 1
  if (!(order.qty > 0)) return { ok: false, error: 'Quantity must be greater than 0.' }
  if (!(order.price > 0)) return { ok: false, error: 'No price available for this order.' }
  const notional = order.qty * order.price * m
  const isBuy = order.side === 'long'
  const cash = isBuy ? acct.cash - notional : acct.cash + notional
  if (isBuy && cash < 0) return { ok: false, error: 'Not enough cash for this order.' }
  const pos: Position = {
    id,
    kind: order.kind,
    symbol: order.symbol.toUpperCase(),
    side: order.side,
    qty: order.qty,
    entryPrice: order.price,
    entryAt: now,
    stop: order.stop ?? null,
    takeProfit: order.takeProfit ?? null,
    ...(order.kind === 'option'
      ? { optionType: order.optionType, strike: order.strike, expiry: order.expiry, multiplier: m }
      : {})
  }
  return { ok: true, account: { ...acct, cash, positions: [...acct.positions, pos] } }
}

/** Close (or partially close) a position at `price`, realizing P&L into cash + history. */
export function closePosition(
  acct: PaperAccount,
  positionId: string,
  price: number,
  now: number,
  reason: CloseReason,
  closeId: string,
  closeQty?: number
): { ok: boolean; error?: string; account?: PaperAccount } {
  const idx = acct.positions.findIndex((p) => p.id === positionId)
  if (idx === -1) return { ok: false, error: 'Position not found.' }
  if (!(price > 0)) return { ok: false, error: 'No price available to close.' }
  const p = acct.positions[idx]
  const qty = closeQty && closeQty > 0 ? Math.min(closeQty, p.qty) : p.qty
  const m = mult(p)
  let cash = acct.cash
  let pnl = 0
  if (p.side === 'short') {
    cash -= qty * price * m // buy to cover
    pnl = (p.entryPrice - price) * qty * m
  } else {
    cash += qty * price * m // sell the long
    pnl = (price - p.entryPrice) * qty * m
  }
  const closed: ClosedTrade = {
    id: closeId,
    kind: p.kind,
    symbol: p.symbol,
    side: p.side,
    qty,
    entryPrice: p.entryPrice,
    entryAt: p.entryAt,
    exitPrice: price,
    exitAt: now,
    pnl,
    reason,
    optionType: p.optionType,
    strike: p.strike,
    expiry: p.expiry,
    multiplier: p.multiplier
  }
  const positions = [...acct.positions]
  if (qty >= p.qty) positions.splice(idx, 1)
  else positions[idx] = { ...p, qty: p.qty - qty }
  return { ok: true, account: { ...acct, cash, positions, closed: [closed, ...acct.closed] } }
}

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
}

/**
 * Given minute bars AFTER entry, find the first bar that crossed the stop or
 * target and return the exit (filled at the level). Stop is checked before
 * target within a bar (conservative). Stock positions only.
 */
export function detectExit(p: Position, bars: Bar[]): { price: number; at: number; reason: CloseReason } | null {
  if (p.stop == null && p.takeProfit == null) return null
  for (const b of bars) {
    if (b.t <= p.entryAt) continue
    if (p.side === 'long') {
      if (p.stop != null && b.l <= p.stop) return { price: p.stop, at: b.t, reason: 'stop' }
      if (p.takeProfit != null && b.h >= p.takeProfit) return { price: p.takeProfit, at: b.t, reason: 'take-profit' }
    } else {
      if (p.stop != null && b.h >= p.stop) return { price: p.stop, at: b.t, reason: 'stop' }
      if (p.takeProfit != null && b.l <= p.takeProfit) return { price: p.takeProfit, at: b.t, reason: 'take-profit' }
    }
  }
  return null
}

/** Realized P&L from closed trades whose exit is at/after `sinceMs`. */
export function realizedSince(closed: ClosedTrade[], sinceMs: number): number {
  return closed.filter((c) => c.exitAt >= sinceMs).reduce((a, c) => a + c.pnl, 0)
}

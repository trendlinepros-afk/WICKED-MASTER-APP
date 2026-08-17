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

export interface OpenOrder {
  kind: 'stock' | 'option'
  symbol: string
  side: 'long' | 'short'
  qty: number
  price: number
  stop?: number | null
  takeProfit?: number | null
  trailingStop?: number | null
  trailingStopUnit?: 'usd' | 'pct'
  optionType?: 'call' | 'put'
  strike?: number
  expiry?: string
  multiplier?: number
}

/** True when a new order should merge into an existing position (same instrument + side). */
function sameInstrument(p: Position, order: OpenOrder): boolean {
  if (p.symbol !== order.symbol.toUpperCase() || p.side !== order.side || p.kind !== order.kind) return false
  if (order.kind === 'option') return p.optionType === order.optionType && p.strike === order.strike && p.expiry === order.expiry
  return true
}

/**
 * Open a position; long opens are a debit, short opens a credit. Rejects a buy
 * that exceeds cash. A new order on an instrument already held (same side)
 * CONSOLIDATES into that position at a share-weighted average cost.
 */
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

  const idx = acct.positions.findIndex((p) => sameInstrument(p, order))
  if (idx !== -1) {
    // add to the existing position → new average cost; keep the earlier entry time
    const ex = acct.positions[idx]
    const newQty = ex.qty + order.qty
    const avgEntry = (ex.qty * ex.entryPrice + order.qty * order.price) / newQty
    const merged: Position = {
      ...ex,
      qty: newQty,
      entryPrice: avgEntry,
      stop: order.stop != null ? order.stop : ex.stop,
      takeProfit: order.takeProfit != null ? order.takeProfit : ex.takeProfit,
      trailingStop: order.trailingStop != null ? order.trailingStop : ex.trailingStop ?? null,
      trailingStopUnit: order.trailingStop != null ? order.trailingStopUnit ?? 'usd' : ex.trailingStopUnit
    }
    const positions = acct.positions.map((p, i) => (i === idx ? merged : p))
    return { ok: true, account: { ...acct, cash, positions } }
  }

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
    trailingStop: order.trailingStop ?? null,
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
 * target and return the exit. Fills happen at the level — unless the bar
 * OPENED beyond it (an overnight/halt gap), in which case the fill is the
 * bar's open, which is where a real stop-market or resting limit would fill.
 * Stop is checked before target within a bar (conservative). Also returns the
 * updated trailing-stop anchor (`peak`) so callers can persist it — without
 * that, each reconcile window would re-anchor the trail back at the entry
 * price and forget highs reached in earlier windows. Stock positions only.
 */
export function detectExit(
  p: Position,
  bars: Bar[]
): { exit: { price: number; at: number; reason: CloseReason } | null; peak: number } {
  const trailVal = p.trailingStop != null && p.trailingStop > 0 ? p.trailingStop : null
  // Trailing distance at a given anchor: a fixed $ amount, or a % of the anchor.
  const trailDist = (anchor: number): number | null =>
    trailVal == null ? null : p.trailingStopUnit === 'pct' ? anchor * (trailVal / 100) : trailVal
  // `peak` tracks the most-favorable extreme so far (running high for a long,
  // running low for a short) — the anchor the trailing stop follows.
  let peak = p.peak ?? p.entryPrice
  if (p.stop == null && p.takeProfit == null && trailVal == null) return { exit: null, peak }
  for (const b of bars) {
    if (b.t <= p.entryAt) continue
    if (p.side === 'long') {
      const d = trailDist(peak)
      const trailLevel = d != null ? peak - d : null
      let floor: number | null = p.stop ?? null
      let reason: CloseReason = 'stop'
      if (trailLevel != null && (floor == null || trailLevel > floor)) {
        floor = trailLevel
        reason = 'trailing-stop'
      }
      if (floor != null && b.l <= floor) return { exit: { price: Math.min(floor, b.o), at: b.t, reason }, peak }
      if (p.takeProfit != null && b.h >= p.takeProfit)
        return { exit: { price: Math.max(p.takeProfit, b.o), at: b.t, reason: 'take-profit' }, peak }
      peak = Math.max(peak, b.h)
    } else {
      const d = trailDist(peak)
      const trailLevel = d != null ? peak + d : null
      let ceil: number | null = p.stop ?? null
      let reason: CloseReason = 'stop'
      if (trailLevel != null && (ceil == null || trailLevel < ceil)) {
        ceil = trailLevel
        reason = 'trailing-stop'
      }
      if (ceil != null && b.h >= ceil) return { exit: { price: Math.max(ceil, b.o), at: b.t, reason }, peak }
      if (p.takeProfit != null && b.l <= p.takeProfit)
        return { exit: { price: Math.min(p.takeProfit, b.o), at: b.t, reason: 'take-profit' }, peak }
      peak = Math.min(peak, b.l)
    }
  }
  return { exit: null, peak }
}

/** Realized P&L from closed trades whose exit is at/after `sinceMs`. */
export function realizedSince(closed: ClosedTrade[], sinceMs: number): number {
  return closed.filter((c) => c.exitAt >= sinceMs).reduce((a, c) => a + c.pnl, 0)
}

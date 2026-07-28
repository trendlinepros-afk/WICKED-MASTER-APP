/**
 * Watchlist alert evaluation (pure, unit-tested). The background monitor in
 * ipc.ts fetches a live quote for each watched ticker and asks these functions
 * which alert conditions are true, and which are NEWLY true (edge-triggered with
 * an anti-flap cooldown) so a hovering price doesn't spam notifications.
 */

export interface WatchAlerts {
  priceAbove: number | null
  priceBelow: number | null
  changeAbovePct: number | null
  rvolAbove: number | null
  nearHigh: boolean
}

export interface WatchItem {
  ticker: string
  addedAt: number
  alerts: WatchAlerts
  /** condition key → last time it fired (for cooldown) */
  lastFired: Record<string, number>
}

export interface WatchQuote {
  price: number | null
  changePct: number | null
  rvol: number | null
  pctFrom52High: number | null
}

export interface FiredCond {
  condition: string
  message: string
}

export function emptyAlerts(): WatchAlerts {
  return { priceAbove: null, priceBelow: null, changeAbovePct: null, rvolAbove: null, nearHigh: false }
}

export function hasAnyAlert(a: WatchAlerts): boolean {
  return a.priceAbove != null || a.priceBelow != null || a.changeAbovePct != null || a.rvolAbove != null || a.nearHigh
}

/** Which alert conditions are currently TRUE for this quote. */
export function evalAlerts(item: WatchItem, q: WatchQuote): FiredCond[] {
  const a = item.alerts
  const t = item.ticker
  const out: FiredCond[] = []
  const px = (n: number | null): string => (n == null ? 'n/a' : `$${n.toFixed(2)}`)
  if (a.priceAbove != null && q.price != null && q.price >= a.priceAbove)
    out.push({ condition: 'priceAbove', message: `${t} crossed above $${a.priceAbove} (now ${px(q.price)})` })
  if (a.priceBelow != null && q.price != null && q.price <= a.priceBelow)
    out.push({ condition: 'priceBelow', message: `${t} dropped below $${a.priceBelow} (now ${px(q.price)})` })
  if (a.changeAbovePct != null && q.changePct != null && q.changePct >= a.changeAbovePct)
    out.push({ condition: 'changeAbovePct', message: `${t} is up ${q.changePct.toFixed(1)}% today (≥ ${a.changeAbovePct}%)` })
  if (a.rvolAbove != null && q.rvol != null && q.rvol >= a.rvolAbove)
    out.push({ condition: 'rvolAbove', message: `${t} volume spike — RVOL ${q.rvol}× (≥ ${a.rvolAbove}×)` })
  if (a.nearHigh && q.pctFrom52High != null && q.pctFrom52High >= -2)
    out.push({ condition: 'nearHigh', message: `${t} is at/near its 52-week high` })
  return out
}

/** Of the currently-true conditions, the ones eligible to fire (past cooldown). */
export function pickNewlyFired(current: FiredCond[], lastFired: Record<string, number>, now: number, cooldownMs: number): FiredCond[] {
  return current.filter((c) => {
    const last = lastFired[c.condition]
    return last == null || now - last >= cooldownMs
  })
}

/** Coerce arbitrary stored JSON into a valid WatchItem (defensive). */
export function normalizeItem(raw: unknown): WatchItem | null {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const ticker = String(r.ticker ?? '').trim().toUpperCase()
  if (!/^[A-Z]{1,6}$/.test(ticker)) return null
  const ra = (typeof r.alerts === 'object' && r.alerts !== null ? r.alerts : {}) as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    ticker,
    addedAt: num(r.addedAt) ?? 0,
    alerts: {
      priceAbove: num(ra.priceAbove),
      priceBelow: num(ra.priceBelow),
      changeAbovePct: num(ra.changeAbovePct),
      rvolAbove: num(ra.rvolAbove),
      nearHigh: ra.nearHigh === true
    },
    lastFired: typeof r.lastFired === 'object' && r.lastFired !== null ? (r.lastFired as Record<string, number>) : {}
  }
}

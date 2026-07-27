/**
 * Quote resolution (pure — the "JBLU bug" fix, ported with its tested rules):
 *  - 0 / negative prices are MISSING, never shown as $0.00.
 *  - price  = lastTrade.p ?? minute.c ?? day.c ?? prevDay.c ?? prevClose
 *  - volume = day.v ?? minute.av ?? prev bar volume
 *  - change/% come from todaysChange fields; when absent they are derived from
 *    day.c vs prevDay.c ONLY when both are real — never invent a move on a
 *    non-trading day.
 */

const realPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const realNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export interface SnapshotTicker {
  lastTrade?: { p?: number }
  min?: { c?: number; av?: number }
  day?: { c?: number; v?: number; o?: number; h?: number; l?: number }
  prevDay?: { c?: number; v?: number }
  todaysChange?: number
  todaysChangePerc?: number
}

export interface ResolvedQuote {
  price: number | null
  volume: number | null
  change: number | null
  changePct: number | null
}

export function resolveQuote(
  snap: SnapshotTicker | null,
  prevBar: { c?: number; v?: number } | null
): ResolvedQuote {
  const price =
    [snap?.lastTrade?.p, snap?.min?.c, snap?.day?.c, snap?.prevDay?.c, prevBar?.c].find(realPrice) ??
    null
  const volume =
    [snap?.day?.v, snap?.min?.av, prevBar?.v].find((v): v is number => realNum(v) && v > 0) ?? null

  let change: number | null = null
  let changePct: number | null = null
  if (realNum(snap?.todaysChange) && realNum(snap?.todaysChangePerc)) {
    change = snap.todaysChange
    changePct = snap.todaysChangePerc
  } else if (realPrice(snap?.day?.c) && realPrice(snap?.prevDay?.c)) {
    change = snap.day.c - snap.prevDay.c
    changePct = (change / snap.prevDay.c) * 100
  }
  return { price, volume, change, changePct }
}

/** Trailing P/E only when there is real positive income — a net loss has none. */
export function computePE(marketCap: unknown, netIncome: unknown): number | null {
  if (!realPrice(marketCap) || !realNum(netIncome) || netIncome <= 0) return null
  return marketCap / netIncome
}

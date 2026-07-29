/** One hand-written trade journal entry. Shared by the main (ipc) + renderer. */
export interface JournalEntry {
  id: string
  /** optional free-text name/title for the trade; falls back to symbol in the UI */
  name: string
  /** ticker traded, upper-cased */
  symbol: string

  /* --- entry (why you got in) --- */
  /** wall-clock datetime you bought at, "YYYY-MM-DDTHH:mm" (local, no tz) */
  buyAt: string
  /** shares bought */
  shares: number
  /** price per share you bought at, or null if not recorded */
  buyPrice: number | null
  /** why you bought */
  entryNote: string

  /* --- exit (why you got out); blank while the trade is still open --- */
  /** wall-clock datetime you sold at, "" while open */
  sellAt: string
  /** price per share you sold at, or null while open */
  sellPrice: number | null
  /** why you left the trade */
  exitNote: string

  /* --- final review --- */
  /** your final thoughts on the trade */
  finalReview: string

  createdAt: number
  updatedAt: number
}

/** Fields a create/update accepts (server assigns id / timestamps). */
export type JournalDraft = Omit<JournalEntry, 'id' | 'createdAt' | 'updatedAt'>

/** Realized P&L for a closed entry, or null while open / missing prices. */
export function entryPnl(e: Pick<JournalEntry, 'shares' | 'buyPrice' | 'sellPrice'>):
  | { abs: number; pct: number }
  | null {
  if (e.shares > 0 && e.buyPrice != null && e.sellPrice != null && e.buyPrice > 0) {
    return {
      abs: e.shares * (e.sellPrice - e.buyPrice),
      pct: ((e.sellPrice - e.buyPrice) / e.buyPrice) * 100
    }
  }
  return null
}

/** A trade is "closed" once a sold price is recorded. */
export function isClosed(e: Pick<JournalEntry, 'sellPrice'>): boolean {
  return e.sellPrice != null
}

/**
 * Display title for an entry: the trade's name if given, else the ticker, else
 * a fallback. `name` may be absent on entries created before the field existed.
 */
export function entryTitle(
  e: Partial<Pick<JournalEntry, 'name' | 'symbol'>>,
  fallback = 'Untitled'
): string {
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  return name || e.symbol || fallback
}

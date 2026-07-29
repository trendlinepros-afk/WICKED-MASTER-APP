/** One hand-written trade journal entry. Shared by the main (ipc) + renderer. */
export interface JournalEntry {
  id: string
  /** the trade's name/title. Auto-generated while `nameAuto` is true, else user-typed. */
  name: string
  /** true = keep `name` auto-generated (ticker + dates + green/red); false = user set it. */
  nameAuto: boolean
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
  /** how the trade felt on a 1–5 stress scale (1 panicked → 5 cheerful); null = unset */
  emotion: number | null

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

/** The 1–5 emotion/stress scale on the Exit card: scared/mad → happy/cheerful. */
export const EMOTIONS: { value: number; emoji: string; label: string }[] = [
  { value: 1, emoji: '😱', label: 'Panicked' },
  { value: 2, emoji: '😠', label: 'Stressed' },
  { value: 3, emoji: '😐', label: 'Neutral' },
  { value: 4, emoji: '🙂', label: 'Calm' },
  { value: 5, emoji: '😄', label: 'Cheerful' }
]

/** Emoji for a stored emotion value, or "" when unset/out of range. */
export function emotionEmoji(value: number | null | undefined): string {
  return EMOTIONS.find((e) => e.value === value)?.emoji ?? ''
}

/** "YYYY-MM-DDTHH:mm" (or a date-only prefix) → "MM/DD/YY"; "" if unparseable. */
function shortDay(local?: string): string {
  if (!local) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(local)
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : ''
}

/**
 * The auto-generated name: "TICKER - opened → closed - Green/Red".
 * While open it's "TICKER - opened - Open". Returns "" when there isn't yet
 * enough to name it (no ticker) so callers can fall back.
 */
export function autoName(e: Partial<JournalEntry>): string {
  const tkr = (e.symbol ?? '').trim()
  if (!tkr) return ''
  const open = shortDay(e.buyAt)
  if (!isClosed({ sellPrice: e.sellPrice ?? null })) {
    return open ? `${tkr} - ${open} - Open` : `${tkr} - Open`
  }
  const close = shortDay(e.sellAt)
  const range = open && close ? `${open} → ${close}` : open || close || ''
  const pl = entryPnl({ shares: e.shares ?? 0, buyPrice: e.buyPrice ?? null, sellPrice: e.sellPrice ?? null })
  const color = pl ? (pl.abs >= 0 ? 'Green' : 'Red') : ''
  return [tkr, range, color].filter(Boolean).join(' - ')
}

/**
 * Whether the entry's name should be auto-generated. Honors the stored
 * `nameAuto` flag; for legacy entries without it, auto = no manual name was set.
 */
export function effectiveAuto(e: Partial<Pick<JournalEntry, 'nameAuto' | 'name'>>): boolean {
  if (typeof e.nameAuto === 'boolean') return e.nameAuto
  return !(typeof e.name === 'string' && e.name.trim() !== '')
}

/**
 * Display title for an entry: the auto name when in auto mode, else the
 * user-typed name, with a fallback when neither is available yet.
 */
export function entryTitle(e: Partial<JournalEntry>, fallback = 'Untitled'): string {
  if (effectiveAuto(e)) return autoName(e) || fallback
  const name = typeof e.name === 'string' ? e.name.trim() : ''
  return name || autoName(e) || fallback
}

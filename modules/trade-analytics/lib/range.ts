import { etInputToEpoch, etParts } from './et'

/**
 * Shared date-range logic (pure) for the dashboard's range filter AND the
 * "Export Account Summary" PDF — one implementation so the number on screen
 * and the number in the export can never disagree.
 *
 * Rolling presets are anchored at the LATEST CLOSED TRADE (same semantics as
 * the Stats tab's period cards), so "Daily" is the most recent trading day,
 * never an empty calendar day. All day boundaries are ET wall-clock days.
 */

export type RangePreset = 'lifetime' | '1d' | '7d' | '14d' | '30d' | '90d' | '180d' | '365d' | 'custom'

export const RANGE_PRESETS: { id: RangePreset; label: string; days: number | null; hint?: string }[] = [
  { id: 'lifetime', label: 'Lifetime', days: null, hint: 'everything' },
  { id: '1d', label: 'Daily', days: 1, hint: 'latest trading day' },
  { id: '7d', label: 'Weekly', days: 7, hint: 'last 7 days' },
  { id: '14d', label: '2 weeks', days: 14 },
  { id: '30d', label: '1 month', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '180d', label: '180 days', days: 180 },
  { id: '365d', label: '365 days', days: 365 },
  { id: 'custom', label: 'Custom…', days: null, hint: 'pick start & end' }
]

export function rangePresetLabel(preset: RangePreset): string {
  return RANGE_PRESETS.find((p) => p.id === preset)?.label ?? preset
}

export const ymdToUtc = (ymd: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null
}

export const utcToYmd = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export const prettyYmd = (ymd: string): string => {
  const ms = ymdToUtc(ymd)
  return ms == null
    ? ymd
    : new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
}

// range boundaries are ET wall-clock days, DST-correct via lib/et
export const etDayStart = (ymd: string): number => etInputToEpoch(`${ymd}T00:00`) ?? -Infinity
export const etDayEnd = (ymd: string): number => (etInputToEpoch(`${ymd}T23:59`) ?? Infinity) + 59_999

export interface ResolvedRange {
  startMs: number
  endMs: number
  /** e.g. "Last month · Aug 3 – Sep 1, 2026" */
  label: string
  /** invalid input (custom without dates, unknown preset) */
  error?: string
}

/**
 * Resolve a preset (or custom ymd pair) to epoch-ms bounds + display label.
 * `latestCloseMs` / `firstCloseMs` come from the trade set being filtered
 * (null when there are no closed trades — bounds then cover everything).
 */
export function resolveRange(
  preset: RangePreset,
  latestCloseMs: number | null,
  firstCloseMs: number | null,
  startYmd?: string,
  endYmd?: string
): ResolvedRange {
  if (preset === 'custom') {
    let a = ymdToUtc(startYmd ?? '')
    let b = ymdToUtc(endYmd ?? '')
    if (a == null || b == null)
      return { startMs: -Infinity, endMs: Infinity, label: 'Custom', error: 'Pick a start and end date for the custom range.' }
    if (a > b) [a, b] = [b, a]
    const s = utcToYmd(a)
    const e = utcToYmd(b)
    return { startMs: etDayStart(s), endMs: etDayEnd(e), label: `${prettyYmd(s)} – ${prettyYmd(e)}` }
  }
  if (preset === 'lifetime') {
    const label =
      latestCloseMs != null && firstCloseMs != null
        ? `Lifetime · ${prettyYmd(etParts(firstCloseMs).ymd)} – ${prettyYmd(etParts(latestCloseMs).ymd)}`
        : 'Lifetime'
    return { startMs: -Infinity, endMs: Infinity, label }
  }
  const spec = RANGE_PRESETS.find((p) => p.id === preset)
  if (!spec || spec.days == null)
    return { startMs: -Infinity, endMs: Infinity, label: String(preset), error: `Unknown range "${preset}".` }
  if (latestCloseMs == null) return { startMs: -Infinity, endMs: Infinity, label: spec.label }
  const latestYmd = etParts(latestCloseMs).ymd
  const startY = utcToYmd((ymdToUtc(latestYmd) as number) - (spec.days - 1) * 86400_000)
  return {
    startMs: etDayStart(startY),
    endMs: etDayEnd(latestYmd),
    label: spec.days === 1 ? `${spec.label} · ${prettyYmd(latestYmd)}` : `${spec.label} · ${prettyYmd(startY)} – ${prettyYmd(latestYmd)}`
  }
}

/**
 * Apply a resolved range to a trade list: CLOSED trades are kept when they
 * closed inside the range; OPEN positions are always kept (they are current
 * state, not period activity — the Open Positions tab stays truthful).
 */
export function filterTradesToRange<T extends { isOpen: boolean; closedAt: number | null }>(
  trades: T[],
  r: ResolvedRange
): T[] {
  return trades.filter((t) => t.isOpen || (t.closedAt != null && t.closedAt >= r.startMs && t.closedAt <= r.endMs))
}

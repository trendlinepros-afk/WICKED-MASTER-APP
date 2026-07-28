/**
 * MACRO EVENT calendar (pure) — a breakout the day before a Fed decision or CPI
 * print is a different trade. Dates are the published 2026 schedules, hardcoded
 * because both are announced a year ahead; VERIFY AND EXTEND ANNUALLY (FOMC:
 * federalreserve.gov meeting calendar — decision day is the second day; CPI:
 * bls.gov release schedule).
 */

const FOMC_DECISIONS_2026 = [
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09'
]

const CPI_RELEASES_2026 = [
  '2026-01-13',
  '2026-02-11',
  '2026-03-11',
  '2026-04-10',
  '2026-05-12',
  '2026-06-10',
  '2026-07-14',
  '2026-08-12',
  '2026-09-11',
  '2026-10-13',
  '2026-11-10',
  '2026-12-10'
]

export interface MacroEvent {
  name: string
  date: string
  daysAway: number
}

/** The nearest FOMC/CPI event within `horizon` days of todayYmd (null if none). */
export function nextMacroEvent(todayYmd: string, horizon = 5): MacroEvent | null {
  const today = Date.parse(todayYmd + 'T00:00:00Z')
  if (Number.isNaN(today)) return null
  let best: MacroEvent | null = null
  const consider = (name: string, date: string): void => {
    const t = Date.parse(date + 'T00:00:00Z')
    const daysAway = Math.round((t - today) / 86_400_000)
    if (daysAway < 0 || daysAway > horizon) return
    if (!best || daysAway < best.daysAway) best = { name, date, daysAway }
  }
  for (const d of FOMC_DECISIONS_2026) consider('FOMC decision', d)
  for (const d of CPI_RELEASES_2026) consider('CPI print', d)
  return best
}

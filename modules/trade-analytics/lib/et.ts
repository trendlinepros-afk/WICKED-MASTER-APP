/**
 * Eastern-Time date parts (pure). ALL time-of-day / day / weekday grouping in
 * the Trade Journal must go through this so the analytics agree regardless of
 * the host machine's timezone and match the market clock (the UI labels these
 * "ET"). DST is handled by Intl (America/New_York).
 */

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short'
})

export interface EtParts {
  y: number
  m: number // 1-12
  d: number
  hour: number // 0-23
  minute: number
  dow: number // 0=Sun
  ymd: string // YYYY-MM-DD
}

const DOW_IDX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function etParts(at: number): EtParts {
  const parts = ET.formatToParts(new Date(at))
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  const y = Number(g('year'))
  const m = Number(g('month'))
  const d = Number(g('day'))
  let hour = Number(g('hour'))
  if (hour === 24) hour = 0 // hour12:false can emit 24 at midnight
  return {
    y,
    m,
    d,
    hour,
    minute: Number(g('minute')),
    dow: DOW_IDX[g('weekday')] ?? 0,
    ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
}

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

/* --------- <input type="datetime-local"> <-> epoch, in Eastern Time -------- */

const p2 = (n: number): string => String(n).padStart(2, '0')

/** Epoch ms → "YYYY-MM-DDTHH:MM" as the ET wall clock (to prefill a picker). */
export function etInputValue(at: number | null | undefined): string {
  if (at == null || !Number.isFinite(at)) return ''
  const p = etParts(at)
  return `${p.y}-${p2(p.m)}-${p2(p.d)}T${p2(p.hour)}:${p2(p.minute)}`
}

/**
 * "YYYY-MM-DDTHH:MM" (interpreted as an ET wall clock, matching how imported
 * fills are timestamped) → epoch ms. Uses the offset-correction trick so it is
 * DST-correct and independent of the host machine's timezone.
 */
export function etInputToEpoch(local: string): number | null {
  const m = (local || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const [, y, mo, d, hh, mm, ss] = m
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +hh, +mm, ss ? +ss : 0)
  if (Number.isNaN(utcGuess)) return null
  // How does that UTC instant read on the ET wall clock? The gap is the offset.
  const p = etParts(utcGuess)
  const asEt = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, ss ? +ss : 0)
  const offset = asEt - utcGuess
  return utcGuess - offset
}

/* ---------------- ET clock with seconds (trade entry / exit times) --------------- */

const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true
})

/** Epoch ms → { date: "Sep 22", time: "9:31:05 AM", ymd } on the ET clock. */
export function etDateTime(at: number | null | undefined): { date: string; time: string; ymd: string } | null {
  if (at == null || !Number.isFinite(at)) return null
  const parts = ET_CLOCK.formatToParts(new Date(at))
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${g('month')} ${g('day')}`, time: `${g('hour')}:${g('minute')}:${g('second')} ${g('dayPeriod')}`, ymd: etParts(at).ymd }
}

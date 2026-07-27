/**
 * DST-aware US market session logic (pure — ported from wickeddash with its
 * unit-tested behavior). All boundaries are computed in America/New_York via
 * Intl, so the host machine's timezone never matters.
 *
 * Sessions (ET): pre-market 4:00–9:30 · regular 9:30–16:00 ·
 * after-hours 16:00–20:00 · otherwise closed. Weekends closed.
 */

export interface EtParts {
  /** 0=Sun … 6=Sat */
  weekday: number
  hour: number
  minute: number
  /** YYYY-MM-DD in ET */
  ymd: string
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function etParts(now: Date = new Date()): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value
  return {
    weekday: WEEKDAYS[p.weekday] ?? 0,
    hour: Number(p.hour === '24' ? '0' : p.hour),
    minute: Number(p.minute),
    ymd: `${p.year}-${p.month}-${p.day}`
  }
}

export type MarketSession = 'premarket' | 'regular' | 'afterhours' | 'closed'

export function marketSession(now: Date = new Date()): MarketSession {
  const { weekday, hour, minute } = etParts(now)
  if (weekday === 0 || weekday === 6) return 'closed'
  const m = hour * 60 + minute
  if (m >= 240 && m < 570) return 'premarket' // 4:00–9:29
  if (m >= 570 && m < 960) return 'regular' // 9:30–15:59
  if (m >= 960 && m < 1200) return 'afterhours' // 16:00–19:59
  return 'closed'
}

/** Today's date in ET as YYYY-MM-DD. */
export function etTodayYmd(now: Date = new Date()): string {
  return etParts(now).ymd
}

/** The ET date `days` ago as YYYY-MM-DD. */
export function etYmdDaysAgo(days: number, now: Date = new Date()): string {
  return etParts(new Date(now.getTime() - days * 86_400_000)).ymd
}

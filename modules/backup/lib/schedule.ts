import type { Schedule } from '../types'

/**
 * Pure schedule math (local time, DST-safe via Date setters). Shared by the
 * main-process scheduler and the plan editor's "next run" preview.
 */

export const DEFAULT_SCHEDULE: Schedule = {
  kind: 'daily',
  everyHours: 4,
  time: '21:00',
  weekdays: [1, 2, 3, 4, 5],
  monthDay: 1,
  runMissed: true
}

export function parseTime(time: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return { h: 21, m: 0 }
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) }
}

function at(day: Date, h: number, m: number): Date {
  const d = new Date(day)
  d.setHours(h, m, 0, 0)
  return d
}

function lastDayOfMonth(y: number, mo: number): number {
  return new Date(y, mo + 1, 0).getDate()
}

/** The first scheduled moment strictly after `after` (epoch ms), or null for manual. */
export function computeNextRun(s: Schedule, after: number): number | null {
  const { h, m } = parseTime(s.time)
  const from = new Date(after)

  switch (s.kind) {
    case 'manual':
      return null

    case 'hourly': {
      const step = Math.max(1, Math.min(24, Math.round(s.everyHours || 1)))
      // anchor on yesterday's HH:MM and walk forward in N-hour steps; re-anchor
      // each day so "every 5 h from 21:00" doesn't drift by a day's remainder
      const day = new Date(from)
      day.setDate(day.getDate() - 1)
      for (let d = 0; d < 3; d++) {
        const anchor = at(day, h, m)
        for (let k = 0; k * step < 24; k++) {
          const t = new Date(anchor)
          t.setHours(anchor.getHours() + k * step)
          if (t.getTime() > after) return t.getTime()
        }
        day.setDate(day.getDate() + 1)
      }
      return after + step * 3600_000
    }

    case 'daily': {
      const t = at(from, h, m)
      if (t.getTime() > after) return t.getTime()
      t.setDate(t.getDate() + 1)
      return at(t, h, m).getTime()
    }

    case 'weekly': {
      const days = s.weekdays.length ? s.weekdays : [1]
      const day = new Date(from)
      for (let i = 0; i < 8; i++) {
        const t = at(day, h, m)
        if (days.includes(t.getDay()) && t.getTime() > after) return t.getTime()
        day.setDate(day.getDate() + 1)
      }
      return null
    }

    case 'monthly': {
      const want = Math.max(1, Math.min(31, Math.round(s.monthDay || 1)))
      for (let i = 0; i < 3; i++) {
        const y = from.getFullYear()
        const mo = from.getMonth() + i
        const d = new Date(y, mo, 1)
        d.setDate(Math.min(want, lastDayOfMonth(d.getFullYear(), d.getMonth())))
        const t = at(d, h, m)
        if (t.getTime() > after) return t.getTime()
      }
      return null
    }
  }
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmt12(time: string): string {
  const { h, m } = parseTime(time)
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/** Human summary, e.g. "Daily at 9:00 PM", "Mon, Wed, Fri at 9:00 PM". */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'manual':
      return 'Manual only'
    case 'hourly':
      return `Every ${s.everyHours} hour${s.everyHours === 1 ? '' : 's'} (from ${fmt12(s.time)})`
    case 'daily':
      return `Daily at ${fmt12(s.time)}`
    case 'weekly': {
      const days = [...s.weekdays].sort((a, b) => a - b)
      const label =
        days.length === 7
          ? 'Every day'
          : days.join() === '1,2,3,4,5'
            ? 'Weekdays'
            : days.join() === '0,6'
              ? 'Weekends'
              : days.map((d) => WEEKDAY[d]).join(', ')
      return `${label} at ${fmt12(s.time)}`
    }
    case 'monthly':
      return `Monthly on the ${ordinal(s.monthDay)} at ${fmt12(s.time)}`
  }
}

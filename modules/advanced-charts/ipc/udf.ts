/**
 * TradingView resolution -> Massive aggregate mapping (pure, ported from
 * lib/chart/udf.ts with its unit-tested behavior): "60" is 1 hour, "240" is
 * 4 hours, "1D"/"1W"/"1M" are day/week/month, bare numbers are minutes.
 */

export interface MassiveRange {
  mult: number
  timespan: 'minute' | 'hour' | 'day' | 'week' | 'month'
}

export const SUPPORTED_RESOLUTIONS = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'] as const

export function resolutionToMassive(resolution: string): MassiveRange {
  const r = resolution.toUpperCase().trim()
  if (r === '1D' || r === 'D') return { mult: 1, timespan: 'day' }
  if (r === '1W' || r === 'W') return { mult: 1, timespan: 'week' }
  if (r === '1M') return { mult: 1, timespan: 'month' }
  const n = Number(r)
  if (Number.isFinite(n) && n > 0) {
    if (n % 60 === 0) return { mult: n / 60, timespan: 'hour' }
    return { mult: n, timespan: 'minute' }
  }
  return { mult: 1, timespan: 'day' }
}

/**
 * Subscription cadence math (pure — shared by main's recurrence pass, the MCP
 * subscriptions tool and the renderer's Subscriptions tab).
 */

export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const DAY = 86_400_000

export interface Cadence {
  label: 'weekly' | 'monthly' | 'quarterly' | 'annual' | null
  /** estimated cost per month for this charge stream */
  monthly: number
}

/**
 * Estimate the cadence + monthly cost of a charge stream. `msDates` are the
 * charge timestamps, `amounts` their (positive) amounts. With <2 charges we
 * can't measure a gap, so assume monthly at the median amount.
 */
export function estimateCadence(msDates: number[], amounts: number[]): Cadence {
  const amt = median(amounts)
  const days = [...new Set(msDates)].sort((a, b) => a - b)
  if (days.length < 2) return { label: null, monthly: amt }
  const gaps: number[] = []
  for (let i = 1; i < days.length; i++) gaps.push((days[i] - days[i - 1]) / DAY)
  const g = median(gaps)
  if (g >= 6 && g <= 8) return { label: 'weekly', monthly: amt * 4.33 }
  if (g >= 25 && g <= 36) return { label: 'monthly', monthly: amt }
  if (g >= 80 && g <= 100) return { label: 'quarterly', monthly: amt / 3 }
  if (g >= 330 && g <= 400) return { label: 'annual', monthly: amt / 12 }
  return { label: null, monthly: amt }
}

/**
 * Does this merchant's charge stream LOOK like a subscription? ≥2 charges of
 * similar size on a regular weekly/monthly/quarterly/annual gap.
 */
export function looksRecurring(msDates: number[], amounts: number[]): boolean {
  if (amounts.length < 2) return false
  const m = median(amounts)
  const spreadOk = Math.max(...amounts) - Math.min(...amounts) <= Math.max(2, m * 0.15)
  if (!spreadOk) return false
  return estimateCadence(msDates, amounts).label !== null
}

import type { Language, Severity } from '../shared/types'
import { SEVERITY_RANK } from '../shared/types'

// Data-viz colors kept as fixed hex (mid-tone so they read on both the light
// and dark WICKED themes; UI chrome uses the shell's theme tokens instead).
export const LANG_META: Record<Language, { label: string; color: string }> = {
  javascript: { label: 'JavaScript', color: '#eab308' },
  typescript: { label: 'TypeScript', color: '#3b82f6' },
  python: { label: 'Python', color: '#22c55e' },
  csharp: { label: 'C#', color: '#a855f7' },
  php: { label: 'PHP', color: '#818cf8' },
  go: { label: 'Go', color: '#06b6d4' },
  config: { label: 'Config', color: '#94a3b8' },
  markdown: { label: 'Markdown', color: '#64748b' },
  other: { label: 'Other', color: '#64748b' }
}

/**
 * Severity colors. `bg`/`color` are a self-contained badge pair (dark chip,
 * pastel text — works on both themes because both values are set together).
 * `text` is a mid-tone for standalone colored text/nodes on themed backgrounds.
 */
export const SEVERITY_META: Record<
  Severity,
  { label: string; color: string; bg: string; text: string }
> = {
  critical: { label: 'Critical', color: '#fda4af', bg: '#881337', text: '#f43f5e' },
  high: { label: 'High', color: '#fdba74', bg: '#7c2d12', text: '#f97316' },
  medium: { label: 'Medium', color: '#fde68a', bg: '#713f12', text: '#d97706' },
  low: { label: 'Low', color: '#bae6fd', bg: '#0c4a6e', text: '#0ea5e9' }
}

export function complexityColor(score: number): string {
  if (score <= 3) return '#10b981'
  if (score <= 5) return '#f59e0b'
  if (score <= 7) return '#f97316'
  return '#ef4444'
}

export function issueColor(count: number, maxSeverity?: Severity): string {
  if (count === 0) return '#64748b'
  return SEVERITY_META[maxSeverity ?? 'low'].text
}

export function maxSeverityOf(a?: Severity, b?: Severity): Severity | undefined {
  if (!a) return b
  if (!b) return a
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

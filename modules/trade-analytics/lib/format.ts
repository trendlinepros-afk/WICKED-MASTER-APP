/** Shared formatters (pure). */

export function money(n: number, cents = true): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const s = abs.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0
  })
  return `${n < 0 ? '-' : ''}$${s}`
}

export function signedMoney(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function num(n: number): string {
  return n.toLocaleString('en-US')
}

export function shares(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export function duration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = seconds / 60
  if (m < 60) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 24) return `${h.toFixed(1)}h`
  const d = h / 24
  return `${d.toFixed(1)}d`
}

export function dateTime(at: number | null): string {
  if (at == null) return '—'
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function dateShort(at: number | null): string {
  if (at == null) return '—'
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

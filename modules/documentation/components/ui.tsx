import type { ReactNode } from 'react'
import * as Icons from 'lucide-react'
import type { LucideProps } from 'lucide-react'

/* --------------------------------- styles --------------------------------- */

export const btn =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink hover:bg-raised/70 disabled:cursor-not-allowed disabled:opacity-50'
export const btnAccent =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
export const btnDanger = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
export const btnSm = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-raised px-2 py-1 text-xs text-ink hover:bg-raised/70 disabled:opacity-50'
export const iconBtn = 'rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink disabled:opacity-40'
export const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-60'
export const inputSm = 'rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none'
export const card = 'rounded-xl border border-edge bg-surface'
export const label = 'mb-1 block text-xs font-medium text-muted'

/* --------------------------------- format --------------------------------- */

export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtYmd(ymd: string | undefined | null): string {
  if (!ymd) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return ymd
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

/** days until a YYYY-MM-DD date (negative = past) */
export function daysUntil(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((t - today) / 86_400_000)
}

export function expiryTone(days: number | null): 'ok' | 'warn' | 'danger' | null {
  if (days == null) return null
  if (days < 0) return 'danger'
  if (days <= 30) return 'warn'
  return 'ok'
}

/* -------------------------------- widgets -------------------------------- */

/** lucide icon by PascalCase name (falls back to a generic file icon). */
export function TypeIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }): React.JSX.Element {
  const C = ((Icons as unknown as Record<string, React.ComponentType<LucideProps>>)[name] ?? Icons.FileText) as React.ComponentType<LucideProps>
  return <C size={size} className={className} />
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-edge'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

export function Modal({ title, children, onClose, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-2xl ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' }): React.JSX.Element {
  const cls = {
    muted: 'bg-raised text-muted',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    accent: 'bg-accent/15 text-accent'
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">{icon}</div>
      <div className="text-sm font-semibold text-ink">{title}</div>
      {body && <p className="max-w-md text-sm text-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** Password strength for the lock screen (rough, offline). */
export function strengthOf(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!pw) return { score: 0, label: '' }
  let pool = 0
  if (/[a-z]/.test(pw)) pool += 26
  if (/[A-Z]/.test(pw)) pool += 26
  if (/[0-9]/.test(pw)) pool += 10
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33
  const bits = pw.length * Math.log2(pool || 10)
  if (bits < 20) return { score: 1, label: 'Very weak — a 4-digit PIN can be guessed in minutes if someone copies the file' }
  if (bits < 36) return { score: 2, label: 'Weak' }
  if (bits < 52) return { score: 3, label: 'Good' }
  return { score: 4, label: 'Strong' }
}

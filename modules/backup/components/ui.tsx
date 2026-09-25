import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, XCircle } from 'lucide-react'
import type { JobProgress, RunStatus } from '../types'

/* --------------------------------- format --------------------------------- */

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}

export function fmtCount(n: number): string {
  return n.toLocaleString()
}

export function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtShort(ms: number | null | undefined): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today ${t}`
  const y = new Date(today)
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`
  const tm = new Date(today)
  tm.setDate(tm.getDate() + 1)
  if (d.toDateString() === tm.toDateString()) return `Tomorrow ${t}`
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Middle-ellipsis for long paths. */
export function midTrunc(s: string, max = 80): string {
  if (s.length <= max) return s
  const half = Math.floor((max - 1) / 2)
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`
}

/* --------------------------------- styles --------------------------------- */

export const btn =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink hover:bg-raised/70 disabled:cursor-not-allowed disabled:opacity-50'
export const btnAccent =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
export const btnDanger =
  'inline-flex items-center justify-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
export const iconBtn = 'rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink disabled:opacity-40'
export const input =
  'w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none'
export const inputSm =
  'rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none'
export const card = 'rounded-xl border border-edge bg-surface'

/* -------------------------------- widgets -------------------------------- */

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

export function StatusIcon({ status, size = 16 }: { status: RunStatus | 'running' | null; size?: number }): React.JSX.Element {
  switch (status) {
    case 'success':
      return <CheckCircle2 size={size} className="shrink-0 text-ok" />
    case 'warning':
      return <AlertTriangle size={size} className="shrink-0 text-warn" />
    case 'failed':
      return <XCircle size={size} className="shrink-0 text-danger" />
    case 'cancelled':
      return <CircleSlash size={size} className="shrink-0 text-muted" />
    case 'running':
      return <Loader2 size={size} className="shrink-0 animate-spin text-accent" />
    default:
      return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-edge" />
  }
}

export function statusLabel(s: RunStatus): string {
  return s === 'success' ? 'Succeeded' : s === 'warning' ? 'Completed with warnings' : s === 'failed' ? 'Failed' : 'Cancelled'
}

export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }): React.JSX.Element {
  return (
    <section className={`${card} p-5`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Bar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, value * 100))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
      <div className={`h-full rounded-full transition-[width] duration-300 ${tone === 'ok' ? 'bg-ok' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const PHASE: Record<JobProgress['phase'], string> = {
  queued: 'Queued',
  connecting: 'Connecting',
  scanning: 'Scanning',
  copying: 'Copying',
  verifying: 'Validating',
  cleanup: 'Cleaning up',
  cloud: 'Google Drive',
  done: 'Finishing'
}

/** Live progress for the running job. */
export function JobProgressView({ p, onCancel }: { p: JobProgress; onCancel: () => void }): React.JSX.Element {
  const cloud = p.phase === 'cloud'
  const done = cloud ? p.cloudBytesDone : p.bytesDone
  const total = cloud ? p.cloudBytesTotal : p.bytesTotal
  const frac = total > 0 ? done / total : p.filesTotal > 0 ? p.filesDone / p.filesTotal : 0
  const elapsed = Date.now() - p.startedAt
  const rate = elapsed > 2000 && done > 0 ? done / (elapsed / 1000) : 0
  const eta = rate > 0 && total > done ? ((total - done) / rate) * 1000 : 0
  const title =
    p.kind === 'restore' ? 'Restoring' : p.kind === 'validate' ? 'Validating' : p.kind === 'cloud' ? 'Copying to Google Drive' : 'Backing up'
  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 p-4">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold text-ink">{title}</span>
            <span className="text-muted">· {PHASE[p.phase]}</span>
            {p.message && <span className="truncate text-muted">— {p.message}</span>}
          </div>
        </div>
        <button className={btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="mt-3">
        <Bar value={p.phase === 'scanning' || p.phase === 'connecting' ? 0 : frac} />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span>
          {p.phase === 'scanning'
            ? `${fmtCount(p.scanned)} files found`
            : cloud
              ? `${fmtBytes(done)} of ${fmtBytes(total)}`
              : `${fmtCount(p.filesDone)} of ${fmtCount(p.filesTotal)} files · ${fmtBytes(done)} of ${fmtBytes(total)}`}
        </span>
        <span>
          {rate > 0 && `${fmtBytes(rate)}/s`}
          {eta > 0 && ` · ~${fmtDuration(eta)} left`}
          {` · ${fmtDuration(elapsed)} elapsed`}
        </span>
      </div>
      {p.current && <div className="mt-1 truncate font-mono text-[11px] text-muted/80">{midTrunc(p.current, 120)}</div>}
    </div>
  )
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }): React.JSX.Element {
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

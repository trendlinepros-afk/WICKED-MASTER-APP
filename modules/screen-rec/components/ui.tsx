import { useEffect, useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
import { inv } from '../store'
import { prettyAccelerator } from '../lib/hotkey'

export const btn = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink hover:bg-raised/70 disabled:cursor-not-allowed disabled:opacity-50'
export const btnAccent = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
export const btnDanger = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
export const btnSm = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-raised px-2 py-1 text-xs text-ink hover:bg-raised/70 disabled:opacity-50'
export const btnIcon = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink disabled:opacity-40'
export const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-60'
export const card = 'rounded-xl border border-edge bg-surface'
export const label = 'mb-1 block text-xs font-medium text-muted'

export function Keys({ accel, big }: { accel: string; big?: boolean }): React.JSX.Element {
  const parts = prettyAccelerator(accel).split('+')
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {parts.map((p, i) => (
        <kbd key={i} className={`rounded-md border border-edge border-b-2 bg-raised font-semibold text-ink ${big ? 'px-2.5 py-1 text-base' : 'px-1.5 py-0.5 text-xs'}`}>
          {p}
        </kbd>
      ))}
    </span>
  )
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void }): React.JSX.Element {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg bg-raised p-1">
      {options.map((o) => (
        <button
          key={String(o.id)}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-3 py-1.5 text-sm ${value === o.id ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label: text, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={`flex items-start justify-between gap-4 py-2 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className="min-w-0">
        <span className="block text-sm text-ink">{text}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-edge'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </label>
  )
}

export function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm text-ink">{title}</div>
        {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Section({ icon, title, sub, children, right }: { icon: ReactNode; title: string; sub?: ReactNode; children: ReactNode; right?: ReactNode }): React.JSX.Element {
  return (
    <section className={`${card} p-5`}>
      <div className="mb-3 flex items-start gap-3">
        <span className="mt-0.5 text-accent">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function DbSlider({ value, min, max, step = 0.5, onChange, onCommit }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void }): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        className="h-1.5 w-full cursor-pointer accent-accent"
      />
      <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">{value > 0 ? '+' : value < 0 ? '−' : ''}{Math.abs(value).toFixed(value % 1 ? 1 : 0)} dB</span>
    </div>
  )
}

const thumbCache = new Map<string, string>()
export function ClipThumb({ id, thumb, className = '' }: { id: string; thumb: string; className?: string }): React.JSX.Element {
  const key = `${id}|${thumb}`
  const [url, setUrl] = useState<string | null>(thumbCache.get(key) ?? null)
  useEffect(() => {
    if (!thumb) return setUrl(null)
    const hit = thumbCache.get(key)
    if (hit) return setUrl(hit)
    let alive = true
    void (inv('clip-thumb', id) as Promise<{ ok: boolean; dataUrl?: string }>).then((r) => {
      if (!alive || !r.ok || !r.dataUrl) return
      thumbCache.set(key, r.dataUrl)
      setUrl(r.dataUrl)
    })
    return () => {
      alive = false
    }
  }, [id, thumb, key])
  return (
    <div className={`relative aspect-video overflow-hidden bg-black/40 ${className}`}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted/50">
          <ImageOff size={18} />
        </div>
      )}
    </div>
  )
}

export function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return time
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

export function Modal({ title, children, onClose, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className={`max-h-[94vh] w-full overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-2xl ${wide ? 'max-w-5xl' : 'max-w-lg'}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-base font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}

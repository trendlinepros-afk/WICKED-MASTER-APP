import { useEffect, useState, type ReactNode } from 'react'
import { ImageOff } from 'lucide-react'
import { inv } from '../store'

export const btn = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink hover:bg-raised/70 disabled:cursor-not-allowed disabled:opacity-50'
export const btnAccent = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50'
export const btnDanger = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
export const btnSm = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-raised px-2 py-1 text-xs text-ink hover:bg-raised/70 disabled:opacity-50'
export const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none disabled:opacity-60'
export const inputSm = 'rounded-md border border-edge bg-bg px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none'
export const card = 'rounded-xl border border-edge bg-surface'
export const label = 'mb-1 block text-xs font-medium text-muted'

export function fmtAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  const d = Math.round(s / 86400)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const previewCache = new Map<string, string>()

/** data URL for a local image file (cached; main reads the file). */
export function usePreview(path: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(path ? (previewCache.get(path) ?? null) : null)
  useEffect(() => {
    if (!path) return setUrl(null)
    const hit = previewCache.get(path)
    if (hit) return setUrl(hit)
    let alive = true
    void (inv('preview', { path }) as Promise<{ ok: boolean; dataUrl?: string }>).then((r) => {
      if (!alive) return
      if (r.ok && r.dataUrl) {
        previewCache.set(path, r.dataUrl)
        setUrl(r.dataUrl)
      } else setUrl(null)
    })
    return () => {
      alive = false
    }
  }, [path])
  return url
}

/** For a YouTube watch / youtu.be / shorts link, the public thumbnail image URL (so the source card can show a picture). */
export function ytPreview(url?: string): string | undefined {
  if (!url) return undefined
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(url)
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : undefined
}

const remoteCache = new Map<string, string>()
const isWeb = (u?: string): u is string => !!u && /^https?:\/\//i.test(u)

/**
 * data URL for a web image (YouTube thumbnail, pasted link). The shell's CSP
 * blocks remote <img> sources, so main downloads + shrinks it (cached both sides).
 */
export function useRemotePreview(url: string | undefined): { src: string | null; loading: boolean; error: string } {
  const [st, setSt] = useState<{ src: string | null; loading: boolean; error: string }>(() => ({ src: url ? (remoteCache.get(url) ?? null) : null, loading: false, error: '' }))
  useEffect(() => {
    if (!isWeb(url)) return setSt({ src: null, loading: false, error: '' })
    const hit = remoteCache.get(url)
    if (hit) return setSt({ src: hit, loading: false, error: '' })
    let alive = true
    setSt({ src: null, loading: true, error: '' })
    void (inv('remote-preview', { url }) as Promise<{ ok: boolean; dataUrl?: string; error?: string }>).then(
      (r) => {
        if (!alive) return
        if (r.ok && r.dataUrl) {
          remoteCache.set(url, r.dataUrl)
          setSt({ src: r.dataUrl, loading: false, error: '' })
        } else setSt({ src: null, loading: false, error: r.error ?? 'Couldn’t load the image' })
      },
      (err: unknown) => alive && setSt({ src: null, loading: false, error: String(err) })
    )
    return () => {
      alive = false
    }
  }, [url])
  return st
}

/** Thumbnail box that takes either a local path or a URL (web or data:), at a fixed aspect. */
export function Thumb({ path, url, alt, aspect = '16/9', className = '' }: { path?: string; url?: string; alt?: string; aspect?: string; className?: string }): React.JSX.Element {
  const local = usePreview(path)
  const web = !local && isWeb(url)
  const remote = useRemotePreview(web ? url : undefined)
  const src = local ?? (web ? remote.src : url) ?? null
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  return (
    <div className={`relative overflow-hidden rounded-lg bg-black/30 ${className}`} style={{ aspectRatio: aspect }}>
      {src && !broken ? (
        <img src={src} alt={alt ?? ''} onError={() => setBroken(true)} className="h-full w-full object-cover" draggable={false} />
      ) : web && remote.loading ? (
        <div className="h-full w-full animate-pulse bg-raised/60" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted/60" title={remote.error || undefined}>
          <ImageOff size={18} />
        </div>
      )}
    </div>
  )
}

export function Modal({ title, children, onClose, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className={`max-h-[92vh] w-full overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-2xl ${wide ? 'max-w-4xl' : 'max-w-lg'}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-base font-semibold text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' }): React.JSX.Element {
  const cls = { muted: 'bg-raised text-muted', ok: 'bg-ok/15 text-ok', warn: 'bg-warn/15 text-warn', danger: 'bg-danger/15 text-danger', accent: 'bg-accent/15 text-accent' }[tone]
  return <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
}

export function Segmented<T extends string>({ value, options, onChange, disabledReason }: { value: T; options: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void; disabledReason?: (id: T) => string | null }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-raised p-1">
      {options.map((o) => {
        const why = disabledReason?.(o.id) ?? null
        return (
          <button
            key={o.id}
            type="button"
            title={why ?? o.hint}
            disabled={!!why}
            onClick={() => onChange(o.id)}
            className={`rounded-md px-3 py-1.5 text-sm ${value === o.id ? 'bg-surface font-semibold text-ink shadow-sm' : why ? 'text-muted/40' : 'text-muted hover:text-ink'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

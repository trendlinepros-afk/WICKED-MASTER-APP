import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, Dice5, Eye, EyeOff, LoaderCircle, RefreshCw, Search, Timer, X } from 'lucide-react'
import type { AssetType, FieldDef, FieldValue, RecordSummary, SecretPlaceholder } from '../types'
import { inv, useDocs } from '../store'
import { btnSm, input, inputSm, TypeIcon } from './ui'

export const isPlaceholder = (v: unknown): v is SecretPlaceholder => !!v && typeof v === 'object' && (v as SecretPlaceholder).__secret === true

/* -------------------------------- markdown -------------------------------- */

export function Markdown({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  return (
    <div className={`doc-md text-sm leading-relaxed text-ink ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) void inv('open-url', href)
              }}
              className="text-accent underline decoration-accent/40 hover:decoration-accent"
            >
              {children}
            </a>
          ),
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-lg font-bold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1.5 mt-4 text-base font-bold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-bold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
          blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-accent/50 pl-3 text-muted">{children}</blockquote>,
          code: ({ children, className: cls }) =>
            cls ? (
              <code className="font-mono text-[12px]">{children}</code>
            ) : (
              <code className="rounded bg-raised px-1 py-0.5 font-mono text-[12px]">{children}</code>
            ),
          pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-lg border border-edge bg-bg p-3 font-mono text-[12px]">{children}</pre>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-edge bg-raised px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-edge px-2 py-1 align-top">{children}</td>,
          hr: () => <hr className="my-3 border-edge" />,
          input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly className="mr-1 align-middle" />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/* ------------------------------ secret (detail) ----------------------------- */

/** Reveal / copy / one-time code for a stored secret. Values come from main on demand and are logged. */
export function SecretView({ recordId, field, set }: { recordId: string; field: FieldDef; set: boolean }): React.JSX.Element {
  const showToast = useDocs((s) => s.showToast)
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [totp, setTotp] = useState<{ code: string; secondsLeft: number; period: number } | null>(null)

  // rolling TOTP: fetch, count down locally, refetch on rollover
  useEffect(() => {
    if (field.kind !== 'totp' || !set) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const fetchCode = async (): Promise<void> => {
      const r = (await inv('totp', { id: recordId, key: field.key })) as { ok: boolean; code?: string; secondsLeft?: number; period?: number; error?: string }
      if (!alive) return
      if (r.ok && r.code) {
        setTotp({ code: r.code, secondsLeft: r.secondsLeft ?? 30, period: r.period ?? 30 })
        timer = setTimeout(() => void fetchCode(), (r.secondsLeft ?? 30) * 1000 + 200)
      } else setTotp(null)
    }
    void fetchCode()
    const tick = setInterval(() => setTotp((t) => (t && t.secondsLeft > 1 ? { ...t, secondsLeft: t.secondsLeft - 1 } : t)), 1000)
    return () => {
      alive = false
      clearInterval(tick)
      if (timer) clearTimeout(timer)
    }
  }, [recordId, field.key, field.kind, set])

  if (!set) return <span className="text-muted">—</span>

  const reveal = async (): Promise<void> => {
    if (value !== null) return setValue(null)
    setBusy(true)
    const r = (await inv('reveal', { id: recordId, key: field.key })) as { ok: boolean; value?: string; error?: string }
    setBusy(false)
    if (r.ok) setValue(r.value ?? '')
    else showToast('err', r.error ?? 'Could not reveal')
  }
  const copy = async (asCode = false): Promise<void> => {
    const r = (await inv('copy', { id: recordId, key: field.key, totp: asCode })) as { ok: boolean; clearsIn?: number; error?: string }
    if (!r.ok) return showToast('err', r.error ?? 'Could not copy')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    showToast('ok', r.clearsIn ? `Copied — the clipboard clears in ${r.clearsIn}s` : 'Copied to the clipboard')
  }

  if (field.kind === 'totp')
    return (
      <div className="flex flex-wrap items-center gap-2">
        {totp ? (
          <>
            <span className="font-mono text-lg font-semibold tracking-[0.2em] text-ink">{totp.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</span>
            <span className="relative flex h-6 w-6 items-center justify-center" title={`${totp.secondsLeft}s left`}>
              <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90">
                <circle cx="12" cy="12" r="9" fill="none" stroke="rgb(var(--wk-edge))" strokeWidth="3" />
                <circle cx="12" cy="12" r="9" fill="none" stroke={totp.secondsLeft <= 5 ? 'rgb(var(--wk-danger))' : 'rgb(var(--wk-accent))'} strokeWidth="3" strokeDasharray={`${(totp.secondsLeft / totp.period) * 56.5} 56.5`} />
              </svg>
              <span className="text-[9px] tabular-nums text-muted">{totp.secondsLeft}</span>
            </span>
            <button className={btnSm} onClick={() => void copy(true)}>
              {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />} Copy code
            </button>
          </>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted">
            <Timer size={13} /> Secret stored — code unavailable (invalid secret?)
          </span>
        )}
        <button className={btnSm} onClick={() => void reveal()} title="Show the setup secret">
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : value !== null ? <EyeOff size={12} /> : <Eye size={12} />} {value !== null ? 'Hide secret' : 'Secret'}
        </button>
        {value !== null && <code className="break-all rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{value}</code>}
      </div>
    )

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`break-all font-mono text-[13px] ${value === null ? 'tracking-[0.15em] text-muted' : 'select-all text-ink'}`}>{value === null ? '••••••••••••' : value || '(empty)'}</span>
      <button className={btnSm} onClick={() => void reveal()}>
        {busy ? <LoaderCircle size={12} className="animate-spin" /> : value !== null ? <EyeOff size={12} /> : <Eye size={12} />} {value !== null ? 'Hide' : 'Reveal'}
      </button>
      <button className={btnSm} onClick={() => void copy()}>
        {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />} Copy
      </button>
    </div>
  )
}

/* ------------------------------ secret (editor) ----------------------------- */

function GeneratorMenu({ onPick, onClose }: { onPick: (v: string) => void; onClose: () => void }): React.JSX.Element {
  const [len, setLen] = useState(20)
  const [symbols, setSymbols] = useState(true)
  const [preview, setPreview] = useState('')
  const gen = async (passphrase = false): Promise<void> => {
    const r = (await inv('generate-password', { length: len, symbols, passphrase, words: 4 })) as { value?: string }
    setPreview(r.value ?? '')
  }
  useEffect(() => {
    void gen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [len, symbols])
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-xl border border-edge bg-surface p-3 shadow-xl">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-raised px-2 py-1.5 font-mono text-xs text-ink">{preview || '…'}</code>
          <button className={btnSm} onClick={() => void gen()} title="Another">
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-muted">
          <label className="flex items-center gap-1">
            Length
            <input type="number" min={8} max={64} value={len} onChange={(e) => setLen(Math.max(8, Math.min(64, Number(e.target.value) || 20)))} className={`${inputSm} w-14`} />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} /> Symbols
          </label>
          <button className="ml-auto text-accent hover:underline" onClick={() => void gen(true)}>
            Passphrase
          </button>
        </div>
        <button
          className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90"
          onClick={() => {
            onPick(preview)
            onClose()
          }}
        >
          Use this
        </button>
      </div>
    </>
  )
}

/** Editor input for password/totp kinds. Value is a plain string (new) or a placeholder (stored, unchanged). */
export function SecretInput({ field, value, onChange }: { field: FieldDef; value: FieldValue; onChange: (v: string | SecretPlaceholder) => void }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const [gen, setGen] = useState(false)
  const stored = isPlaceholder(value) && value.set
  if (stored)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-edge bg-bg px-3 py-2 text-sm">
        <span className="font-mono tracking-[0.15em] text-muted">••••••••••••</span>
        <span className="text-xs text-muted">stored — unchanged</span>
        <button className={`${btnSm} ml-auto`} onClick={() => onChange('')}>
          Replace
        </button>
      </div>
    )
  const text = typeof value === 'string' ? value : ''
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder={field.kind === 'totp' ? 'Base32 setup key or otpauth:// link' : ''}
        className={`${input} pr-20 font-mono`}
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
        <button type="button" onClick={() => setShow((v) => !v)} className="rounded-md p-1 text-muted hover:text-ink" title={show ? 'Hide' : 'Show'}>
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        {field.kind === 'password' && (
          <div className="relative">
            <button type="button" onClick={() => setGen((v) => !v)} className="rounded-md p-1 text-muted hover:text-ink" title="Generate a password">
              <Dice5 size={15} />
            </button>
            {gen && <GeneratorMenu onPick={onChange} onClose={() => setGen(false)} />}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------ relation picker ----------------------------- */

export function RelationPicker({
  field,
  value,
  names,
  types,
  onChange,
  excludeId
}: {
  field: FieldDef
  value: string[]
  names: Record<string, { name: string; type: string }>
  types: AssetType[]
  onChange: (ids: string[], names: Record<string, { name: string; type: string }>) => void
  excludeId?: string
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<RecordSummary[]>([])
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const t = types.find((x) => x.id === field.relationType)

  useEffect(() => {
    if (!open) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setBusy(true)
      const r = (await inv('relation-search', { q, type: field.relationType, exclude: excludeId })) as { records?: RecordSummary[] }
      setResults((r.records ?? []).filter((x) => !value.includes(x.id)))
      setBusy(false)
    }, 180)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [q, open, field.relationType, excludeId, value])

  return (
    <div className="rounded-lg border border-edge bg-bg px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-xs text-accent">
            {t && <TypeIcon name={t.icon} size={11} />}
            {names[id]?.name ?? '…'}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== id), names)} className="hover:text-danger">
              <X size={11} />
            </button>
          </span>
        ))}
        <div className="relative min-w-[160px] flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={`Add ${t?.name.toLowerCase() ?? 'record'}…`}
            className="w-full bg-transparent py-0.5 text-sm text-ink placeholder:text-muted/60 focus:outline-none"
          />
          {open && (
            <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-72 overflow-y-auto rounded-lg border border-edge bg-surface p-1 shadow-xl">
              {busy && !results.length ? (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
                  <LoaderCircle size={12} className="animate-spin" /> Searching…
                </div>
              ) : results.length ? (
                results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange([...value, r.id], { ...names, [r.id]: { name: r.name, type: r.type } })
                      setQ('')
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-raised"
                  >
                    <Search size={11} className="text-muted" />
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="truncate text-[10px] text-muted">{Object.values(r.preview).filter(Boolean).slice(0, 2).join(' · ')}</span>
                  </button>
                ))
              ) : (
                <div className="px-2 py-2 text-xs text-muted">{q ? 'No matches.' : `No ${t?.namePlural.toLowerCase() ?? 'records'} yet — create one first.`}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ generic editor field ------------------------------ */

export function FieldInput({
  field,
  value,
  onChange,
  names,
  types,
  onNames,
  excludeId
}: {
  field: FieldDef
  value: FieldValue
  onChange: (v: FieldValue) => void
  names: Record<string, { name: string; type: string }>
  types: AssetType[]
  onNames: (n: Record<string, { name: string; type: string }>) => void
  excludeId?: string
}): React.JSX.Element {
  const [preview, setPreview] = useState(false)
  switch (field.kind) {
    case 'password':
    case 'totp':
      return <SecretInput field={field} value={value} onChange={onChange} />
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 py-1.5 text-sm text-ink">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {field.hint || 'Yes'}
        </label>
      )
    case 'select':
      return (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={input}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'number':
      return <input type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} className={input} />
    case 'date':
      return <input type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={input} />
    case 'textarea':
      return <textarea value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} rows={3} className={`${input} resize-y`} />
    case 'markdown':
      return (
        <div className="rounded-lg border border-edge">
          <div className="flex items-center gap-1 border-b border-edge bg-raised/40 px-2 py-1 text-[11px] text-muted">
            <span>Markdown</span>
            <span className="ml-auto" />
            <button type="button" onClick={() => setPreview(false)} className={`rounded px-2 py-0.5 ${!preview ? 'bg-surface text-ink' : 'hover:text-ink'}`}>
              Write
            </button>
            <button type="button" onClick={() => setPreview(true)} className={`rounded px-2 py-0.5 ${preview ? 'bg-surface text-ink' : 'hover:text-ink'}`}>
              Preview
            </button>
          </div>
          {preview ? (
            <div className="max-h-[520px] min-h-[160px] overflow-y-auto px-3 py-2">
              <Markdown text={typeof value === 'string' && value ? value : '_Nothing yet._'} />
            </div>
          ) : (
            <textarea
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value)}
              rows={field.key === 'content' ? 18 : 6}
              spellCheck
              placeholder={field.key === 'content' ? '# Title\n\nWrite the procedure here. **Bold**, lists, `code`, tables and [links](https://…) all work.' : ''}
              className="w-full resize-y rounded-b-lg bg-bg px-3 py-2 font-mono text-[13px] leading-relaxed text-ink placeholder:text-muted/50 focus:outline-none"
            />
          )}
        </div>
      )
    case 'relation':
      return <RelationPicker field={field} value={Array.isArray(value) ? value : []} names={names} types={types} excludeId={excludeId} onChange={(ids, n) => {
        onNames(n)
        onChange(ids)
      }} />
    default:
      return (
        <input
          type={field.kind === 'url' ? 'url' : field.kind === 'email' ? 'email' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.kind === 'ip' ? '10.0.0.1' : field.kind === 'url' ? 'https://' : ''}
          className={`${input} ${field.kind === 'ip' ? 'font-mono' : ''}`}
        />
      )
  }
}

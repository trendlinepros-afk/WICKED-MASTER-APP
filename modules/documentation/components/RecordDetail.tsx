import { useState } from 'react'
import { Archive, ArchiveRestore, ArrowLeft, ChevronRight, ExternalLink, FolderOpen, Globe, Link2, LoaderCircle, Paperclip, Pencil, RefreshCw, ShieldCheck, Star, Trash2, TriangleAlert, X } from 'lucide-react'
import { inv, useDocs, type RecordDetail as Detail } from '../store'
import type { Activity, AssetType, DomainLookup, FieldDef, FieldValue, RecordSummary, SslLookup } from '../types'
import { btn, btnDanger, btnSm, card, daysUntil, expiryTone, fmtAgo, fmtBytes, fmtDateTime, fmtYmd, iconBtn, inputSm, Modal, Pill, TypeIcon } from './ui'
import { isPlaceholder, Markdown, SecretView } from './fields'

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  archive: 'Archived',
  restore: 'Restored',
  reveal: 'Revealed',
  copy: 'Copied',
  lookup: 'Lookup',
  attach: 'Attached'
}

function ActivityRow({ a }: { a: Activity }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-1.5 text-xs">
      <span className="w-28 shrink-0 text-muted" title={fmtDateTime(a.at)}>
        {fmtAgo(a.at)}
      </span>
      <span className="min-w-0 flex-1 text-ink/85">
        <b className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</b>
        {a.detail ? ` — ${a.detail}` : ''}
      </span>
    </div>
  )
}

/* ------------------------------ field display ------------------------------ */

function Value({ f, v, names, go }: { f: FieldDef; v: FieldValue; names: Detail['names']; go: (id: string) => void }): React.JSX.Element {
  if (f.kind === 'relation') {
    const ids = Array.isArray(v) ? v : []
    if (!ids.length) return <span className="text-muted">—</span>
    return (
      <div className="flex flex-wrap gap-1">
        {ids.map((id) => (
          <button key={id} onClick={() => go(id)} className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-xs text-accent hover:bg-accent/20">
            <Link2 size={11} /> {names[id]?.name ?? 'missing record'}
          </button>
        ))}
      </div>
    )
  }
  if (f.kind === 'checkbox') return v === true ? <Pill tone="ok">Yes</Pill> : <span className="text-muted">No</span>
  if (v == null || v === '') return <span className="text-muted">—</span>
  if (f.kind === 'date') {
    const s = String(v)
    const d = daysUntil(s)
    const tone = f.expires ? expiryTone(d) : null
    return (
      <span className="flex items-center gap-2">
        {fmtYmd(s)}
        {tone && d != null && <Pill tone={tone}>{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `${d}d left`}</Pill>}
      </span>
    )
  }
  if (f.kind === 'url') {
    const href = String(v)
    return (
      <button onClick={() => void inv('open-url', /^https?:\/\//i.test(href) ? href : `https://${href}`)} className="inline-flex items-center gap-1 text-accent hover:underline">
        {href} <ExternalLink size={11} />
      </button>
    )
  }
  if (f.kind === 'email') return <span className="select-all">{String(v)}</span>
  if (f.kind === 'ip') return <span className="select-all font-mono">{String(v)}</span>
  if (f.kind === 'textarea') return <span className="whitespace-pre-wrap">{String(v)}</span>
  return <span className="break-words">{String(v)}</span>
}

/* ------------------------------ lookup panels ------------------------------ */

function DomainPanel({ id, fields }: { id: string; fields: Record<string, FieldValue> }): React.JSX.Element {
  const loadDetail = useDocs((s) => s.loadDetail)
  const showToast = useDocs((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  let look: DomainLookup | null = null
  try {
    look = typeof fields._domainLookup === 'string' ? (JSON.parse(fields._domainLookup) as DomainLookup) : null
  } catch {
    look = null
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('lookup-domain', { id })) as { ok: boolean; error?: string; lookup?: DomainLookup }
    setBusy(false)
    if (!r.ok) return showToast('err', r.error ?? 'Lookup failed')
    if (r.lookup?.error) showToast('warn', r.lookup.error)
    else showToast('ok', 'Domain details updated')
    await loadDetail(id)
  }
  const dns = look?.dns
  return (
    <section className={`${card} p-4`}>
      <div className="mb-2 flex items-center gap-2">
        <Globe size={15} className="text-accent" />
        <span className="text-sm font-semibold text-ink">Domain tracker</span>
        <span className="text-xs text-muted">{look ? `checked ${fmtAgo(look.checkedAt)}` : 'not checked yet'}</span>
        <button className={`${btnSm} ml-auto`} disabled={busy} onClick={() => void run()}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check now
        </button>
      </div>
      {!look ? (
        <p className="text-xs text-muted">Pulls the registrar, expiry and status from the registry (RDAP/WHOIS) and reads the live DNS records.</p>
      ) : (
        <div className="space-y-3 text-xs">
          {look.error && (
            <div className="flex items-start gap-1.5 rounded-md bg-warn/10 px-2 py-1.5 text-warn">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {look.error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-4">
            <div>
              <div className="text-muted">Registrar</div>
              <div className="text-ink">{look.registrar || '—'}</div>
            </div>
            <div>
              <div className="text-muted">Expires</div>
              <div className="text-ink">{fmtYmd(look.expires)}</div>
            </div>
            <div>
              <div className="text-muted">Registered</div>
              <div className="text-ink">{fmtYmd(look.registered)}</div>
            </div>
            <div>
              <div className="text-muted">Updated</div>
              <div className="text-ink">{fmtYmd(look.updated)}</div>
            </div>
          </div>
          {look.status.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {look.status.map((st) => (
                <Pill key={st}>{st}</Pill>
              ))}
            </div>
          )}
          {dns && (
            <>
              {dns.hints.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {dns.hints.map((h) => (
                    <Pill key={h} tone="accent">
                      {h}
                    </Pill>
                  ))}
                </div>
              )}
              <div className="overflow-hidden rounded-lg border border-edge">
                {(
                  [
                    ['A', dns.a],
                    ['AAAA', dns.aaaa],
                    ['CNAME', dns.cname],
                    ['MX', dns.mx.map((m) => `${m.priority} ${m.exchange}`)],
                    ['NS', dns.ns.length ? dns.ns : look.nameservers],
                    ['TXT', dns.txt]
                  ] as [string, string[]][]
                )
                  .filter(([, vals]) => vals.length)
                  .map(([k, vals]) => (
                    <div key={k} className="flex gap-3 border-b border-edge/60 px-2 py-1.5 last:border-0">
                      <span className="w-12 shrink-0 font-mono font-semibold text-muted">{k}</span>
                      <div className="min-w-0 flex-1 space-y-0.5 font-mono text-[11px] text-ink/85">
                        {vals.map((val, i) => (
                          <div key={i} className="break-all">
                            {val}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function SslPanel({ id, fields }: { id: string; fields: Record<string, FieldValue> }): React.JSX.Element {
  const loadDetail = useDocs((s) => s.loadDetail)
  const showToast = useDocs((s) => s.showToast)
  const [busy, setBusy] = useState(false)
  let look: SslLookup | null = null
  try {
    look = typeof fields._sslLookup === 'string' ? (JSON.parse(fields._sslLookup) as SslLookup) : null
  } catch {
    look = null
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('lookup-ssl', { id })) as { ok: boolean; error?: string; lookup?: SslLookup }
    setBusy(false)
    if (!r.ok) return showToast('err', r.error ?? 'Check failed')
    if (r.lookup?.error && !r.lookup.validTo) showToast('warn', r.lookup.error)
    else showToast('ok', 'Certificate details updated')
    await loadDetail(id)
  }
  const tone = look ? expiryTone(look.daysLeft) : null
  return (
    <section className={`${card} p-4`}>
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck size={15} className="text-accent" />
        <span className="text-sm font-semibold text-ink">SSL tracker</span>
        <span className="text-xs text-muted">{look ? `checked ${fmtAgo(look.checkedAt)}` : 'not checked yet'}</span>
        <button className={`${btnSm} ml-auto`} disabled={busy} onClick={() => void run()}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check now
        </button>
      </div>
      {!look ? (
        <p className="text-xs text-muted">Connects to the host and records the certificate’s issuer, expiry and whether the chain and name check out.</p>
      ) : (
        <div className="space-y-2 text-xs">
          {look.error && (
            <div className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 ${look.validTo ? 'bg-warn/10 text-warn' : 'bg-danger/10 text-danger'}`}>
              <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {look.error}
            </div>
          )}
          {look.validTo && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 md:grid-cols-4">
              <div>
                <div className="text-muted">Expires</div>
                <div className="flex items-center gap-1.5 text-ink">
                  {fmtYmd(look.validTo)} {tone && <Pill tone={tone}>{look.daysLeft < 0 ? 'expired' : `${look.daysLeft}d`}</Pill>}
                </div>
              </div>
              <div>
                <div className="text-muted">Issued</div>
                <div className="text-ink">{fmtYmd(look.validFrom)}</div>
              </div>
              <div className="col-span-2">
                <div className="text-muted">Issuer</div>
                <div className="text-ink">{look.issuer || '—'}</div>
              </div>
              <div className="col-span-2">
                <div className="text-muted">Subject</div>
                <div className="font-mono text-ink">{look.subject || '—'}</div>
              </div>
              <div className="col-span-2">
                <div className="text-muted">Status</div>
                <div>{look.valid ? <Pill tone="ok">valid — chain trusted, name matches</Pill> : <Pill tone="danger">not valid</Pill>}</div>
              </div>
              {look.altNames.length > 0 && (
                <div className="col-span-4">
                  <div className="text-muted">Also covers</div>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {look.altNames.map((n) => (
                      <Pill key={n}>{n}</Pill>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------- related items ------------------------------ */

function RelatedItems({ d }: { d: Detail }): React.JSX.Element {
  const s = useDocs()
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<RecordSummary[]>([])
  const typeOf = (id: string): AssetType | undefined => s.types.find((t) => t.id === id)
  const search = async (text: string): Promise<void> => {
    setQ(text)
    const r = (await inv('relation-search', { q: text, exclude: d.record.id })) as { records?: RecordSummary[] }
    setResults((r.records ?? []).filter((x) => !d.related.some((y) => y.id === x.id)).slice(0, 12))
  }
  const add = async (id: string): Promise<void> => {
    await inv('relation-add', { a: d.record.id, b: id })
    setAdding(false)
    setQ('')
    await s.loadDetail(d.record.id)
  }
  const remove = async (id: string): Promise<void> => {
    await inv('relation-remove', { a: d.record.id, b: id })
    await s.loadDetail(d.record.id)
  }
  const all = [...d.related.map((r) => ({ ...r, kind: 'related' as const })), ...d.referencedBy.filter((r) => !d.related.some((x) => x.id === r.id)).map((r) => ({ ...r, kind: 'ref' as const }))]
  return (
    <section className={`${card} p-4`}>
      <div className="mb-2 flex items-center gap-2">
        <Link2 size={15} className="text-accent" />
        <span className="text-sm font-semibold text-ink">Related items</span>
        <button
          className={`${btnSm} ml-auto`}
          onClick={() => {
            setAdding((v) => !v)
            if (!adding) void search('')
          }}
        >
          {adding ? <X size={12} /> : <Link2 size={12} />} {adding ? 'Close' : 'Relate…'}
        </button>
      </div>
      {adding && (
        <div className="mb-2">
          <input autoFocus value={q} onChange={(e) => void search(e.target.value)} placeholder="Search any record…" className={`${inputSm} w-full`} />
          <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-edge">
            {results.length ? (
              results.map((r) => {
                const t = typeOf(r.type)
                return (
                  <button key={r.id} onClick={() => void add(r.id)} className="flex w-full items-center gap-2 border-b border-edge/60 px-2 py-1.5 text-left text-xs hover:bg-raised last:border-0">
                    {t && <TypeIcon name={t.icon} size={12} className="text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-ink">{r.name}</span>
                    <span className="text-[10px] text-muted">{t?.name}</span>
                  </button>
                )
              })
            ) : (
              <div className="px-2 py-2 text-xs text-muted">No matches.</div>
            )}
          </div>
        </div>
      )}
      {all.length === 0 ? (
        <p className="text-xs text-muted">Nothing linked yet. Relations also appear automatically when another record points here.</p>
      ) : (
        <div className="space-y-1">
          {all.map((r) => {
            const t = typeOf(r.type)
            return (
              <div key={r.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-raised">
                {t && <TypeIcon name={t.icon} size={13} className="shrink-0 text-muted" />}
                <button onClick={() => s.openRecord(r.id)} className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-accent">
                  {r.name}
                </button>
                <span className="text-[10px] text-muted">{t?.name}</span>
                {r.kind === 'related' && (
                  <button onClick={() => void remove(r.id)} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100" title="Unlink">
                    <X size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Attachments({ d }: { d: Detail }): React.JSX.Element {
  const s = useDocs()
  const [busy, setBusy] = useState(false)
  const attach = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('attach', { recordId: d.record.id })) as { ok: boolean; added?: number; error?: string }
    setBusy(false)
    if (!r.ok) return s.showToast('err', r.error ?? 'Could not attach')
    if (r.added) await s.loadDetail(d.record.id)
  }
  const remove = async (id: string): Promise<void> => {
    await inv('attachment-remove', { id })
    await s.loadDetail(d.record.id)
  }
  return (
    <section className={`${card} p-4`}>
      <div className="mb-2 flex items-center gap-2">
        <Paperclip size={15} className="text-accent" />
        <span className="text-sm font-semibold text-ink">Attachments</span>
        <button className={`${btnSm} ml-auto`} disabled={busy} onClick={() => void attach()}>
          {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Paperclip size={12} />} Attach files…
        </button>
      </div>
      {d.attachments.length === 0 ? (
        <p className="text-xs text-muted">Copies of files (configs, invoices, diagrams) stored with this record.</p>
      ) : (
        <div className="space-y-1">
          {d.attachments.map((a) => (
            <div key={a.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-raised">
              <button onClick={() => void inv('attachment-open', { id: a.id })} className="min-w-0 flex-1 truncate text-left text-xs text-ink hover:text-accent" title="Open">
                {a.name}
              </button>
              <span className="text-[10px] text-muted">{fmtBytes(a.size)}</span>
              <button onClick={() => void inv('attachment-open', { id: a.id, reveal: true })} className="text-muted opacity-0 hover:text-ink group-hover:opacity-100" title="Show in folder">
                <FolderOpen size={12} />
              </button>
              <button onClick={() => void remove(a.id)} className="text-muted opacity-0 hover:text-danger group-hover:opacity-100" title="Remove">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ---------------------------------- page ---------------------------------- */

export default function RecordDetail(): React.JSX.Element {
  const s = useDocs()
  const d = s.detail
  const [confirmDelete, setConfirmDelete] = useState(false)
  if (s.detailLoading && !d)
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted">
        <LoaderCircle size={15} className="animate-spin" /> Loading…
      </div>
    )
  if (!d) return <div className="p-6 text-sm text-danger">{s.error || 'Record not found.'}</div>
  const r = d.record
  const t = s.types.find((x) => x.id === r.type)
  const fields = t?.fields ?? []
  const short = fields.filter((f) => f.kind !== 'markdown')
  const long = fields.filter((f) => f.kind === 'markdown')

  const del = async (): Promise<void> => {
    setConfirmDelete(false)
    if (await s.deleteRecord(r.id)) {
      s.showToast('ok', `Deleted ${r.name}`)
      s.go({ kind: 'list', type: r.type })
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-1 flex items-center gap-1 text-xs text-muted">
          {s.history.length > 0 && (
            <button onClick={s.back} className="mr-1 flex items-center gap-0.5 rounded-md border border-edge px-1.5 py-0.5 hover:text-ink" title="Back">
              <ArrowLeft size={11} /> Back
            </button>
          )}
          <button onClick={() => s.go({ kind: 'list', type: r.type })} className="hover:text-ink">
            {t?.namePlural ?? r.type}
          </button>
          {r.folder && (
            <>
              <ChevronRight size={12} />
              <button onClick={() => s.go({ kind: 'list', type: r.type, folder: r.folder })} className="hover:text-ink">
                {r.folder}
              </button>
            </>
          )}
          <ChevronRight size={12} />
          <span className="truncate text-ink/70">{r.name}</span>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          {t && (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <TypeIcon name={t.icon} size={20} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
              <span className="truncate">{r.name}</span>
              <button onClick={() => void s.flag(r.id, 'favorite', !r.favorite)} className={r.favorite ? 'text-warn' : 'text-muted/40 hover:text-warn'} title="Favorite">
                <Star size={18} fill={r.favorite ? 'currentColor' : 'none'} />
              </button>
              {r.archived && <Pill>archived</Pill>}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                {t?.name} · updated {fmtAgo(r.updatedAt)} · created {fmtDateTime(r.createdAt)}
              </span>
              {r.tags.map((tag) => (
                <Pill key={tag} tone="accent">
                  {tag}
                </Pill>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={() => s.go({ kind: 'edit', type: r.type, id: r.id })}>
              <Pencil size={14} /> Edit
            </button>
            <button className={btn} onClick={() => void s.flag(r.id, 'archived', !r.archived)} title={r.archived ? 'Restore' : 'Archive'}>
              {r.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            </button>
            <button className={`${iconBtn} border border-edge`} onClick={() => setConfirmDelete(true)} title="Delete">
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            {short.length > 0 && (
              <section className={`${card} p-4`}>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                  {short.map((f) => {
                    const v = r.fields[f.key]
                    const secret = f.kind === 'password' || f.kind === 'totp'
                    return (
                      <div key={f.key} className={`min-w-0 ${f.kind === 'textarea' || f.kind === 'relation' || secret ? 'md:col-span-2' : ''}`}>
                        <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">{f.label}</dt>
                        <dd className="mt-0.5 text-sm text-ink">
                          {secret ? <SecretView recordId={r.id} field={f} set={isPlaceholder(v) && v.set} /> : <Value f={f} v={v} names={d.names} go={s.openRecord} />}
                        </dd>
                      </div>
                    )
                  })}
                </dl>
              </section>
            )}
            {r.type === 'domain' && <DomainPanel id={r.id} fields={r.fields} />}
            {r.type === 'ssl' && <SslPanel id={r.id} fields={r.fields} />}
            {long.map((f) => {
              const v = r.fields[f.key]
              const text = typeof v === 'string' ? v : ''
              if (!text.trim() && f.key === 'notes') return null
              return (
                <section key={f.key} className={`${card} p-5`}>
                  {f.key !== 'content' && <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{f.label}</div>}
                  {text.trim() ? <Markdown text={text} /> : <p className="text-sm text-muted">Empty — click Edit to write it.</p>}
                </section>
              )
            })}
          </div>
          <div className="space-y-4">
            <RelatedItems d={d} />
            <Attachments d={d} />
            <section className={`${card} p-4`}>
              <div className="mb-1 text-sm font-semibold text-ink">History</div>
              {d.activity.length ? d.activity.map((a) => <ActivityRow key={a.id} a={a} />) : <p className="text-xs text-muted">No activity yet.</p>}
            </section>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <Modal title={`Delete “${r.name}”?`} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-muted">This permanently removes the record, its relations and {d.attachments.length ? `${d.attachments.length} attachment(s)` : 'any attachments'}. Archiving keeps it around instead.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btn} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className={btn}
              onClick={() => {
                setConfirmDelete(false)
                void s.flag(r.id, 'archived', true)
              }}
            >
              <Archive size={14} /> Archive instead
            </button>
            <button className={btnDanger} onClick={() => void del()}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

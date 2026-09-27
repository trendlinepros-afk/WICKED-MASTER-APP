import { useEffect, useState } from 'react'
import { ArrowRight, CalendarClock, History, Plus, Star, TriangleAlert } from 'lucide-react'
import { inv, useDocs } from '../store'
import type { Activity, RecordSummary } from '../types'
import { SECTIONS } from '../lib/schema'
import { btnSm, card, Empty, expiryTone, fmtAgo, fmtDateTime, fmtYmd, Pill, TypeIcon } from './ui'

const ACTION: Record<string, string> = {
  setup: 'Password set',
  unlock: 'Unlocked',
  lock: 'Locked',
  'password-changed': 'Password changed',
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  archive: 'Archived',
  restore: 'Restored',
  reveal: 'Revealed a secret',
  copy: 'Copied a secret',
  lookup: 'Lookup',
  attach: 'Attached files',
  export: 'Exported'
}

function ActivityLine({ a, onOpen }: { a: Activity; onOpen: (id: string) => void }): React.JSX.Element {
  const types = useDocs((s) => s.types)
  const t = a.recordType ? types.find((x) => x.id === a.recordType) : null
  const secretish = a.action === 'reveal' || a.action === 'copy'
  return (
    <div className="flex items-start gap-3 border-b border-edge/60 py-2 text-sm last:border-0">
      <span className="w-32 shrink-0 text-xs text-muted" title={fmtDateTime(a.at)}>
        {fmtAgo(a.at)}
      </span>
      <span className={`shrink-0 text-xs font-medium ${secretish ? 'text-warn' : a.action === 'delete' ? 'text-danger' : 'text-ink'}`}>{ACTION[a.action] ?? a.action}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted">
        {a.recordId ? (
          <button onClick={() => onOpen(a.recordId!)} className="inline-flex items-center gap-1 text-ink hover:text-accent">
            {t && <TypeIcon name={t.icon} size={11} />} {a.recordName}
          </button>
        ) : (
          a.recordName
        )}
        {a.detail ? <span> — {a.detail}</span> : null}
      </span>
    </div>
  )
}

/* -------------------------------- dashboard -------------------------------- */

export function Dashboard(): React.JSX.Element {
  const s = useDocs()
  const [favs, setFavs] = useState<RecordSummary[]>([])
  useEffect(() => {
    void (inv('records', { favorite: true, archived: false }) as Promise<{ records?: RecordSummary[] }>).then((r) => setFavs((r.records ?? []).slice(0, 8)))
  }, [s.counts.favorites])
  const total = Object.values(s.counts.byType).reduce((a, b) => a + b, 0)
  const visible = s.types.filter((t) => !t.archived && !s.settings.hiddenTypes.includes(t.id))
  const typeOf = (id: string) => s.types.find((t) => t.id === id)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-6">
        <div>
          <h1 className="text-xl font-bold text-ink">Overview</h1>
          <p className="text-sm text-muted">
            {total ? `${total.toLocaleString()} records across ${Object.keys(s.counts.byType).length} asset types.` : 'Nothing documented yet — start with your locations, then the devices and passwords that live there.'}
          </p>
        </div>

        {SECTIONS.map((sec) => {
          const ts = visible.filter((t) => t.section === sec.id)
          if (!ts.length) return null
          return (
            <div key={sec.id}>
              <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{sec.label}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {ts.map((t) => (
                  <button key={t.id} onClick={() => s.go({ kind: 'list', type: t.id })} className={`${card} group flex items-center gap-3 px-3 py-2.5 text-left hover:border-accent/50`}>
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                      <TypeIcon name={t.icon} size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-muted">{t.namePlural}</div>
                      <div className="text-lg font-semibold leading-tight tabular-nums text-ink">{s.counts.byType[t.id] ?? 0}</div>
                    </div>
                    <span
                      onClick={(e) => {
                        e.stopPropagation()
                        s.go({ kind: 'edit', type: t.id })
                      }}
                      className="rounded-md p-1 text-muted opacity-0 hover:bg-raised hover:text-ink group-hover:opacity-100"
                      title={`New ${t.name}`}
                    >
                      <Plus size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <section className={`${card} p-4`}>
            <div className="mb-2 flex items-center gap-2">
              <CalendarClock size={15} className="text-warn" />
              <span className="text-sm font-semibold text-ink">Expiring within 30 days</span>
              <button className={`${btnSm} ml-auto`} onClick={() => s.go({ kind: 'expirations' })}>
                All <ArrowRight size={11} />
              </button>
            </div>
            {s.expirations.length === 0 ? (
              <p className="text-xs text-muted">Nothing due. Domains, SSL certificates, licences, warranties and contracts show up here.</p>
            ) : (
              s.expirations.slice(0, 8).map((e) => {
                const t = typeOf(e.type)
                const tone = expiryTone(e.daysLeft) ?? 'muted'
                return (
                  <button key={`${e.recordId}-${e.fieldKey}`} onClick={() => s.openRecord(e.recordId)} className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-raised">
                    {t && <TypeIcon name={t.icon} size={13} className="shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{e.name}</span>
                    <Pill tone={tone}>{e.daysLeft < 0 ? `${-e.daysLeft}d overdue` : e.daysLeft === 0 ? 'today' : `${e.daysLeft}d`}</Pill>
                  </button>
                )
              })
            )}
          </section>
          <section className={`${card} p-4`}>
            <div className="mb-2 flex items-center gap-2">
              <Star size={15} className="text-warn" />
              <span className="text-sm font-semibold text-ink">Favorites</span>
              <button className={`${btnSm} ml-auto`} onClick={() => s.go({ kind: 'favorites' })}>
                All <ArrowRight size={11} />
              </button>
            </div>
            {favs.length === 0 ? (
              <p className="text-xs text-muted">Star the records you open most — the firewall, the domain admin login, the onboarding doc.</p>
            ) : (
              favs.map((f) => {
                const t = typeOf(f.type)
                return (
                  <button key={f.id} onClick={() => s.openRecord(f.id)} className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-raised">
                    {t && <TypeIcon name={t.icon} size={13} className="shrink-0 text-muted" />}
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{f.name}</span>
                    <span className="text-[10px] text-muted">{t?.name}</span>
                  </button>
                )
              })
            )}
          </section>
          <section className={`${card} p-4`}>
            <div className="mb-2 flex items-center gap-2">
              <History size={15} className="text-accent" />
              <span className="text-sm font-semibold text-ink">Recent activity</span>
              <button className={`${btnSm} ml-auto`} onClick={() => s.go({ kind: 'activity' })}>
                All <ArrowRight size={11} />
              </button>
            </div>
            {s.activity.length === 0 ? (
              <p className="text-xs text-muted">Edits, reveals and lookups are logged here.</p>
            ) : (
              s.activity.slice(0, 8).map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1 text-xs">
                  <span className="w-16 shrink-0 text-muted">{fmtAgo(a.at)}</span>
                  <span className="shrink-0 text-ink/80">{ACTION[a.action] ?? a.action}</span>
                  {a.recordId ? (
                    <button onClick={() => s.openRecord(a.recordId!)} className="min-w-0 flex-1 truncate text-left text-muted hover:text-accent">
                      {a.recordName}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted">{a.recordName || a.detail}</span>
                  )}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------- expirations ------------------------------- */

export function Expirations(): React.JSX.Element {
  const s = useDocs()
  const [days, setDays] = useState(365)
  useEffect(() => {
    void s.loadExpirations(days)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])
  const typeOf = (id: string) => s.types.find((t) => t.id === id)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink">Expirations</h1>
            <p className="text-sm text-muted">Every dated field marked as an expiry — domains, certificates, licences, warranties, contracts.</p>
          </div>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-auto rounded-lg border border-edge bg-bg px-2 py-1.5 text-sm text-ink">
            <option value={30}>Next 30 days</option>
            <option value={90}>Next 90 days</option>
            <option value={365}>Next 12 months</option>
            <option value={3650}>Everything</option>
          </select>
        </div>
        {s.expirations.length === 0 ? (
          <Empty icon={<CalendarClock size={22} />} title="Nothing expiring in this window" body="Add an expiry date to a domain, SSL certificate, licence, warranty or contract and it will show up here." />
        ) : (
          <div className={`${card} divide-y divide-edge/60`}>
            {s.expirations.map((e) => {
              const t = typeOf(e.type)
              const tone = expiryTone(e.daysLeft) ?? 'muted'
              return (
                <button key={`${e.recordId}-${e.fieldKey}`} onClick={() => s.openRecord(e.recordId)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-raised/60">
                  {t && <TypeIcon name={t.icon} size={15} className="shrink-0 text-muted" />}
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{e.name}</span>
                  <span className="hidden text-xs text-muted sm:block">
                    {t?.name} · {e.fieldLabel}
                  </span>
                  <span className="w-28 text-right text-xs text-muted">{fmtYmd(e.date)}</span>
                  <span className="w-24 text-right">
                    <Pill tone={tone}>{e.daysLeft < 0 ? `${-e.daysLeft}d overdue` : e.daysLeft === 0 ? 'today' : `${e.daysLeft}d left`}</Pill>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------------- activity -------------------------------- */

export function ActivityView(): React.JSX.Element {
  const s = useDocs()
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <h1 className="text-xl font-bold text-ink">Recent activity</h1>
        <p className="mb-4 text-sm text-muted">Everything that happened in Documentation — including every time a password was revealed or copied.</p>
        {s.activity.length === 0 ? (
          <Empty icon={<History size={22} />} title="No activity yet" />
        ) : (
          <div className={`${card} px-4`}>
            {s.activity.map((a) => (
              <ActivityLine key={a.id} a={a} onOpen={s.openRecord} />
            ))}
          </div>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
          <TriangleAlert size={12} /> The last 5,000 events are kept.
        </p>
      </div>
    </div>
  )
}

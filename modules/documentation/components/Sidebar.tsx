import { useState } from 'react'
import { Archive, BookLock, CalendarClock, History, LayoutDashboard, Lock, Plus, Search, Settings, Star } from 'lucide-react'
import { useDocs, type View } from '../store'
import { SECTIONS } from '../lib/schema'
import { TypeIcon } from './ui'

function NavItem({ active, onClick, icon, label, count, tone }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number; tone?: 'warn' }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
        active ? 'bg-accent/15 font-medium text-accent' : 'text-ink/85 hover:bg-raised hover:text-ink'
      }`}
    >
      <span className={`shrink-0 ${active ? 'text-accent' : 'text-muted group-hover:text-ink'}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className={`shrink-0 rounded-md px-1.5 text-[10.5px] tabular-nums ${tone === 'warn' ? 'bg-warn/15 text-warn' : active ? 'bg-accent/20 text-accent' : 'bg-raised text-muted'}`}>{count}</span>
      )}
    </button>
  )
}

/** The IT Glue-style organisation sidebar, single-tenant. */
export default function Sidebar(): React.JSX.Element {
  const s = useDocs()
  const [q, setQ] = useState('')
  const [quick, setQuick] = useState(false)
  const v = s.view
  const isView = (kind: View['kind']): boolean => v.kind === kind
  const visible = s.types.filter((t) => !t.archived && !s.settings.hiddenTypes.includes(t.id))

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-surface">
      <div className="flex items-center gap-2 px-3 pb-2 pt-4">
        <BookLock size={19} className="shrink-0 text-accent" />
        <span className="flex-1 truncate text-[15px] font-bold text-ink">Documentation</span>
        <div className="relative">
          <button onClick={() => setQuick((x) => !x)} className="flex items-center rounded-md bg-accent p-1 text-accent-ink hover:opacity-90" title="Quick add">
            <Plus size={15} />
          </button>
          {quick && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setQuick(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 max-h-96 w-56 overflow-y-auto rounded-xl border border-edge bg-surface p-1 shadow-xl">
                {SECTIONS.map((sec) => {
                  const ts = visible.filter((t) => t.section === sec.id)
                  if (!ts.length) return null
                  return (
                    <div key={sec.id}>
                      <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">{sec.label}</div>
                      {ts.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => {
                            setQuick(false)
                            s.go({ kind: 'edit', type: t.id })
                          }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-ink hover:bg-raised"
                        >
                          <TypeIcon name={t.icon} size={13} className="text-muted" /> New {t.name}
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <button onClick={() => void s.lock()} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink" title="Lock now">
          <Lock size={15} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && q.trim()) s.go({ kind: 'search', q: q.trim() })
            }}
            placeholder="Search everything…"
            className="w-full rounded-lg border border-edge bg-bg py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3">
        <div className="space-y-0.5">
          <NavItem active={isView('dashboard')} onClick={() => s.go({ kind: 'dashboard' })} icon={<LayoutDashboard size={15} />} label="Overview" />
          <NavItem active={isView('expirations')} onClick={() => s.go({ kind: 'expirations' })} icon={<CalendarClock size={15} />} label="Expirations" count={s.counts.expiringSoon} tone="warn" />
          <NavItem active={isView('favorites')} onClick={() => s.go({ kind: 'favorites' })} icon={<Star size={15} />} label="Favorites" count={s.counts.favorites} />
          <NavItem active={isView('activity')} onClick={() => s.go({ kind: 'activity' })} icon={<History size={15} />} label="Recent activity" />
        </div>

        {SECTIONS.map((sec) => {
          const ts = visible.filter((t) => t.section === sec.id)
          if (!ts.length) return null
          return (
            <div key={sec.id}>
              <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{sec.label}</div>
              <div className="space-y-0.5">
                {ts.map((t) => (
                  <NavItem
                    key={t.id}
                    active={(v.kind === 'list' || v.kind === 'edit') && v.type === t.id}
                    onClick={() => s.go({ kind: 'list', type: t.id })}
                    icon={<TypeIcon name={t.icon} size={15} />}
                    label={t.namePlural}
                    count={s.counts.byType[t.id] ?? 0}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </nav>

      <div className="space-y-0.5 border-t border-edge p-2">
        <NavItem active={isView('archived')} onClick={() => s.go({ kind: 'archived' })} icon={<Archive size={15} />} label="Archived" count={s.counts.archived} />
        <NavItem active={isView('settings')} onClick={() => s.go({ kind: 'settings', tab: 'types' })} icon={<Settings size={15} />} label="Settings & asset types" />
      </div>
    </aside>
  )
}

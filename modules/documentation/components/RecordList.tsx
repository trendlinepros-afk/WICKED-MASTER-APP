import { useEffect, useState } from 'react'
import { Archive, Folder, LoaderCircle, Plus, Search, Star } from 'lucide-react'
import { inv, useDocs } from '../store'
import type { AssetType, RecordSummary } from '../types'
import { btnAccent, Empty, fmtAgo, Pill, TypeIcon } from './ui'

/** Type list / favorites / archived / search results — one table, columns from the type's schema. */
export default function RecordList(): React.JSX.Element {
  const s = useDocs()
  const v = s.view
  const type: AssetType | null = v.kind === 'list' ? (s.types.find((t) => t.id === v.type) ?? null) : null
  const [folders, setFolders] = useState<string[]>([])
  const isDocs = type?.id === 'document'

  useEffect(() => {
    if (!isDocs || !type) return
    void (inv('folders', { type: type.id }) as Promise<{ folders?: string[] }>).then((r) => setFolders(r.folders ?? []))
  }, [isDocs, type, s.list.length])

  const cols = (type?.fields ?? []).filter((f) => f.showInList).slice(0, 4)
  const mixed = !type // favorites / archived / search show the type column
  const title =
    v.kind === 'favorites' ? 'Favorites' : v.kind === 'archived' ? 'Archived' : v.kind === 'search' ? `Search: “${v.q}”` : (type?.namePlural ?? 'Records')
  const typeOf = (id: string): AssetType | undefined => s.types.find((t) => t.id === id)
  const folder = v.kind === 'list' ? (v.folder ?? '') : ''

  const rows: RecordSummary[] = s.list

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-edge px-6 pb-3 pt-5">
        <div className="flex flex-wrap items-center gap-3">
          {type && (
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <TypeIcon name={type.icon} size={18} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold text-ink">
              {title} <span className="text-sm font-normal text-muted">({rows.length})</span>
            </h1>
            {type?.description && <p className="text-xs text-muted">{type.description}</p>}
          </div>
          {v.kind !== 'search' && (
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={s.listFilter}
                onChange={(e) => s.setListFilter(e.target.value)}
                placeholder="Filter…"
                className="w-56 rounded-lg border border-edge bg-bg py-1.5 pl-8 pr-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
              />
            </div>
          )}
          {type && (
            <button className={btnAccent} onClick={() => s.go({ kind: 'edit', type: type.id, folder })}>
              <Plus size={15} /> New {type.name}
            </button>
          )}
        </div>
        {isDocs && folders.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <Folder size={13} className="text-muted" />
            <button onClick={() => s.go({ kind: 'list', type: 'document' })} className={`rounded-md px-2 py-0.5 ${!folder ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised hover:text-ink'}`}>
              All documents
            </button>
            {folders.map((f) => (
              <button key={f} onClick={() => s.go({ kind: 'list', type: 'document', folder: f })} className={`rounded-md px-2 py-0.5 ${folder === f ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised hover:text-ink'}`}>
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.listLoading && !rows.length ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <LoaderCircle size={15} className="animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={type ? <TypeIcon name={type.icon} size={22} /> : v.kind === 'archived' ? <Archive size={22} /> : <Star size={22} />}
            title={s.listFilter || v.kind === 'search' ? 'Nothing matches' : type ? `No ${type.namePlural.toLowerCase()} yet` : v.kind === 'favorites' ? 'No favorites yet' : 'Nothing archived'}
            body={type && !s.listFilter ? type.description : v.kind === 'favorites' ? 'Star a record to keep it here.' : undefined}
            action={
              type && !s.listFilter ? (
                <button className={btnAccent} onClick={() => s.go({ kind: 'edit', type: type.id, folder })}>
                  <Plus size={15} /> New {type.name}
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-[1] bg-surface text-left text-[10.5px] font-semibold uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="w-8 py-2 pl-4" />
                <th className="py-2">{type?.nameLabel ?? 'Name'}</th>
                {mixed && <th className="py-2">Type</th>}
                {isDocs && <th className="py-2">Folder</th>}
                {cols.map((c) => (
                  <th key={c.key} className="py-2">
                    {c.label}
                  </th>
                ))}
                <th className="py-2">Tags</th>
                <th className="w-28 py-2 pr-4 text-right">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rt = typeOf(r.type)
                return (
                  <tr key={r.id} onClick={() => s.openRecord(r.id)} className="cursor-pointer border-b border-edge/60 hover:bg-raised/60">
                    <td className="py-2 pl-4">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void s.flag(r.id, 'favorite', !r.favorite)
                        }}
                        className={r.favorite ? 'text-warn' : 'text-muted/40 hover:text-warn'}
                        title={r.favorite ? 'Unfavorite' : 'Favorite'}
                      >
                        <Star size={14} fill={r.favorite ? 'currentColor' : 'none'} />
                      </button>
                    </td>
                    <td className="max-w-[320px] py-2 pr-3">
                      <div className="flex items-center gap-2">
                        {mixed && rt && <TypeIcon name={rt.icon} size={14} className="shrink-0 text-muted" />}
                        <span className="truncate font-medium text-ink">{r.name}</span>
                        {r.archived && v.kind !== 'archived' && <Pill>archived</Pill>}
                      </div>
                    </td>
                    {mixed && <td className="py-2 pr-3 text-xs text-muted">{rt?.name ?? r.type}</td>}
                    {isDocs && <td className="py-2 pr-3 text-xs text-muted">{r.folder || '—'}</td>}
                    {cols.map((c) => (
                      <td key={c.key} className={`max-w-[220px] truncate py-2 pr-3 text-xs ${c.kind === 'password' ? 'font-mono tracking-widest text-muted' : 'text-ink/85'}`}>
                        {r.preview[c.key] || <span className="text-muted/50">—</span>}
                      </td>
                    ))}
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {r.tags.slice(0, 3).map((t) => (
                          <Pill key={t}>{t}</Pill>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-right text-xs text-muted">{fmtAgo(r.updatedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

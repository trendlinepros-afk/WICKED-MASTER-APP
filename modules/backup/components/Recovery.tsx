import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Cloud,
  CloudOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  HardDrive,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import { useBackup, inv } from '../store'
import type { BrowseEntry, BrowseResult, FileHistoryEntry, OverwritePolicy, PlanView, VersionInfo } from '../types'
import { displayStorePath, parentOf, segmentLabel } from '../lib/paths'
import { btn, btnAccent, btnDanger, card, fmtBytes, fmtCount, fmtDateTime, iconBtn, input, Modal } from './ui'

/* ------------------------------ version list ------------------------------ */

function VersionRow({ v, active, onClick }: { v: VersionInfo; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-raised'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
            v.kind === 'full' ? 'bg-accent text-accent-ink' : 'bg-accent/15 text-accent'
          }`}
        >
          {v.kind === 'full' ? 'FULL' : 'INC'}
        </span>
        <span className="flex-1 truncate text-sm font-medium text-ink">{fmtDateTime(v.createdAt)}</span>
        {v.verified === true && <ShieldCheck size={13} className="text-ok" aria-label="Validated" />}
        {v.verified === false && <ShieldCheck size={13} className="text-danger" aria-label="Validation failed" />}
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <span className="min-w-0 truncate whitespace-nowrap">
          {fmtCount(v.stats.files)} files · {fmtBytes(v.stats.bytes)}
          {v.kind === 'incremental' && <span className="text-accent"> · +{fmtCount(v.stats.newFiles)} changed</span>}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {v.local ? <HardDrive size={12} aria-label="At the backup location" /> : null}
          {v.cloud === 'complete' ? (
            <Cloud size={12} className="text-accent" aria-label="In Google Drive" />
          ) : v.cloud === 'partial' ? (
            <Cloud size={12} className="text-warn" aria-label="Partly uploaded to Google Drive" />
          ) : null}
        </span>
      </div>
      {v.stats.errors > 0 && <div className="mt-0.5 text-[11px] text-warn">{v.stats.errors} file(s) skipped</div>}
    </button>
  )
}

/* ------------------------------ restore dialog ----------------------------- */

function RestoreDialog({
  plan,
  version,
  paths,
  platform,
  onClose,
  onStarted
}: {
  plan: PlanView
  version: VersionInfo
  paths: string[]
  platform: string
  onClose: () => void
  onStarted: () => void
}): React.JSX.Element {
  const showToast = useBackup((s) => s.showToast)
  const [target, setTarget] = useState<'original' | 'folder'>('original')
  const [folder, setFolder] = useState('')
  const [keepStructure, setKeepStructure] = useState(false)
  const [overwrite, setOverwrite] = useState<OverwritePolicy>('older')
  const [from, setFrom] = useState<'auto' | 'local' | 'cloud'>('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const whole = paths.length === 0
  const label = whole
    ? 'the entire backup'
    : paths.length === 1
      ? `“${displayStorePath(paths[0], platform)}”`
      : `${paths.length} selected items`

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = (await inv('restore', {
      planId: plan.id,
      versionId: version.id,
      paths,
      target,
      folder: target === 'folder' ? folder : undefined,
      keepStructure,
      overwrite,
      from
    })) as { ok: boolean; error?: string; files?: number; bytes?: number }
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? 'Could not start the restore')
      return
    }
    showToast('ok', `Restoring ${fmtCount(r.files ?? 0)} file${r.files === 1 ? '' : 's'} (${fmtBytes(r.bytes ?? 0)})…`)
    onStarted()
  }

  const radio = (on: boolean): string =>
    `flex cursor-pointer gap-3 rounded-lg border p-3 ${on ? 'border-accent bg-accent/10' : 'border-edge hover:border-accent/50'}`

  return (
    <Modal title="Restore files" onClose={onClose}>
      <p className="mb-4 text-sm text-muted">
        Restore {label} as it was on <b className="text-ink">{fmtDateTime(version.createdAt)}</b>.
      </p>
      <div className="space-y-2">
        <label className={radio(target === 'original')}>
          <input type="radio" checked={target === 'original'} onChange={() => setTarget('original')} className="mt-1" />
          <div>
            <div className="text-sm font-medium text-ink">Original location</div>
            <div className="text-xs text-muted">Put files back exactly where they were backed up from.</div>
          </div>
        </label>
        <label className={radio(target === 'folder')}>
          <input type="radio" checked={target === 'folder'} onChange={() => setTarget('folder')} className="mt-1" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">A different folder</div>
            <div className="text-xs text-muted">Safe way to look at old versions side-by-side with your current files.</div>
            {target === 'folder' && (
              <div className="mt-2 space-y-2">
                <div className="flex gap-2">
                  <input className={`${input} font-mono text-xs`} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Restored" />
                  <button
                    className={btn}
                    onClick={async (e) => {
                      e.preventDefault()
                      const p = (await inv('pick-folder', { title: 'Restore into…' })) as string | null
                      if (p) setFolder(p)
                    }}
                  >
                    Browse…
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-ink">
                  <input type="checkbox" checked={keepStructure} onChange={(e) => setKeepStructure(e.target.checked)} />
                  Recreate the full original folder path inside it
                </label>
              </div>
            )}
          </div>
        </label>
      </div>

      <label className="mt-4 block text-xs font-medium text-muted">
        If a file already exists
        <select className={`${input} mt-1`} value={overwrite} onChange={(e) => setOverwrite(e.target.value as OverwritePolicy)}>
          <option value="older">Replace it only if it’s older than the backup copy (recommended)</option>
          <option value="overwrite">Always replace it with the backup copy</option>
          <option value="skip">Keep the existing file (skip)</option>
        </select>
      </label>

      {plan.cloud.enabled && (
        <label className="mt-3 block text-xs font-medium text-muted">
          Restore from
          <select className={`${input} mt-1`} value={from} onChange={(e) => setFrom(e.target.value as 'auto' | 'local' | 'cloud')}>
            <option value="auto">Automatic — backup location, or Google Drive if it’s unavailable</option>
            <option value="local" disabled={!version.local}>
              Backup location only
            </option>
            <option value="cloud" disabled={version.cloud !== 'complete'}>
              Google Drive copy
            </option>
          </select>
        </label>
      )}

      {target === 'original' && overwrite === 'overwrite' && (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          Current files at the original locations will be replaced with the backup copies, even if they are newer.
        </p>
      )}
      {error && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnAccent} disabled={busy || (target === 'folder' && !folder.trim())} onClick={() => void start()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Restore
        </button>
      </div>
    </Modal>
  )
}

/* ------------------------------- file history ------------------------------ */

function FileHistoryModal({
  plan,
  entry,
  platform,
  versions,
  onClose,
  onRestore
}: {
  plan: PlanView
  entry: BrowseEntry
  platform: string
  versions: VersionInfo[]
  onClose: () => void
  onRestore: (v: VersionInfo) => void
}): React.JSX.Element {
  const [items, setItems] = useState<FileHistoryEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void (async () => {
      const r = (await inv('file-history', { planId: plan.id, storePath: entry.path })) as { ok: boolean; entries: FileHistoryEntry[]; error?: string }
      if (!r.ok) setError(r.error ?? 'Could not load history')
      setItems(r.entries ?? [])
    })()
  }, [plan.id, entry.path])

  // collapse runs of identical content into one row per distinct copy
  const distinct = useMemo(() => {
    const out: (FileHistoryEntry & { count: number })[] = []
    for (const it of items ?? []) {
      const last = out[out.length - 1]
      if (last && last.hash === it.hash) last.count++
      else out.push({ ...it, count: 1 })
    }
    return out
  }, [items])

  return (
    <Modal title="File versions" onClose={onClose} wide>
      <p className="mb-3 truncate font-mono text-xs text-muted" title={displayStorePath(entry.path, platform)}>
        {displayStorePath(entry.path, platform)}
      </p>
      {!items ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Reading backup versions…
        </div>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : (
        <div className="divide-y divide-edge rounded-lg border border-edge">
          {distinct.map((it) => {
            const v = versions.find((x) => x.id === it.versionId)
            return (
              <div key={it.versionId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="text-ink">Modified {fmtDateTime(it.mtime)}</div>
                  <div className="text-xs text-muted">
                    {fmtBytes(it.size)} · in backup of {fmtDateTime(it.createdAt)}
                    {it.count > 1 ? ` (+${it.count - 1} older backup${it.count === 2 ? '' : 's'} with the same copy)` : ''}
                  </div>
                </div>
                {v && (
                  <button className={btn} onClick={() => onRestore(v)}>
                    <RotateCcw size={13} /> Restore this
                  </button>
                )}
              </div>
            )
          })}
          {distinct.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted">Not found in any version.</div>}
        </div>
      )}
    </Modal>
  )
}

/* --------------------------------- browser -------------------------------- */

export default function Recovery({ plan }: { plan: PlanView }): React.JSX.Element {
  const vs = useBackup((s) => s.versions[plan.id])
  const loadVersions = useBackup((s) => s.loadVersions)
  const focusVersion = useBackup((s) => s.focusVersion)
  const showToast = useBackup((s) => s.showToast)
  const busy = plan.busy

  const [vid, setVid] = useState<string | null>(null)
  const [res, setRes] = useState<BrowseResult | null>(null)
  const [platform, setPlatform] = useState('win32')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<BrowseEntry[] | null>(null)
  const [restoring, setRestoring] = useState<{ paths: string[]; version: VersionInfo } | null>(null)
  const [historyOf, setHistoryOf] = useState<BrowseEntry | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    void loadVersions(plan.id)
  }, [plan.id, loadVersions])

  const list = vs?.list ?? []
  // pick a version: the focused one, else keep the current, else the newest
  useEffect(() => {
    if (!list.length) {
      setVid(null)
      return
    }
    if (focusVersion && list.some((v) => v.id === focusVersion)) setVid(focusVersion)
    else if (!vid || !list.some((v) => v.id === vid)) setVid(list[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, focusVersion])

  const version = list.find((v) => v.id === vid) ?? null

  const open = async (dir: string | null): Promise<void> => {
    if (!vid) return
    setLoading(true)
    setError('')
    const r = (await inv('browse', { planId: plan.id, versionId: vid, dir })) as {
      ok: boolean
      error?: string
      result?: BrowseResult
      platform?: string
    }
    setLoading(false)
    if (!r.ok || !r.result) {
      setError(r.error ?? 'Could not open this version')
      setRes(null)
      return
    }
    setRes(r.result)
    if (r.platform) setPlatform(r.platform)
  }

  useEffect(() => {
    setSel(new Set())
    setHits(null)
    setQuery('')
    setRes(null)
    if (vid) void open(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vid])

  const runSearch = async (): Promise<void> => {
    if (!vid || !query.trim()) {
      setHits(null)
      return
    }
    setLoading(true)
    const r = (await inv('search', { planId: plan.id, versionId: vid, query })) as { ok: boolean; entries: BrowseEntry[]; error?: string }
    setLoading(false)
    if (!r.ok) setError(r.error ?? 'Search failed')
    setHits(r.entries)
  }

  const toggle = (p: string): void => {
    const next = new Set(sel)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setSel(next)
  }

  const entries = hits ?? res?.entries ?? []
  const allOnPage = entries.length > 0 && entries.every((e) => sel.has(e.path))

  const crumbs = useMemo(() => {
    if (!res?.dir) return []
    const parts = res.dir.split('/')
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
  }, [res?.dir])

  const validate = async (): Promise<void> => {
    if (!vid) return
    const r = (await inv('validate', { planId: plan.id, versionId: vid })) as { ok: boolean; error?: string }
    if (!r.ok) showToast('err', r.error ?? 'Could not start validation')
  }

  const doDelete = async (): Promise<void> => {
    if (!vid) return
    const r = (await inv('delete-version', { planId: plan.id, versionId: vid })) as { ok: boolean; error?: string; deleted?: string[] }
    setConfirmDelete(false)
    if (!r.ok) showToast('err', r.error ?? 'Could not delete')
    else showToast('ok', `Deleted ${r.deleted?.length ?? 1} version${r.deleted?.length === 1 ? '' : 's'}`)
    setVid(null)
    await loadVersions(plan.id, true)
  }

  const dependents = version
    ? version.kind === 'full'
      ? list.filter((v) => v.base === version.id && v.id !== version.id).length
      : list.filter((v) => v.base === version.base && v.createdAt > version.createdAt).length
    : 0

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* versions */}
      <div className={`${card} flex w-72 shrink-0 flex-col`}>
        <div className="flex items-center justify-between border-b border-edge px-3 py-2.5">
          <span className="text-sm font-semibold text-ink">Versions {list.length ? `(${list.length})` : ''}</span>
          <button className={iconBtn} onClick={() => void loadVersions(plan.id, true)} title="Refresh">
            <RefreshCw size={14} className={vs?.loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {vs?.localError && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
              {vs.localError}
              {plan.cloud.enabled && ' Showing the Google Drive copy.'}
            </div>
          )}
          {vs?.cloudError && plan.cloud.enabled && (
            <div className="flex gap-1.5 rounded-lg border border-edge p-2 text-[11px] text-muted">
              <CloudOff size={12} className="mt-0.5 shrink-0" /> {vs.cloudError}
            </div>
          )}
          {!vs || (vs.loading && !list.length) ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : list.length === 0 ? (
            <div className="p-3 text-sm text-muted">No backups yet. Run the plan to create the first version.</div>
          ) : (
            list.map((v) => <VersionRow key={v.id} v={v} active={v.id === vid} onClick={() => setVid(v.id)} />)
          )}
        </div>
      </div>

      {/* browser */}
      <div className={`${card} flex min-w-0 flex-1 flex-col`}>
        {!version ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">Select a version to browse its files.</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-ink">
                  {version.kind === 'full' ? 'Full backup' : 'Incremental backup'} · {fmtDateTime(version.createdAt)}
                </div>
                <div className="text-xs text-muted">
                  {fmtCount(version.stats.files)} files · {fmtBytes(version.stats.bytes)}
                  {version.kind === 'incremental' && ` · ${fmtCount(version.stats.newFiles)} changed (${fmtBytes(version.stats.newBytes)} stored)`}
                  {version.verified === true && ' · validated ✓'}
                </div>
              </div>
              <button className={btn} disabled={!version.local || busy} onClick={() => void validate()} title="Re-read every file and check its checksum">
                <ShieldCheck size={14} /> Validate
              </button>
              <button className={btn} disabled={busy} onClick={() => setConfirmDelete(true)} title="Delete this version">
                <Trash2 size={14} />
              </button>
              <button className={btnAccent} onClick={() => setRestoring({ paths: sel.size ? [...sel] : [], version })}>
                <RotateCcw size={14} /> {sel.size ? `Restore ${sel.size} selected` : 'Restore everything'}
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
              <button
                className={iconBtn}
                disabled={!res?.dir || !!hits}
                onClick={() => void open(parentOf(res?.dir ?? ''))}
                title="Up one folder"
              >
                <ArrowUp size={15} />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-sm">
                {hits ? (
                  <span className="text-muted">
                    {hits.length >= 500 ? 'First 500' : hits.length} result{hits.length === 1 ? '' : 's'} for “{query}”
                  </span>
                ) : (
                  <>
                    <button className="rounded px-1.5 py-0.5 text-muted hover:bg-raised hover:text-ink" onClick={() => void open('')}>
                      All files
                    </button>
                    {crumbs.map((c) => (
                      <span key={c} className="flex items-center">
                        <ChevronRight size={13} className="text-muted" />
                        <button className="rounded px-1.5 py-0.5 text-ink hover:bg-raised" onClick={() => void open(c)}>
                          {segmentLabel(c, platform)}
                        </button>
                      </span>
                    ))}
                  </>
                )}
              </div>
              <div className="relative w-56">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  className="w-full rounded-lg border border-edge bg-bg py-1.5 pl-8 pr-7 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none"
                  placeholder="Find files (e.g. *.xlsx)"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    if (!e.target.value) setHits(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
                />
                {query && (
                  <button
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-ink"
                    onClick={() => {
                      setQuery('')
                      setHits(null)
                    }}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {error ? (
                <div className="p-6 text-sm text-danger">{error}</div>
              ) : loading && !entries.length ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted">
                  <Loader2 size={15} className="animate-spin" /> Reading the backup…
                </div>
              ) : entries.length === 0 ? (
                <div className="p-6 text-sm text-muted">{hits ? 'No matching files.' : 'This folder is empty.'}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-muted">
                    <tr className="border-b border-edge">
                      <th className="w-9 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={allOnPage}
                          onChange={() => {
                            const next = new Set(sel)
                            for (const e of entries) {
                              if (allOnPage) next.delete(e.path)
                              else next.add(e.path)
                            }
                            setSel(next)
                          }}
                        />
                      </th>
                      <th className="py-2">Name</th>
                      <th className="w-28 py-2 text-right">Size</th>
                      <th className="w-44 py-2 pl-4">Modified</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr
                        key={e.path}
                        className={`group border-b border-edge/50 ${sel.has(e.path) ? 'bg-accent/5' : 'hover:bg-raised/60'}`}
                        onDoubleClick={() => e.isDir && void open(e.path)}
                      >
                        <td className="px-3 py-1.5">
                          <input type="checkbox" checked={sel.has(e.path)} onChange={() => toggle(e.path)} />
                        </td>
                        <td className="max-w-0 py-1.5">
                          {e.isDir ? (
                            <button className="flex max-w-full items-center gap-2 text-left text-ink hover:text-accent" onClick={() => void open(e.path)}>
                              <Folder size={15} className="shrink-0 text-accent" />
                              <span className="truncate">{e.name}</span>
                            </button>
                          ) : (
                            <div className="flex items-center gap-2">
                              <FileIcon size={15} className="shrink-0 text-muted" />
                              <span className="truncate text-ink" title={displayStorePath(e.path, platform)}>
                                {e.name}
                              </span>
                              {e.changed && version.kind === 'incremental' && (
                                <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium text-accent">changed</span>
                              )}
                            </div>
                          )}
                          {hits && <div className="truncate pl-6 font-mono text-[10px] text-muted">{displayStorePath(parentOf(e.path), platform)}</div>}
                        </td>
                        <td className="py-1.5 text-right text-xs text-muted">
                          {fmtBytes(e.size)}
                          {e.isDir && <div className="text-[10px]">{fmtCount(e.files ?? 0)} files</div>}
                        </td>
                        <td className="py-1.5 pl-4 text-xs text-muted">{e.isDir ? '' : fmtDateTime(e.mtime)}</td>
                        <td className="pr-2 text-right">
                          {e.isDir ? (
                            <button className={`${iconBtn} opacity-0 group-hover:opacity-100`} onClick={() => void open(e.path)} title="Open">
                              <FolderOpen size={14} />
                            </button>
                          ) : (
                            <button className={`${iconBtn} opacity-0 group-hover:opacity-100`} onClick={() => setHistoryOf(e)} title="All versions of this file">
                              <History size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {sel.size > 0 && (
              <div className="flex items-center gap-3 border-t border-edge bg-accent/5 px-4 py-2.5">
                <CheckCircle2 size={15} className="text-accent" />
                <span className="flex-1 text-sm text-ink">
                  {sel.size} item{sel.size === 1 ? '' : 's'} selected
                </span>
                <button className={btn} onClick={() => setSel(new Set())}>
                  Clear
                </button>
                <button className={btnAccent} onClick={() => setRestoring({ paths: [...sel], version })}>
                  <RotateCcw size={14} /> Restore…
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {restoring && (
        <RestoreDialog
          plan={plan}
          version={restoring.version}
          paths={restoring.paths}
          platform={platform}
          onClose={() => setRestoring(null)}
          onStarted={() => {
            setRestoring(null)
            setSel(new Set())
          }}
        />
      )}
      {historyOf && (
        <FileHistoryModal
          plan={plan}
          entry={historyOf}
          platform={platform}
          versions={list}
          onClose={() => setHistoryOf(null)}
          onRestore={(v) => {
            setHistoryOf(null)
            setRestoring({ paths: [historyOf.path], version: v })
          }}
        />
      )}
      {confirmDelete && version && (
        <Modal title="Delete backup version?" onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-muted">
            {version.kind === 'full' && dependents > 0
              ? `This full backup has ${dependents} incremental backup${dependents === 1 ? '' : 's'} built on it — they will be deleted too, since they can’t be restored without it.`
              : dependents > 0
                ? `${dependents} newer incremental backup${dependents === 1 ? '' : 's'} depend${dependents === 1 ? 's' : ''} on this one and will be deleted too.`
                : 'This version will be permanently deleted from the backup location.'}
            {plan.cloud.enabled && ' Its Google Drive copy is moved to the Drive trash.'}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btn} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button className={btnDanger} onClick={() => void doDelete()}>
              <Trash2 size={14} /> Delete {dependents > 0 ? `${dependents + 1} versions` : 'version'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

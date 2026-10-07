import { useEffect, useRef, useState } from 'react'
import { Cloud, CloudOff, CopyCheck, HardDrive, Hourglass, Loader2, RefreshCw, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { ID, useYt } from './store'

/* ---------------------------------------------------------------------------
 *  "Downloaded songs": every song the downloader has saved (to this PC or
 *  Google Drive, on any of your PCs). Music downloads skip anything on it.
 *  Shows the name a song is saved as and, when it was renamed (song info /
 *  your edit), the name it was downloaded as.
 *   - Remove from list → it may be downloaded again; the file stays.
 *   - Delete → the file goes to the Recycle Bin / Google Drive trash AND it
 *     leaves the list.
 *  Tick several to do either in one go. The list travels with Backup / Cloud
 *  Sync and is shared live through Google Drive (footer shows the last sync).
 * ------------------------------------------------------------------------- */

interface Song {
  videoId: string
  aliases: string[]
  title: string
  artist: string
  album: string
  originalTitle: string
  originalArtist: string
  fileName: string
  location: 'local' | 'drive' | 'pending'
  path: string
  playlist: string
  downloadedAt: number
  renamedAt: number
}

interface ListRes {
  ok: boolean
  items?: Song[]
  matched?: number
  syncedAt?: number
  syncError?: string
}

const inv = <T,>(action: string, arg?: unknown): Promise<T> => window.wicked.invoke(`${ID}:${action}`, arg) as Promise<T>
const PAGE = 100

const whereLabel = (s: Song): string => (s.location === 'drive' ? 'Google Drive trash' : 'Recycle Bin')

function Where({ s }: { s: Song }): React.JSX.Element {
  if (s.location === 'drive')
    return (
      <span className="flex items-center gap-1 text-accent" title="In Google Drive (WICKED Vault/YouTube Downloads)">
        <Cloud size={12} /> Drive
      </span>
    )
  if (s.location === 'pending')
    return (
      <span className="flex items-center gap-1 text-warn" title="Downloaded — still uploading or waiting for song info">
        <Hourglass size={12} /> Pending
      </span>
    )
  return (
    <span className="flex items-center gap-1 text-muted" title={s.path}>
      <HardDrive size={12} /> This PC
    </span>
  )
}

const ago = (ms: number): string => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function LibraryModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const total = useYt((st) => st.libraryCount)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Song[]>([])
  const [matched, setMatched] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [sync, setSync] = useState<{ at: number; error: string }>({ at: 0, error: '' })
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** confirming a delete: which songs */
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const seq = useRef(0)

  const load = async (q = query, lim = limit): Promise<void> => {
    const my = ++seq.current
    setLoading(true)
    const r = await inv<ListRes>('library-list', { query: q, limit: lim })
    if (my !== seq.current) return // a newer search won
    setLoading(false)
    if (r.ok) {
      setItems(r.items ?? [])
      setMatched(r.matched ?? 0)
      setSync({ at: r.syncedAt ?? 0, error: r.syncError ?? '' })
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(query, limit), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, limit, total])

  // opening the list pulls in what your other PCs downloaded
  useEffect(() => {
    void syncNow(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const syncNow = async (quiet = false): Promise<void> => {
    setSyncing(true)
    const r = await inv<{ ok: boolean; syncedAt?: number; error?: string }>('library-sync')
    setSyncing(false)
    setSync({ at: r.syncedAt ?? 0, error: r.error ?? '' })
    if (!quiet && r.error && r.error !== 'not-connected') setMsg({ text: `Couldn’t sync with Google Drive: ${r.error}`, tone: 'err' })
    void load()
  }

  const toggle = (id: string): void =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allShown = items.length > 0 && items.every((s) => selected.has(s.videoId))
  const toggleAll = (): void => setSelected(allShown ? new Set() : new Set(items.map((s) => s.videoId)))

  const removeFromList = async (ids: string[]): Promise<void> => {
    setBusy(true)
    const r = await inv<{ forgotten?: number }>('library-forget', { videoIds: ids })
    setBusy(false)
    setSelected(new Set())
    setMsg({ text: `Removed ${r.forgotten ?? 0} song${r.forgotten === 1 ? '' : 's'} from the list — ${r.forgotten === 1 ? 'it' : 'they'} can be downloaded again. Files weren’t touched.`, tone: 'ok' })
  }

  const deleteSongs = async (ids: string[]): Promise<void> => {
    setBusy(true)
    const r = await inv<{ ok: boolean; deleted?: number; failed?: number; error?: string }>('library-delete', { videoIds: ids })
    setBusy(false)
    setConfirmDelete(null)
    setSelected(new Set())
    setMsg(
      r.ok
        ? { text: `Deleted ${r.deleted ?? 0} song${r.deleted === 1 ? '' : 's'} (moved to the Recycle Bin / Google Drive trash) and removed ${r.deleted === 1 ? 'it' : 'them'} from the list.`, tone: 'ok' }
        : { text: `Deleted ${r.deleted ?? 0}; ${r.failed ?? 0} couldn’t be: ${r.error ?? 'unknown error'}`, tone: 'err' }
    )
  }

  const forgetAll = async (): Promise<void> => {
    const r = await inv<{ forgotten?: number }>('library-forget', { all: true })
    setConfirmAll(false)
    setSelected(new Set())
    setMsg({ text: `Removed all ${r.forgotten ?? 0} songs from the list — it starts fresh (your files are untouched).`, tone: 'ok' })
  }

  const scan = async (): Promise<void> => {
    setScanning(true)
    setMsg(null)
    const r = await inv<{ ok: boolean; local?: number; drive?: number; error?: string }>('library-scan')
    setScanning(false)
    setMsg(r.error ? { text: r.error, tone: 'err' } : { text: `Added ${r.local ?? 0} song(s) from your download folder and ${r.drive ?? 0} from Google Drive.`, tone: 'ok' })
  }

  const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const sel = [...selected]
  const delTargets = confirmDelete ? items.filter((s) => confirmDelete.includes(s.videoId)) : []
  const driveOff = sync.error === 'not-connected'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-edge px-5 py-3">
          <CopyCheck size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Downloaded songs · {total.toLocaleString()}</div>
            <div className="text-xs text-muted">Music downloads skip every song on this list — from any playlist, on any of your PCs, saved here or in Google Drive.</div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-edge px-5 py-2.5">
          <div className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setLimit(PAGE)
                setSelected(new Set())
              }}
              placeholder="Search title, artist, album, original name or playlist…"
              className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-8 pr-2.5 text-sm outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={() => void scan()}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium hover:border-accent disabled:opacity-40"
            title="Add songs downloaded before this list existed — from your download folder and Google Drive"
          >
            {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Add songs already downloaded
          </button>
        </div>

        {/* bulk actions for ticked songs */}
        {sel.length > 0 && !confirmDelete && (
          <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-accent/10 px-5 py-2 text-xs">
            <span className="font-semibold">{sel.length} selected</span>
            <button onClick={() => setSelected(new Set())} className="text-muted hover:text-ink">
              Clear
            </button>
            <span className="flex-1" />
            <button onClick={() => void removeFromList(sel)} disabled={busy} className="rounded-lg border border-edge bg-surface px-2.5 py-1 font-medium hover:border-warn hover:text-warn disabled:opacity-40">
              Remove from list
            </button>
            <button onClick={() => setConfirmDelete(sel)} disabled={busy} className="flex items-center gap-1 rounded-lg bg-danger px-2.5 py-1 font-semibold text-white hover:opacity-90 disabled:opacity-40">
              <Trash2 size={12} /> Delete songs…
            </button>
          </div>
        )}

        {/* delete confirmation */}
        {confirmDelete && (
          <div className="border-b border-danger/40 bg-danger/10 px-5 py-2.5 text-xs">
            <div className="font-semibold text-danger">
              Delete {confirmDelete.length} song{confirmDelete.length === 1 ? '' : 's'}?
            </div>
            <div className="mt-0.5 text-muted">
              {delTargets.length === 1
                ? `“${delTargets[0].title || delTargets[0].fileName}” goes to the ${whereLabel(delTargets[0])} and leaves the list.`
                : `Songs on this PC go to the Recycle Bin, songs in Google Drive go to Drive’s trash (both recoverable for a while), and they leave the list.`}
            </div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => void deleteSongs(confirmDelete)} disabled={busy} className="flex items-center gap-1 rounded-lg bg-danger px-3 py-1 font-semibold text-white hover:opacity-90 disabled:opacity-40">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Yes, delete
              </button>
              <button onClick={() => setConfirmDelete(null)} className="rounded-lg bg-raised px-3 py-1 font-medium">
                Cancel
              </button>
            </div>
          </div>
        )}

        {msg && <div className={`border-b border-edge px-5 py-2 text-xs ${msg.tone === 'err' ? 'bg-danger/10 text-danger' : 'bg-raised/40 text-muted'}`}>{msg.text}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted">
              {loading ? 'Loading…' : query ? 'No downloaded song matches that.' : 'Nothing yet — songs appear here as they’re downloaded.'}
            </div>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 border-b border-edge/60 px-5 py-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={allShown} onChange={toggleAll} className="h-3.5 w-3.5 accent-[rgb(var(--wk-accent))]" />
                Select all shown ({items.length})
              </label>
              <ul className="divide-y divide-edge/60">
                {items.map((s) => {
                  const renamed = !!s.renamedAt && (s.originalTitle !== s.title || s.originalArtist !== s.artist)
                  const on = selected.has(s.videoId)
                  return (
                    <li key={s.videoId} className={`flex items-center gap-3 px-5 py-2.5 ${on ? 'bg-accent/5' : ''}`}>
                      <input type="checkbox" checked={on} onChange={() => toggle(s.videoId)} className="h-4 w-4 shrink-0 accent-[rgb(var(--wk-accent))]" aria-label="Select" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          <span className="font-medium">{s.title || s.fileName}</span>
                          {s.artist && <span className="text-muted"> — {s.artist}</span>}
                        </div>
                        {renamed && (
                          <div className="truncate text-[11px] text-muted" title="The name it was downloaded with">
                            Renamed from: {s.originalArtist ? `${s.originalArtist} — ` : ''}
                            {s.originalTitle}
                          </div>
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                          <Where s={s} />
                          <span className="truncate">{s.playlist}</span>
                          <span>· {fmtDate(s.downloadedAt)}</span>
                          {s.aliases.length > 0 && <span title={s.aliases.join(', ')}>· also {s.aliases.length} other video{s.aliases.length === 1 ? '' : 's'}</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => void removeFromList([s.videoId])}
                        disabled={busy}
                        className="shrink-0 rounded-lg border border-edge px-2.5 py-1 text-xs text-muted hover:border-warn hover:text-warn disabled:opacity-40"
                        title="Take it off the list so it can be downloaded again (the file stays)"
                      >
                        Remove from list
                      </button>
                      <button
                        onClick={() => setConfirmDelete([s.videoId])}
                        disabled={busy || s.location === 'pending'}
                        className="shrink-0 rounded-lg border border-edge p-1.5 text-muted hover:border-danger hover:text-danger disabled:opacity-30"
                        title={s.location === 'pending' ? 'Still uploading or waiting for song info' : `Delete the song (to the ${whereLabel(s)}) and remove it from the list`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
          {matched > items.length && (
            <div className="p-3 text-center">
              <button onClick={() => setLimit((l) => l + PAGE)} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60">
                Show more ({(matched - items.length).toLocaleString()} left)
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-edge px-5 py-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted">
            {driveOff ? <CloudOff size={13} className="shrink-0" /> : <ShieldCheck size={13} className="shrink-0 text-ok" />}
            <span className="min-w-0">
              Saved with WICKED Backup &amp; Cloud Sync.{' '}
              {driveOff
                ? 'Connect Google Drive in File Vault to share it live between your PCs.'
                : sync.error
                  ? `Google Drive sync failed: ${sync.error}`
                  : sync.at
                    ? `Shared with your other PCs through Google Drive · synced ${ago(sync.at)}.`
                    : 'Shared with your other PCs through Google Drive.'}
            </span>
            {!driveOff && (
              <button onClick={() => void syncNow()} disabled={syncing} className="shrink-0 font-medium text-accent hover:underline disabled:opacity-40">
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            )}
          </span>
          {total > 0 &&
            (confirmAll ? (
              <>
                <span className="text-xs text-warn">Remove all {total.toLocaleString()} from the list?</span>
                <button onClick={() => void forgetAll()} className="rounded-lg bg-warn/20 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-warn/30">
                  Yes, remove all
                </button>
                <button onClick={() => setConfirmAll(false)} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium">
                  No
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmAll(true)} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink" title="Files are not deleted">
                Remove all from list…
              </button>
            ))}
          <button onClick={onClose} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

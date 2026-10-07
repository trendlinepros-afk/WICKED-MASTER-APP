import { useEffect, useRef, useState } from 'react'
import { Cloud, CopyCheck, HardDrive, Hourglass, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { ID, useYt } from './store'

/* ---------------------------------------------------------------------------
 *  "Downloaded songs": every song the downloader has saved (to this PC or
 *  Google Drive). Music downloads skip anything on this list. Shows the name a
 *  song is saved as and, when it was renamed (song info / your edit), the name
 *  it was downloaded as. Forget = it may be downloaded again (files untouched).
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

const inv = <T,>(action: string, arg?: unknown): Promise<T> => window.wicked.invoke(`${ID}:${action}`, arg) as Promise<T>
const PAGE = 100

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

export function LibraryModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const total = useYt((st) => st.libraryCount)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Song[]>([])
  const [matched, setMatched] = useState(0)
  const [limit, setLimit] = useState(PAGE)
  const [loading, setLoading] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  const seq = useRef(0)

  const load = async (q = query, lim = limit): Promise<void> => {
    const my = ++seq.current
    setLoading(true)
    const r = await inv<{ ok: boolean; items?: Song[]; matched?: number }>('library-list', { query: q, limit: lim })
    if (my !== seq.current) return // a newer search won
    setLoading(false)
    if (r.ok) {
      setItems(r.items ?? [])
      setMatched(r.matched ?? 0)
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void load(query, limit), 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, limit, total])

  const forget = async (videoId: string): Promise<void> => {
    await inv('library-forget', { videoIds: [videoId] })
    setMsg('Forgotten — that song will download again next time it’s in a playlist.')
  }

  const forgetAll = async (): Promise<void> => {
    const r = await inv<{ forgotten?: number }>('library-forget', { all: true })
    setConfirmAll(false)
    setMsg(`Forgot all ${r.forgotten ?? 0} songs — the list starts fresh (your files are untouched).`)
  }

  const scan = async (): Promise<void> => {
    setScanning(true)
    setMsg('')
    const r = await inv<{ ok: boolean; local?: number; drive?: number; error?: string }>('library-scan')
    setScanning(false)
    setMsg(r.error ? r.error : `Added ${r.local ?? 0} song(s) from your download folder and ${r.drive ?? 0} from Google Drive.`)
  }

  const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-edge px-5 py-3">
          <CopyCheck size={16} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Downloaded songs · {total.toLocaleString()}</div>
            <div className="text-xs text-muted">Music downloads skip every song on this list — from any playlist, saved here or in Google Drive.</div>
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
        {msg && <div className="border-b border-edge bg-raised/40 px-5 py-2 text-xs text-muted">{msg}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted">
              {loading ? 'Loading…' : query ? 'No downloaded song matches that.' : 'Nothing yet — songs appear here as they’re downloaded.'}
            </div>
          ) : (
            <ul className="divide-y divide-edge/60">
              {items.map((s) => {
                const renamed = !!s.renamedAt && (s.originalTitle !== s.title || s.originalArtist !== s.artist)
                return (
                  <li key={s.videoId} className="flex items-center gap-3 px-5 py-2.5">
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
                      onClick={() => void forget(s.videoId)}
                      className="shrink-0 rounded-lg border border-edge px-2.5 py-1 text-xs text-muted hover:border-warn hover:text-warn"
                      title="Take it off the list so it can be downloaded again (the file stays)"
                    >
                      Forget
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {matched > items.length && (
            <div className="p-3 text-center">
              <button onClick={() => setLimit((l) => l + PAGE)} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60">
                Show more ({(matched - items.length).toLocaleString()} left)
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-edge px-5 py-3">
          <span className="min-w-0 flex-1 text-xs text-muted">
            {query ? `${matched.toLocaleString()} match${matched === 1 ? '' : 'es'}` : ''} Forgetting never deletes a file.
          </span>
          {total > 0 &&
            (confirmAll ? (
              <>
                <span className="text-xs text-warn">Forget all {total.toLocaleString()}?</span>
                <button onClick={() => void forgetAll()} className="rounded-lg bg-warn/20 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-warn/30">
                  Yes, forget all
                </button>
                <button onClick={() => setConfirmAll(false)} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium">
                  No
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmAll(true)} className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink">
                Forget all…
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

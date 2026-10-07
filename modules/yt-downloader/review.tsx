import { useEffect, useState } from 'react'
import { CloudUpload, HardDrive, ImagePlus, Loader2, Music, Search, Tags, TriangleAlert, X } from 'lucide-react'
import { ID, useYt } from './store'
import { TAG_FIELDS, type ArtChoice, type ReviewItem, type SongCandidate, type SongTags } from './lib/songinfo'

/* ---------------------------------------------------------------------------
 *  "Song info needed": songs MusicBrainz couldn't identify. Per song: edit the
 *  details (prefilled with cleaned-up guesses), search MusicBrainz yourself and
 *  "Use" a match, pick the cover (keep / the match's album art / an image), then
 *  Save — or Save as is. "Ignore all" saves every listed song untouched. Drive
 *  songs upload when saved. Remote images can't load in the window (CSP), so
 *  covers come from main as data URLs.
 * ------------------------------------------------------------------------- */

const inv = <T,>(action: string, arg?: unknown): Promise<T> => window.wicked.invoke(`${ID}:${action}`, arg) as Promise<T>

const fmtDur = (ms: number | null): string => {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Cover({ src, size = 'h-14 w-14' }: { src: string | null; size?: string }): React.JSX.Element {
  return (
    <span className={`flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-md bg-raised text-muted`}>
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : <Music size={18} />}
    </span>
  )
}

function CandidateRow({ c, onUse, chosen }: { c: SongCandidate; onUse: () => void; chosen: boolean }): React.JSX.Element {
  const [art, setArt] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (c.releaseId || c.releaseGroupId)
      void inv<{ ok: boolean; dataUrl?: string }>('cover-preview', { releaseId: c.releaseId, releaseGroupId: c.releaseGroupId }).then((r) => alive && r.ok && setArt(r.dataUrl ?? null))
    return () => {
      alive = false
    }
  }, [c.releaseId, c.releaseGroupId])
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 ${chosen ? 'border-accent bg-accent/10' : 'border-edge bg-surface'}`}>
      <Cover src={art} size="h-10 w-10" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {c.title} <span className="font-normal text-muted">— {c.artist}</span>
        </div>
        <div className="truncate text-xs text-muted">
          {c.releaseLabel || 'No release info'}
          {c.durationMs ? ` · ${fmtDur(c.durationMs)}` : ''}
        </div>
      </div>
      <span className={`shrink-0 text-xs tabular-nums ${c.confidence >= 0.8 ? 'text-ok' : c.confidence >= 0.6 ? 'text-warn' : 'text-muted'}`} title="How closely it matches what you searched">
        {Math.round(c.confidence * 100)}%
      </span>
      <button onClick={onUse} className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-ink hover:opacity-90">
        {chosen ? 'Using' : 'Use'}
      </button>
    </div>
  )
}

function SongEditor({ item, startOpen }: { item: ReviewItem; startOpen: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(startOpen)
  const [tags, setTags] = useState<SongTags>(item.guess)
  const [art, setArt] = useState<string | null>(null)
  const [artChoice, setArtChoice] = useState<ArtChoice>({ kind: 'keep' })
  const [picked, setPicked] = useState<{ path: string; dataUrl: string } | null>(null)
  const [matchArt, setMatchArt] = useState<string | null>(null)
  const [chosen, setChosen] = useState<SongCandidate | null>(null)
  const [results, setResults] = useState<SongCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'asis'>('')
  const [error, setError] = useState(item.error ?? '')

  useEffect(() => {
    let alive = true
    if (item.hasArt) void inv<{ ok: boolean; dataUrl?: string }>('review-art', { id: item.id }).then((r) => alive && r.ok && setArt(r.dataUrl ?? null))
    return () => {
      alive = false
    }
  }, [item.id, item.hasArt])

  const search = async (): Promise<void> => {
    setSearching(true)
    setError('')
    const r = await inv<{ ok: boolean; candidates?: SongCandidate[]; error?: string }>('review-search', { id: item.id, title: tags.title, artist: tags.artist })
    setSearching(false)
    if (!r.ok) return setError(r.error ?? 'Search failed.')
    setResults(r.candidates ?? [])
  }

  const use = (c: SongCandidate): void => {
    setChosen(c)
    setTags((t) => ({
      title: c.title || t.title,
      artist: c.artist || t.artist,
      album: c.album || t.album,
      albumArtist: c.albumArtist || t.albumArtist,
      date: c.date || t.date,
      track: c.track || t.track,
      genre: c.genre || t.genre
    }))
    setMatchArt(null)
    if (c.releaseId || c.releaseGroupId) {
      setArtChoice({ kind: 'release', releaseId: c.releaseId, releaseGroupId: c.releaseGroupId })
      void inv<{ ok: boolean; dataUrl?: string }>('cover-preview', { releaseId: c.releaseId, releaseGroupId: c.releaseGroupId }).then((r) => {
        if (r.ok) setMatchArt(r.dataUrl ?? null)
        else setArtChoice((cur) => (cur.kind === 'release' ? { kind: 'keep' } : cur)) // that release has no cover
      })
    }
  }

  const pickImage = async (): Promise<void> => {
    const r = await inv<{ ok: boolean; path?: string; dataUrl?: string; error?: string; canceled?: boolean }>('review-pick-image')
    if (r.ok && r.path && r.dataUrl) {
      setPicked({ path: r.path, dataUrl: r.dataUrl })
      setArtChoice({ kind: 'file', path: r.path })
    } else if (r.error) setError(r.error)
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setError('')
    const r = await inv<{ ok: boolean; error?: string }>('review-save', { id: item.id, tags, art: artChoice })
    setBusy('')
    if (!r.ok) setError(r.error ?? 'Couldn’t save.')
  }

  const saveAsIs = async (): Promise<void> => {
    setBusy('asis')
    setError('')
    const r = await inv<{ ok: boolean; error?: string }>('review-ignore', { ids: [item.id] })
    setBusy('')
    if (!r.ok) setError(r.error ?? 'Couldn’t save.')
  }

  const preview = artChoice.kind === 'file' ? picked?.dataUrl ?? null : artChoice.kind === 'release' ? matchArt : art
  const canSave = !!tags.title.trim() && !!tags.artist.trim() && !busy && !item.missing

  return (
    <div className={`rounded-xl border bg-surface ${open ? 'border-accent/50' : 'border-edge'}`}>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 p-3 text-left">
        <Cover src={preview} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={item.fileName}>
            {item.fileName}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            {item.toDrive ? (
              <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent">
                <CloudUpload size={11} /> Uploads to Google Drive when saved
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-full bg-raised px-2 py-0.5">
                <HardDrive size={11} /> On this PC
              </span>
            )}
            <span className="truncate">{item.jobTitle}</span>
            {item.durationMs ? <span>· {fmtDur(item.durationMs)}</span> : null}
          </div>
        </div>
        <span className="shrink-0 text-xs text-accent">{open ? 'Hide' : 'Fill in'}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-edge p-3">
          {item.missing && (
            <p className="flex items-center gap-1.5 text-xs text-danger">
              <TriangleAlert size={13} /> The file isn&apos;t there any more (moved or deleted). Close and it&apos;s removed from the list.
            </p>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TAG_FIELDS.map((f) => (
              <label key={f.key} className={f.key === 'title' || f.key === 'artist' ? 'sm:col-span-1' : ''}>
                <span className="mb-0.5 block text-[11px] font-medium text-muted">
                  {f.label}
                  {(f.key === 'title' || f.key === 'artist') && <span className="text-danger"> *</span>}
                </span>
                <input
                  value={tags[f.key]}
                  onChange={(e) => setTags((t) => ({ ...t, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="w-full rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                {item.current[f.key] && item.current[f.key] !== tags[f.key] && (
                  <span className="mt-0.5 block truncate text-[10px] text-muted" title={item.current[f.key]}>
                    In the file now: {item.current[f.key]}
                  </span>
                )}
              </label>
            ))}
          </div>

          {/* search MusicBrainz with what's typed */}
          <div className="rounded-lg border border-edge bg-raised/30 p-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs text-muted">Fix the title/artist above, then search MusicBrainz again — pick a match to fill everything in.</span>
              <button
                onClick={() => void search()}
                disabled={searching || !tags.title.trim()}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs font-medium hover:border-accent disabled:opacity-40"
              >
                {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />} Search
              </button>
            </div>
            {results && (
              <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
                {results.length === 0 ? (
                  <p className="text-xs text-muted">No matches — fill the details in yourself and save.</p>
                ) : (
                  results.map((c) => <CandidateRow key={c.recordingId} c={c} chosen={chosen?.recordingId === c.recordingId} onUse={() => use(c)} />)
                )}
              </div>
            )}
          </div>

          {/* cover choice */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Cover:</span>
            <button
              onClick={() => setArtChoice({ kind: 'keep' })}
              className={`rounded-lg border px-2.5 py-1 text-xs ${artChoice.kind === 'keep' ? 'border-accent bg-accent/10 text-ink' : 'border-edge text-muted hover:text-ink'}`}
            >
              Keep current{item.hasArt ? '' : ' (none)'}
            </button>
            <button
              disabled={!chosen || !matchArt}
              onClick={() => chosen && setArtChoice({ kind: 'release', releaseId: chosen.releaseId, releaseGroupId: chosen.releaseGroupId })}
              className={`rounded-lg border px-2.5 py-1 text-xs disabled:opacity-40 ${artChoice.kind === 'release' ? 'border-accent bg-accent/10 text-ink' : 'border-edge text-muted hover:text-ink'}`}
              title={chosen ? (matchArt ? 'The album cover of the match you picked' : 'That release has no cover in the Cover Art Archive') : 'Pick a search match first'}
            >
              Album art from match
            </button>
            <button
              onClick={() => void pickImage()}
              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs ${artChoice.kind === 'file' ? 'border-accent bg-accent/10 text-ink' : 'border-edge text-muted hover:text-ink'}`}
            >
              <ImagePlus size={12} /> {picked ? 'Image chosen' : 'Choose image…'}
            </button>
          </div>

          {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <button onClick={() => void saveAsIs()} disabled={!!busy} className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-40">
              {busy === 'asis' ? <Loader2 size={13} className="inline animate-spin" /> : null} Save as is
            </button>
            <button onClick={() => void save()} disabled={!canSave} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40">
              {busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Tags size={13} />}
              {item.toDrive ? 'Save & upload' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ReviewModal({ jobId, onClose }: { jobId?: string; onClose: () => void }): React.JSX.Element {
  const all = useYt((s) => s.reviewItems)
  const items = jobId ? all.filter((i) => i.jobId === jobId) : all
  const [ignoring, setIgnoring] = useState(false)
  const [error, setError] = useState('')

  const ignoreAll = async (): Promise<void> => {
    setIgnoring(true)
    setError('')
    const r = await inv<{ ok: boolean; saved?: number; failed?: number; error?: string }>('review-ignore', { ids: items.map((i) => i.id) })
    setIgnoring(false)
    if (!r.ok) setError(`${r.failed ?? 0} couldn’t be saved: ${r.error ?? 'unknown error'}`)
  }

  const close = (): void => {
    // files that vanished can't be saved — drop them from the list on close
    const gone = items.filter((i) => i.missing).map((i) => i.id)
    if (gone.length) void inv('review-ignore', { ids: gone })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={close}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-edge px-5 py-3">
          <Tags size={16} className="text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Song info needed</div>
            <div className="text-xs text-muted">
              MusicBrainz couldn&apos;t identify {items.length === 1 ? 'this song' : `these ${items.length} songs`}. Fill in what each should be saved with, or
              save as is.
            </div>
          </div>
          <button onClick={close} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted">All done — nothing is waiting for info.</div>
          ) : (
            items.map((it, i) => <SongEditor key={it.id} item={it} startOpen={i === 0} />)
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-edge px-5 py-3">
          {error && <span className="min-w-0 flex-1 truncate text-xs text-danger">{error}</span>}
          <span className="flex-1" />
          {items.length > 0 && (
            <button
              onClick={() => void ignoreAll()}
              disabled={ignoring}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs font-medium hover:border-warn hover:text-warn disabled:opacity-40"
              title="Save every song in this list exactly as it is"
            >
              {ignoring && <Loader2 size={13} className="animate-spin" />}
              Ignore all — save {items.length === 1 ? 'it' : `all ${items.length}`} as is
            </button>
          )}
          <button onClick={close} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

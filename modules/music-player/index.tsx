import React, { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  FolderOpen,
  ListMusic,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  RefreshCw,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { ModuleTitle } from '@/shell/moduleContext'
import {
  next,
  playQueue,
  prev,
  seek,
  setRepeat,
  setShuffle,
  setVolume,
  toggle,
  toggleMute,
  trackUrl,
  usePlayer
} from './player'
import { useMusic, wireMusicEvents } from './store'
import type { Playlist, Track } from './shared/types'

/**
 * MUSIC PLAYER — renderer UI. Pure view over two module-scope stores:
 * useMusic (library/playlists) and usePlayer (the playback engine that keeps
 * playing when this component unmounts). Left: search + artists + playlists.
 * Center: track list for the current selection. Bottom: the full player bar.
 */
const ID = 'music-player'

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

type Selection = { kind: 'artist'; artist: string } | { kind: 'playlist'; id: string } | { kind: 'all' }

const MAX_ROWS = 500

export default function MusicPlayer(): React.JSX.Element {
  const m = useMusic()
  const [search, setSearch] = useState('')
  const [sel, setSel] = useState<Selection>({ kind: 'all' })
  const [menuTrack, setMenuTrack] = useState<string | null>(null)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [bigPlayer, setBigPlayer] = useState(false)

  useEffect(() => {
    wireMusicEvents()
    if (!useMusic.getState().loaded) void useMusic.getState().init()
  }, [])

  const tracks = m.library?.tracks ?? []
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])

  const artists = useMemo(() => {
    const set = new Map<string, number>()
    for (const t of tracks) set.set(t.artist, (set.get(t.artist) ?? 0) + 1)
    return [...set.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [tracks])

  const q = search.trim().toLowerCase()
  const shown: Track[] = useMemo(() => {
    if (q) return tracks.filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
    if (sel.kind === 'artist') return tracks.filter((t) => t.artist === sel.artist)
    if (sel.kind === 'playlist') {
      const pl = m.playlists.find((p) => p.id === sel.id)
      // skip (never delete) entries whose files are missing right now
      return (pl?.trackIds ?? []).map((id) => byId.get(id)).filter((t): t is Track => !!t)
    }
    return tracks
  }, [q, sel, tracks, byId, m.playlists])

  const listTitle = q
    ? `Search: “${search.trim()}”`
    : sel.kind === 'artist'
      ? sel.artist
      : sel.kind === 'playlist'
        ? (m.playlists.find((p) => p.id === sel.id)?.name ?? 'Playlist')
        : 'All tracks'

  const playFrom = (t: Track): void => playQueue(shown.map((x) => x.id), t.id)

  const addToPlaylist = (plId: string, trackId: string): void => {
    setMenuTrack(null)
    void m.savePlaylists(
      m.playlists.map((p) =>
        p.id === plId && !p.trackIds.includes(trackId) ? { ...p, trackIds: [...p.trackIds, trackId] } : p
      )
    )
  }

  const createPlaylist = (): void => {
    const name = newPlaylistName.trim()
    if (!name) return
    setNewPlaylistName('')
    const pl: Playlist = { id: `pl-${Date.now().toString(36)}`, name, trackIds: [] }
    void m.savePlaylists([...m.playlists, pl])
    setSel({ kind: 'playlist', id: pl.id })
  }

  const removeFromPlaylist = (plId: string, trackId: string): void => {
    void m.savePlaylists(
      m.playlists.map((p) => (p.id === plId ? { ...p, trackIds: p.trackIds.filter((id) => id !== trackId) } : p))
    )
  }

  const deletePlaylist = (plId: string): void => {
    void m.savePlaylists(m.playlists.filter((p) => p.id !== plId))
    setSel({ kind: 'all' })
  }

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Music size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Music Player" />
          </h1>
          <p className="max-w-md truncate text-xs text-muted" title={m.root}>
            {m.root || 'No music folder picked yet'}
            {m.library ? ` · ${m.library.tracks.length.toLocaleString()} tracks` : ''}
            {m.library?.truncated ? ' · (capped — library partially scanned)' : ''}
          </p>
        </div>
        <span className="flex-1" />
        {m.scanning && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" />
            Scanning… {m.scanProgress ? `${m.scanProgress.files.toLocaleString()} tracks / ${m.scanProgress.dirs.toLocaleString()} folders` : ''}
          </span>
        )}
        <button
          onClick={() => void m.rescan()}
          disabled={m.scanning || !m.root}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-muted hover:border-accent/60 hover:text-ink disabled:opacity-40"
        >
          <RefreshCw size={13} /> Rescan
        </button>
        <button
          onClick={() => void m.pickFolder()}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-muted hover:border-accent/60 hover:text-ink"
        >
          <FolderOpen size={13} /> {m.root ? 'Change folder' : 'Pick music folder'}
        </button>
      </header>

      {m.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-1.5 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">{m.error}</span>
          <button onClick={() => m.setError('')} className="rounded p-0.5 hover:bg-danger/15">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left: search / playlists / artists */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-edge">
          <div className="p-2.5">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search songs & artists"
                spellCheck={false}
                className="w-full rounded-lg border border-edge bg-raised py-1.5 pl-7 pr-2 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <button
              onClick={() => {
                setSearch('')
                setSel({ kind: 'all' })
              }}
              className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${sel.kind === 'all' && !q ? 'bg-accent/10 text-accent' : 'hover:bg-raised'}`}
            >
              All tracks
            </button>

            <p className="mt-2 flex items-center gap-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
              <ListMusic size={11} /> Playlists
            </p>
            {m.playlists.map((p) => (
              <div key={p.id} className="group flex items-center">
                <button
                  onClick={() => {
                    setSearch('')
                    setSel({ kind: 'playlist', id: p.id })
                  }}
                  className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm ${
                    sel.kind === 'playlist' && sel.id === p.id && !q ? 'bg-accent/10 text-accent' : 'hover:bg-raised'
                  }`}
                >
                  {p.name} <span className="text-muted">({p.trackIds.length})</span>
                </button>
                <button
                  onClick={() => deletePlaylist(p.id)}
                  title="Delete playlist"
                  className="hidden rounded p-1 text-muted hover:text-danger group-hover:block"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="mt-1 flex items-center gap-1 px-1">
              <input
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createPlaylist()
                }}
                placeholder="New playlist…"
                className="min-w-0 flex-1 rounded-md border border-edge bg-raised px-2 py-1 text-xs outline-none focus:border-accent"
              />
              <button onClick={createPlaylist} className="rounded-md border border-edge p-1 text-muted hover:border-accent/60 hover:text-ink">
                <Plus size={12} />
              </button>
            </div>

            <p className="mt-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Artists</p>
            {artists.map(([artist, count]) => (
              <button
                key={artist}
                onClick={() => {
                  setSearch('')
                  setSel({ kind: 'artist', artist })
                }}
                className={`w-full truncate rounded-md px-2 py-1 text-left text-sm ${
                  sel.kind === 'artist' && sel.artist === artist && !q ? 'bg-accent/10 text-accent' : 'hover:bg-raised'
                }`}
                title={`${artist} (${count})`}
              >
                {artist} <span className="text-xs text-muted">({count})</span>
              </button>
            ))}
          </div>
        </aside>

        {/* center: track list */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{listTitle}</h2>
            {sel.kind === 'playlist' && !q && (
              <PlaylistAdder
                tracks={tracks}
                playlist={m.playlists.find((p) => sel.kind === 'playlist' && p.id === sel.id) ?? null}
                onAdd={(trackId) => sel.kind === 'playlist' && addToPlaylist(sel.id, trackId)}
              />
            )}
            <span className="text-xs text-muted">{shown.length.toLocaleString()} track(s)</span>
            <button
              onClick={() => shown.length > 0 && playQueue(shown.map((t) => t.id))}
              disabled={shown.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              <Play size={12} /> Play all
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!m.root && (
              <p className="p-6 text-sm text-muted">
                Pick your music folder (top right) — one folder per artist, like your network share. The scan is
                cached, so this is instant after the first time.
              </p>
            )}
            {m.root && shown.length === 0 && !m.scanning && (
              <p className="p-6 text-sm text-muted">Nothing here{q ? ' matching the search' : ' yet'}.</p>
            )}
            {shown.slice(0, MAX_ROWS).map((t) => (
              <TrackRow
                key={`${t.id}-${sel.kind}`}
                track={t}
                playlists={m.playlists}
                inPlaylist={sel.kind === 'playlist' && !q ? sel.id : null}
                menuOpen={menuTrack === t.id}
                onPlay={() => playFrom(t)}
                onMenu={() => setMenuTrack(menuTrack === t.id ? null : t.id)}
                onAdd={(plId) => addToPlaylist(plId, t.id)}
                onRemove={(plId) => removeFromPlaylist(plId, t.id)}
              />
            ))}
            {shown.length > MAX_ROWS && (
              <p className="p-3 text-center text-xs text-muted">
                Showing the first {MAX_ROWS} — narrow it down with search.
              </p>
            )}
          </div>
        </div>
      </div>

      <PlayerBar onExpand={() => setBigPlayer(true)} />
      {bigPlayer && <BigPlayer onMinimize={() => setBigPlayer(false)} />}
    </div>
  )
}

/* ---------------------------- playlist adder ------------------------------- */

/**
 * The in-playlist "add songs" box: type-ahead over the whole library with a
 * ＋ per suggestion that drops the track straight into the open playlist.
 * Stays open after adding so several songs can be queued up in one go; a
 * check mark replaces the ＋ for tracks already on the list.
 */
function PlaylistAdder({
  tracks,
  playlist,
  onAdd
}: {
  tracks: Track[]
  playlist: Playlist | null
  onAdd: (trackId: string) => void
}): React.JSX.Element | null {
  const [text, setText] = useState('')
  const q = text.trim().toLowerCase()
  const hits = useMemo(
    () =>
      q
        ? tracks
            .filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
            .slice(0, 12)
        : [],
    [q, tracks]
  )
  if (!playlist) return null
  const inList = new Set(playlist.trackIds)

  return (
    <div className="relative w-72 shrink-0 xl:w-80">
      <div className="relative">
        <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setText('')
          }}
          placeholder={`Add songs to “${playlist.name}”…`}
          spellCheck={false}
          className="w-full rounded-lg border border-edge bg-raised py-1 pl-6 pr-6 text-xs outline-none focus:border-accent"
        />
        {text && (
          <button
            onClick={() => setText('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-ink"
          >
            <X size={11} />
          </button>
        )}
      </div>
      {hits.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-edge bg-surface shadow-2xl">
          {hits.map((t) => {
            const added = inList.has(t.id)
            return (
              <div key={t.id} className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-raised">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{t.title}</span>
                  <span className="block truncate text-[11px] text-muted">{t.artist}</span>
                </span>
                <button
                  onClick={() => !added && onAdd(t.id)}
                  disabled={added}
                  title={added ? 'Already on this playlist' : 'Add to playlist'}
                  className={`shrink-0 rounded-full p-1 ${added ? 'text-ok' : 'bg-raised text-muted hover:bg-accent hover:text-accent-ink'}`}
                >
                  {added ? <Check size={13} /> : <Plus size={13} />}
                </button>
              </div>
            )
          })}
        </div>
      )}
      {q && hits.length === 0 && (
        <div className="absolute left-0 top-full z-30 mt-1 w-full rounded-lg border border-edge bg-surface p-2 text-xs text-muted shadow-2xl">
          No songs match “{text.trim()}”.
        </div>
      )}
    </div>
  )
}

/* ------------------------------- track row -------------------------------- */

function TrackRow({
  track,
  playlists,
  inPlaylist,
  menuOpen,
  onPlay,
  onMenu,
  onAdd,
  onRemove
}: {
  track: Track
  playlists: Playlist[]
  /** non-null when viewing a playlist → show "remove from this playlist" */
  inPlaylist: string | null
  menuOpen: boolean
  onPlay: () => void
  onMenu: () => void
  onAdd: (playlistId: string) => void
  onRemove: (playlistId: string) => void
}): React.JSX.Element {
  const currentId = usePlayer((s) => (s.pos >= 0 ? s.queue[s.order[s.pos]] : null))
  const playing = usePlayer((s) => s.playing)
  const isCurrent = currentId === track.id
  return (
    <div
      className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
        isCurrent ? 'bg-accent/10' : 'hover:bg-raised'
      }`}
      onDoubleClick={onPlay}
    >
      <button
        onClick={onPlay}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          isCurrent ? 'bg-accent text-accent-ink' : 'bg-raised text-muted opacity-0 group-hover:opacity-100'
        }`}
        title="Play"
      >
        {isCurrent && playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      <span className={`min-w-0 flex-1 truncate text-sm ${isCurrent ? 'font-semibold text-accent' : ''}`}>
        {track.title}
      </span>
      <span className="w-48 shrink-0 truncate text-xs text-muted">{track.artist}</span>
      {inPlaylist ? (
        <button
          onClick={() => onRemove(inPlaylist)}
          title="Remove from this playlist"
          className="rounded p-1 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
        >
          <X size={13} />
        </button>
      ) : (
        <button
          onClick={onMenu}
          title="Add to playlist"
          className="rounded p-1 text-muted opacity-0 hover:text-ink group-hover:opacity-100"
        >
          <Plus size={13} />
        </button>
      )}
      {menuOpen && (
        <div className="absolute right-2 top-9 z-30 w-52 rounded-lg border border-edge bg-surface p-1 shadow-2xl">
          {playlists.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">Create a playlist first (left panel).</p>}
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => onAdd(p.id)}
              className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-raised"
            >
              Add to “{p.name}”
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ----------------------------- volume control ------------------------------ */

/** Volume icon (click = mute) that reveals a vertical slider on hover. */
function VolumeControl(): React.JSX.Element {
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  return (
    <span className="group relative flex items-center">
      <button
        onClick={toggleMute}
        title={muted ? 'Unmute' : `Volume ${Math.round(volume * 100)}% — click to mute`}
        className={`rounded-lg p-1.5 ${muted || volume === 0 ? 'text-danger' : 'text-muted hover:text-ink'}`}
      >
        <Icon size={16} />
      </button>
      <span className="absolute bottom-full left-1/2 hidden -translate-x-1/2 pb-1 group-hover:block">
        <span className="flex flex-col items-center gap-1 rounded-lg border border-edge bg-surface p-2 shadow-2xl">
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 96, width: 20 }}
            className="accent-[rgb(var(--wk-accent))]"
          />
          <span className="text-[10px] tabular-nums text-muted">{Math.round((muted ? 0 : volume) * 100)}%</span>
        </span>
      </span>
    </span>
  )
}

/* ------------------------------- player bar -------------------------------- */

function PlayerBar({ onExpand }: { onExpand: () => void }): React.JSX.Element {
  const s = usePlayer()
  // O(1) lookup via the engine's id map — this bar re-renders on every
  // position tick, so scanning the 50k-track array here would burn CPU
  const t = s.pos >= 0 ? (s.byId.get(s.queue[s.order[s.pos]]) ?? null) : null

  return (
    <footer className="border-t border-edge bg-surface px-4 py-2.5">
      {s.error && <p className="pb-1 text-xs text-danger">{s.error}</p>}
      <div className="flex items-center gap-3">
        <button
          onClick={() => t && onExpand()}
          disabled={!t}
          title={t ? 'Open the full player' : undefined}
          className="flex min-w-0 items-center gap-3 rounded-lg text-left disabled:cursor-default"
        >
          {t?.art && s.root ? (
            <img src={trackUrl(s.root, t.art)} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
              <Music size={18} />
            </span>
          )}
          <span className="w-52 min-w-0 shrink-0">
            <span className={`block truncate text-sm font-semibold ${t ? 'hover:text-accent' : ''}`}>
              {t?.title ?? 'Nothing playing'}
            </span>
            <span className="block truncate text-xs text-muted">{t?.artist ?? 'Pick a song to start'}</span>
          </span>
        </button>

        <button
          onClick={() => setShuffle(!s.shuffle)}
          title="Shuffle"
          className={`rounded-lg p-1.5 ${s.shuffle ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}
        >
          <Shuffle size={16} />
        </button>
        <button onClick={prev} title="Previous" className="rounded-lg p-1.5 text-ink hover:text-accent">
          <SkipBack size={19} />
        </button>
        <button
          onClick={toggle}
          title={s.playing ? 'Pause' : 'Play'}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-ink hover:opacity-90"
        >
          {s.playing ? <Pause size={19} /> : <Play size={19} />}
        </button>
        <button onClick={() => next()} title="Next" className="rounded-lg p-1.5 text-ink hover:text-accent">
          <SkipForward size={19} />
        </button>
        <button
          onClick={() => setRepeat(s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off')}
          title={`Repeat: ${s.repeat}`}
          className={`rounded-lg p-1.5 ${s.repeat !== 'off' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}
        >
          {s.repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}
        </button>
        <VolumeControl />

        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted">{fmtTime(s.position)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(1, s.duration)}
          step={1}
          value={Math.min(s.position, s.duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!t}
          className="min-w-0 flex-1 accent-[rgb(var(--wk-accent))]"
        />
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted">{fmtTime(s.duration)}</span>
      </div>
    </footer>
  )
}

/* --------------------------- full-window player ---------------------------- */

/** The big Now Playing view — fills the module area; chevron drops back to the lists. */
function BigPlayer({ onMinimize }: { onMinimize: () => void }): React.JSX.Element | null {
  const s = usePlayer()
  const t = s.pos >= 0 ? (s.byId.get(s.queue[s.order[s.pos]]) ?? null) : null
  if (!t) return null // queue emptied — nothing to show, the overlay vanishes
  const art = t.art && s.root ? trackUrl(s.root, t.art) : null

  return (
    <div className="absolute inset-0 z-30 overflow-hidden bg-bg">
      {/* the cover art as a blurred backdrop, content stacked above it */}
      {art && <img src={art} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-20 blur-3xl" />}
      <div className="relative flex h-full flex-col">
        <div className="flex justify-end p-3">
          <button
            onClick={onMinimize}
            title="Back to your library"
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface/80 px-3 py-1.5 text-sm font-medium text-muted hover:border-accent/60 hover:text-ink"
          >
            <ChevronDown size={16} /> Minimize
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-8 pb-8">
          {art ? (
            <img
              src={art}
              alt=""
              className="max-h-[52vh] w-auto max-w-[80%] rounded-2xl object-contain shadow-2xl"
            />
          ) : (
            <span className="flex h-56 w-56 items-center justify-center rounded-2xl bg-raised text-accent shadow-2xl">
              <Music size={80} />
            </span>
          )}

          <div className="max-w-3xl text-center">
            <p className="truncate text-3xl font-bold tracking-tight">{t.title}</p>
            <p className="mt-1 truncate text-lg text-muted">{t.artist}</p>
          </div>

          <div className="flex w-full max-w-2xl items-center gap-3">
            <span className="w-12 shrink-0 text-right text-sm tabular-nums text-muted">{fmtTime(s.position)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(1, s.duration)}
              step={1}
              value={Math.min(s.position, s.duration || 0)}
              onChange={(e) => seek(Number(e.target.value))}
              className="min-w-0 flex-1 accent-[rgb(var(--wk-accent))]"
            />
            <span className="w-12 shrink-0 text-sm tabular-nums text-muted">{fmtTime(s.duration)}</span>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => setShuffle(!s.shuffle)}
              title="Shuffle"
              className={`rounded-lg p-2 ${s.shuffle ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}
            >
              <Shuffle size={20} />
            </button>
            <button onClick={prev} title="Previous" className="rounded-lg p-2 text-ink hover:text-accent">
              <SkipBack size={26} />
            </button>
            <button
              onClick={toggle}
              title={s.playing ? 'Pause' : 'Play'}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-xl hover:opacity-90"
            >
              {s.playing ? <Pause size={28} /> : <Play size={28} />}
            </button>
            <button onClick={() => next()} title="Next" className="rounded-lg p-2 text-ink hover:text-accent">
              <SkipForward size={26} />
            </button>
            <button
              onClick={() => setRepeat(s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off')}
              title={`Repeat: ${s.repeat}`}
              className={`rounded-lg p-2 ${s.repeat !== 'off' ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink'}`}
            >
              {s.repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
            </button>
            <VolumeControl />
          </div>
        </div>
      </div>
    </div>
  )
}

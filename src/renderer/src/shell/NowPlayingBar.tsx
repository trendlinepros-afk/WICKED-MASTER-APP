import { useNavigate } from 'react-router-dom'
import { Music, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { useNowPlaying } from '@/stores/nowPlaying'

/**
 * Sidebar mini transport — appears whenever a module publishes a playing
 * track into the shell's nowPlaying store, so tracks can be skipped/paused
 * from ANY tool. Expanded rail: art + title/artist + prev/toggle/next.
 * Collapsed rail (40px rows): a single play/pause button with the track in
 * its tooltip — three buttons don't fit the rail.
 */
export default function NowPlayingBar({ expanded }: { expanded: boolean }): React.JSX.Element | null {
  const { track, playing, controls } = useNowPlaying()
  const navigate = useNavigate()
  if (!track || !controls) return null

  const tip = `${track.title} — ${track.artist}`

  if (!expanded) {
    return (
      <button
        onClick={controls.toggle}
        title={`${playing ? 'Pause' : 'Play'}: ${tip}`}
        className="relative flex h-10 w-10 items-center justify-center rounded-lg text-accent transition-colors hover:bg-raised/70"
      >
        {playing ? <Pause size={18} strokeWidth={1.8} /> : <Play size={18} strokeWidth={1.8} />}
        {playing && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />}
      </button>
    )
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
      <button
        onClick={() => navigate(track.route)}
        title={tip}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        {track.artUrl ? (
          <img src={track.artUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-raised text-accent">
            <Music size={15} />
          </span>
        )}
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-ink">{track.title}</span>
          <span className="block truncate text-[10px] text-muted">{track.artist}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center">
        <button onClick={controls.prev} title="Previous" className="rounded p-1 text-muted hover:text-ink">
          <SkipBack size={14} />
        </button>
        <button
          onClick={controls.toggle}
          title={playing ? 'Pause' : 'Play'}
          className="rounded p-1 text-accent hover:opacity-80"
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button onClick={controls.next} title="Next" className="rounded p-1 text-muted hover:text-ink">
          <SkipForward size={14} />
        </button>
      </span>
    </div>
  )
}

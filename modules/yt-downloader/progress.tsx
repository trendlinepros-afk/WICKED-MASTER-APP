import type { Progress } from './store'

/**
 * Job progress shared by the Custom Playlist Downloader and the Total Channel
 * Downloader: an OVERALL bar for the whole project (all items) above a bar for
 * the item currently downloading. During the stitch phase ffmpeg exposes no
 * per-clip percentage, so the second bar pulses as a "working" indicator.
 */
export function JobProgress({
  state,
  progress
}: {
  state: string
  progress: Progress | null
}): React.JSX.Element {
  const multi = !!progress && progress.total > 1
  const combining = state === 'combining'
  const itemPct = Math.min(100, progress?.percent ?? 0)
  // combine progress is already whole-project (done/total); downloads compose
  // finished items + the current item's own percentage
  const overallPct = !progress
    ? 0
    : combining
      ? itemPct
      : multi
        ? Math.min(100, ((Math.max(1, progress.index) - 1 + itemPct / 100) / progress.total) * 100)
        : itemPct

  return (
    <div className="mt-3 space-y-2">
      {multi && progress && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
            <span>
              Overall — {combining ? 'clip' : 'video'} {progress.index} of {progress.total}
            </span>
            <span className="shrink-0 tabular-nums">{overallPct.toFixed(0)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent/60 transition-[width]" style={{ width: `${overallPct}%` }} />
          </div>
        </>
      )}
      {combining ? (
        <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        </div>
      ) : (
        <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${itemPct}%` }} />
        </div>
      )}
      {progress && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">{progress.title || '…'}</span>
          <span className="shrink-0 tabular-nums">
            {combining
              ? 'preparing…'
              : `${itemPct.toFixed(1)}%${progress.speed ? ` · ${progress.speed}` : ''}${progress.eta ? ` · ETA ${progress.eta}` : ''}`}
          </span>
        </div>
      )}
    </div>
  )
}

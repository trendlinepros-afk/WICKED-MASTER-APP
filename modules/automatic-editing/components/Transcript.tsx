/**
 * Transcript — time-linked to the timeline. Word/segment times are SOURCE
 * time; the preview video plays TRIMMED time, so seeking converts source →
 * trimmed and the active-word highlight converts the video clock back to
 * source. Segments are memoized: during playback only the segment under the
 * playhead re-renders, not the whole (possibly hour-long) transcript.
 */
import { memo, useCallback, useMemo } from 'react'
import { useStore, formatTime } from '../store'
import { panel, segSelected, word, wordActive, wordCut } from '../lib/ui'
import { cutsToKeepSegments, sourceToTrimmedTime, trimmedToSourceTime } from '../shared/timemap'
import type { TimeRegion, TranscriptSegment } from '../shared/types'

export default function Transcript() {
  const project = useStore((s) => s.project)
  const currentTime = useStore((s) => s.currentTime)
  const selection = useStore((s) => s.selection)

  const keep = useMemo(
    () =>
      project
        ? (project.trimKeep ?? cutsToKeepSegments(project.edl.cuts, project.source?.durationSec ?? 0))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.trimKeep, project?.edl.version, project?.source?.durationSec]
  )

  // Non-rejected cut regions, sorted — used to strike words that will be removed.
  const cutRegions = useMemo(
    () =>
      (project?.edl.cuts ?? [])
        .filter((c) => c.status !== 'rejected')
        .map((c) => ({ start: c.start, end: c.end }))
        .sort((a, b) => a.start - b.start),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.edl.version]
  )

  // Referentially STABLE callbacks (they read fresh state via getState) —
  // otherwise every SegmentRow's memo() is defeated by new function
  // identities on each ~4Hz timeupdate render.
  const toggleSegment = useCallback((id: string) => {
    const s = useStore.getState()
    const cur = s.selection.segmentIds
    s.setSelection({ segmentIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }, [])

  const seekSource = useCallback(
    (t: number) => useStore.getState().seek(sourceToTrimmedTime(t, keep)),
    [keep]
  )

  if (!project) return null
  if (!project.transcript) {
    return (
      <div className={`${panel} flex-1 min-h-0 p-4 text-sm text-muted`}>
        No transcript yet. Run the pipeline — stage 1 transcribes the audio first (cost estimate shown before it runs).
      </div>
    )
  }

  // Video clock (trimmed) → source time, once per render.
  const srcTime = trimmedToSourceTime(currentTime, keep)

  return (
    <div className={`${panel} flex-1 min-h-0 overflow-y-auto p-3 leading-relaxed select-text`}>
      <div className="flex items-center justify-between mb-2 text-xs text-muted sticky top-0 bg-surface pb-1">
        <span className="font-semibold text-ink">Transcript</span>
        <span>
          {selection.segmentIds.length > 0
            ? `${selection.segmentIds.length} segment(s) selected for revision`
            : 'Click a word to seek · check segments to target a revision'}
          {project.transcript.source === 'mock' && <span className="ml-2 text-warn">mock transcript (no OpenAI key)</span>}
        </span>
      </div>

      {project.transcript.segments.map((seg) => {
        const active = srcTime >= seg.start && srcTime < seg.end
        return (
          <SegmentRow
            key={seg.id}
            seg={seg}
            // Only the active segment receives the live clock — every other
            // row's props are stable, so memo() skips them during playback.
            srcTime={active ? srcTime : -1}
            active={active}
            selected={selection.segmentIds.includes(seg.id)}
            cutRegions={cutRegions}
            onToggle={toggleSegment}
            onSeek={seekSource}
          />
        )
      })}
    </div>
  )
}

interface RowProps {
  seg: TranscriptSegment
  srcTime: number
  active: boolean
  selected: boolean
  cutRegions: TimeRegion[]
  onToggle: (id: string) => void
  onSeek: (t: number) => void
}

const SegmentRow = memo(function SegmentRow({ seg, srcTime, active, selected, cutRegions, onToggle, onSeek }: RowProps) {
  const isCutTime = (t: number) => {
    for (const c of cutRegions) {
      if (t < c.start) return false // sorted — no later region can match
      if (t < c.end) return true
    }
    return false
  }

  return (
    <div className={`group flex gap-2 rounded px-1.5 py-0.5 ${selected ? segSelected : ''} ${active ? 'bg-raised' : ''}`}>
      <label className="shrink-0 flex items-start pt-1 gap-1.5 w-20 cursor-pointer">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(seg.id)}
          className="accent-accent"
          aria-label={`Select segment at ${formatTime(seg.start)}`}
        />
        <span className="text-[10px] font-mono text-muted group-hover:text-accent">{formatTime(seg.start)}</span>
      </label>
      <p className="text-sm text-ink">
        {seg.words.length > 0 ? (
          seg.words.map((w, i) => {
            const wActive = srcTime >= w.start && srcTime < w.end
            const wCut = isCutTime((w.start + w.end) / 2)
            return (
              <span
                key={i}
                className={`${word} ${wActive ? wordActive : ''} ${wCut ? wordCut : ''}`}
                onClick={() => onSeek(w.start)}
                title={wCut ? 'Inside a cut region — will be removed' : formatTime(w.start)}
              >
                {w.word.trim()}{' '}
              </span>
            )
          })
        ) : (
          <span className={word} onClick={() => onSeek(seg.start)}>
            {seg.text}
          </span>
        )}
      </p>
    </div>
  )
})

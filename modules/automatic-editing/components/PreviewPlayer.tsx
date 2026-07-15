import { useEffect, useRef } from 'react'
import { useStore, formatTime } from '../store'
import { api } from '../lib/api'
import { btn, btnPrimary, panel } from '../lib/ui'
import { EXPORT_PRESETS } from '../shared/types'

export default function PreviewPlayer() {
  const { project, currentTime, setCurrentTime, seekRequest, clearSeekRequest } = useStore()
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (seekRequest !== null && videoRef.current) {
      videoRef.current.currentTime = seekRequest
      clearSeekRequest()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest])

  // Streams through the module's root-restricted wcmedia:// protocol.
  const src = project?.previewPath ? `wcmedia://${encodeURIComponent(project.previewPath)}` : null

  return (
    <div className={`${panel} h-full flex flex-col overflow-hidden`}>
      <div className="flex-1 min-h-0 bg-black flex items-center justify-center">
        {src ? (
          <video
            ref={videoRef}
            // Remount ONLY when a new preview render lands — not on every
            // project save (that would reset playback on each EDL edit).
            key={src + (project?.stages.preview.finishedAt ?? '')}
            src={src}
            className="max-h-full max-w-full"
            controls
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              // Apply a seek that was requested before the element was ready
              // (e.g. during a remount), which the effect would otherwise drop.
              if (seekRequest !== null) {
                e.currentTarget.currentTime = seekRequest
                clearSeekRequest()
              }
            }}
          />
        ) : (
          <div className="text-center p-8">
            <p className="text-white/70 mb-1">No preview yet.</p>
            <p className="text-sm text-white/40">Run the pipeline to render a 540p review preview.</p>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 px-3 py-2 border-t border-edge text-xs text-muted">
        <span className="font-mono text-accent">{formatTime(currentTime)}</span>
        <span className="text-muted/70">540p review preview — not the deliverable</span>
        <div className="flex-1" />
        {project && !project.approved && project.previewPath && (
          <button
            className={`${btnPrimary} text-xs`}
            onClick={async () => {
              if (confirm('Approve the final edit? You can still export and generate shorts afterward.')) {
                await api.approveFinal(project.id)
              }
            }}
          >
            Approve final
          </button>
        )}
        {project?.approved && (
          <>
            {EXPORT_PRESETS.map((p) => (
              <button key={p.id} className={`${btn} text-xs`} onClick={() => api.exportFinal(project.id, p.id)}>
                Export {p.label}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

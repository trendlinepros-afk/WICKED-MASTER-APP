/**
 * Shorts — post-approval OpusClip stage. Upload final render → submit clip
 * project → poll → list generated shorts with preview + download links.
 */
import { useStore, formatTime } from '../store'
import { api } from '../lib/api'
import { btn, btnPrimary, panel } from '../lib/ui'

export default function ShortsPanel() {
  const { project, settings, applyProjectPush } = useStore()
  if (!project) return null

  const hostingReady = settings?.hosting.configured
  const keyReady = settings?.keysPresent.opusclip
  const canGenerate = project.approved && project.finalPath

  return (
    <div className="p-8 max-w-3xl mx-auto overflow-y-auto h-full space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink">Generate Shorts</h1>
        <p className="text-sm text-muted mt-1">
          OpusClip turns your approved final render into short-form clips. Minimum ~10 credits (≈10 minutes of video)
          per project.
        </p>
      </div>

      {!project.approved && (
        <div className={`${panel} p-4 text-sm text-warn`}>Approve the final edit in the Editor before generating shorts.</div>
      )}
      {project.approved && !project.finalPath && (
        <div className={`${panel} p-4 text-sm text-warn`}>Export a final render first (Editor → Export).</div>
      )}
      {!hostingReady && (
        <div className={`${panel} p-4 text-sm text-warn`}>
          OpusClip needs your video reachable by URL. Set the bucket in this module&apos;s Settings → Hosting and the
          s3-access / s3-secret keys in the shell Settings → API Keys first.
        </div>
      )}
      {!keyReady && (
        <div className={`${panel} p-4 text-sm text-warn`}>
          No OpusClip API key saved. Add it in the shell Settings → API Keys (requires Pro Beta / Max / Business plan).
        </div>
      )}

      <button
        className={btnPrimary}
        disabled={!canGenerate || !hostingReady || !keyReady}
        onClick={() => api.generateShorts(project.id)}
      >
        Upload final render &amp; generate shorts
      </button>

      {project.shorts.map((s) => (
        <div key={s.id} className={`${panel} p-4`}>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-ink">Batch {new Date(s.createdAt).toLocaleString()}</span>
            <span className={`text-xs uppercase tracking-wide ${s.status === 'error' ? 'text-danger' : s.status === 'done' ? 'text-ok' : 'text-warn'}`}>
              {s.status}
            </span>
            <div className="flex-1" />
            {s.status === 'processing' && (
              <button
                className={`${btn} text-xs`}
                onClick={async () => applyProjectPush(await api.refreshShorts(project.id))}
              >
                Refresh
              </button>
            )}
          </div>
          {s.error && <p className="text-xs text-danger mb-2">{s.error}</p>}
          {s.clips.length > 0 && (
            <div className="grid gap-2">
              {s.clips.map((c) => (
                <div key={c.id} className="flex items-center gap-3 bg-raised rounded-md p-2.5 text-sm">
                  <span className="flex-1 text-ink truncate">{c.title ?? c.id}</span>
                  {c.durationSec !== undefined && <span className="text-xs font-mono text-muted">{formatTime(c.durationSec)}</span>}
                  {c.viralityScore !== undefined && <span className="text-xs text-accent">virality {c.viralityScore}</span>}
                  {c.previewUrl && (
                    <a className="text-xs text-accent hover:underline" href={c.previewUrl} target="_blank" rel="noreferrer">
                      preview
                    </a>
                  )}
                  {c.downloadUrl && (
                    <a className="text-xs text-accent hover:underline" href={c.downloadUrl} target="_blank" rel="noreferrer">
                      download
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

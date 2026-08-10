import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  FolderOpen,
  Loader2,
  Search,
  Tv,
  X
} from 'lucide-react'
import { QUALITIES, isAudioPreset } from '../yt-downloader/store'

const ID = 'yt-channel-downloader'

interface Progress {
  index: number
  total: number
  percent: number
  speed: string
  eta: string
  title: string
}

interface ChannelProbe {
  url: string
  channel: string
  count: number
}

type Phase = 'idle' | 'running' | 'combining' | 'done' | 'warning' | 'error' | 'cancelled'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

const VIDEO_QUALITIES = QUALITIES.filter((q) => !isAudioPreset(q.id))

export default function ChannelDownloader(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ChannelProbe | null>(null)
  const [quality, setQuality] = useState('1080')
  const [combine, setCombine] = useState(true)
  const [error, setError] = useState('')
  const [downloadDir, setDownloadDir] = useState('')
  const [ffmpegReady, setFfmpegReady] = useState(true)

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [combinedPath, setCombinedPath] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const st = (await invoke('status')) as { downloadDir?: string; ffmpegReady?: boolean; busy?: boolean }
      if (st.downloadDir) setDownloadDir(st.downloadDir)
      setFfmpegReady(st.ffmpegReady !== false)
    })()
    const off = window.wicked.on(`${ID}:progress`, (raw) => {
      const p = raw as { kind?: string; note?: string; done?: number; total?: number; label?: string } & Progress
      if (p.kind === 'note' && p.note) {
        setLog((l) => [...l.slice(-60), p.note as string])
        setMessage(p.note)
      } else if (p.kind === 'combine') {
        const total = Number(p.total) || 1
        const done = Number(p.done) || 0
        setPhase('combining')
        setMessage(String(p.label ?? 'Stitching…'))
        setProgress({ index: done, total, percent: (done / total) * 100, speed: '', eta: '', title: String(p.label ?? '') })
      } else if (p.kind === 'progress') {
        setProgress({ index: p.index, total: p.total, percent: p.percent, speed: p.speed, eta: p.eta, title: p.title })
      }
    })
    return off
  }, [])

  const doProbe = async (): Promise<void> => {
    if (!url.trim() || probing) return
    setProbing(true)
    setError('')
    setProbe(null)
    const res = (await invoke('probe', { url })) as { ok?: boolean; url?: string; channel?: string; count?: number; error?: string }
    setProbing(false)
    if (res.ok && res.url) setProbe({ url: res.url, channel: res.channel ?? 'Channel', count: res.count ?? 0 })
    else setError(res.error ?? 'Could not read that channel.')
  }

  const start = async (): Promise<void> => {
    if (phase === 'running' || phase === 'combining' || !url.trim()) return
    setPhase('running')
    setProgress(null)
    setLog([])
    setCombinedPath(null)
    setError('')
    setMessage('Starting channel download…')
    const res = (await invoke('download', {
      url,
      quality,
      combine,
      channel: probe?.channel ?? ''
    })) as {
      ok?: boolean
      warning?: boolean
      cancelled?: boolean
      completed?: number
      error?: string
      combined?: { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean } | null
    }

    const c = res.combined
    if (c?.ok && c.path) setCombinedPath(c.path)
    const combineMsg = c
      ? c.ok
        ? ` 🎬 Stitched ${Number(c.used) || 0} videos into one movie (oldest → newest).`
        : c.cancelled
          ? ' (Stitch cancelled.)'
          : ` (Couldn’t stitch: ${c.error ?? 'unknown error'})`
      : ''

    if (res.cancelled) {
      setPhase('cancelled')
      setMessage('Channel download cancelled.')
    } else if (res.ok && !res.warning) {
      setPhase(c && !c.ok && !c.cancelled ? 'warning' : 'done')
      setMessage(`Done — ${Number(res.completed) || 0} video(s) downloaded.${combineMsg}`)
    } else if (res.warning) {
      setPhase('warning')
      setMessage(`Finished with some skips — ${Number(res.completed) || 0} downloaded.${combineMsg} ${res.error ?? ''}`.trim())
    } else {
      setPhase('error')
      setMessage(res.error ?? 'Channel download failed.')
    }
    setProgress(null)
  }

  const busy = phase === 'running' || phase === 'combining'

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-danger">
          <Tv size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight"><ModuleTitle fallback="Total Channel Downloader" /></h1>
          <p className="truncate text-xs text-muted">
            Every long-form video from a creator (no Shorts), oldest → newest — optionally as one giant movie.
            {downloadDir && (
              <>
                {' '}·{' '}
                <button onClick={() => void invoke('open-folder')} className="text-accent hover:underline">
                  {downloadDir}
                </button>
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => void invoke('open-folder')}
          className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
        >
          <FolderOpen size={14} /> Folder
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button onClick={() => setError('')} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto grid max-w-[1400px] grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]">
          {/* setup */}
          <div className="space-y-5">
            <div className="rounded-xl border border-edge bg-surface p-4">
              <label className="text-sm font-semibold">YouTube channel URL</label>
              <div className="mt-2 flex gap-2">
                <input
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    setProbe(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void doProbe()
                  }}
                  placeholder="youtube.com/@creator  ·  youtube.com/channel/UC…"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => void doProbe()}
                  disabled={probing || !url.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
                >
                  {probing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  Check
                </button>
              </div>
              {probe && (
                <div className="mt-3 rounded-lg border border-edge bg-raised/40 p-3">
                  <div className="text-sm font-semibold">{probe.channel}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {probe.count} long-form video(s) on the Videos tab — Shorts, posts and live streams are excluded.
                  </div>
                  {probe.count >= 50 && (
                    <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      That's a lot of video. Downloading and re-encoding {probe.count} videos can take many hours
                      and a lot of disk space.
                    </p>
                  )}
                </div>
              )}
              <p className="mt-2 text-xs text-muted">
                Only the channel's <strong>Videos</strong> tab is used, so Shorts and community posts never
                come along. Videos download oldest → newest and are numbered in that order.
              </p>
            </div>

            {/* quality */}
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="text-sm font-semibold">Quality</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {VIDEO_QUALITIES.map((q) => (
                  <button
                    key={q.id}
                    onClick={() => setQuality(q.id)}
                    title={q.note}
                    className={`rounded-lg border px-3 py-2 text-left text-xs ${
                      quality === q.id ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'
                    }`}
                  >
                    <div className="font-semibold">{q.label}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* combine */}
            <div className="rounded-xl border border-edge bg-surface p-4">
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={combine}
                  onChange={(e) => setCombine(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[rgb(var(--wk-accent))]"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Film size={14} className="text-accent" />
                    Stitch everything into one movie
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    After the downloads finish, all videos are re-encoded to a matching format and joined into a
                    single file <strong>in order, oldest → newest</strong> — the creator's whole story in one
                    sitting. Saved in the channel's folder alongside the individual videos.
                  </span>
                </span>
              </label>
              {combine && !ffmpegReady && (
                <p className="mt-2 flex items-start gap-1.5 border-t border-edge pt-2 text-xs text-warn">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  ffmpeg isn&apos;t available, so stitching will be skipped — the videos still download.
                </p>
              )}
            </div>

            <div className="rounded-xl border border-edge bg-surface p-4">
              <button
                onClick={() => void start()}
                disabled={busy || !url.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <Download size={16} />
                Download {probe ? `all ${probe.count} videos from ${probe.channel}` : 'the entire channel'}
                {combine ? ' · then stitch' : ''}
              </button>
              <p className="mt-2 text-xs text-muted">
                Long channels can run for hours — this won&apos;t time out, and already-downloaded videos are
                skipped on a re-run.
              </p>
            </div>
          </div>

          {/* status */}
          <div className="space-y-4">
            {phase === 'idle' ? (
              <div className="rounded-xl border border-dashed border-edge p-10 text-center text-sm text-muted">
                <Tv size={24} className="mx-auto mb-3 opacity-40" />
                Paste a channel URL, hit Check to see what&apos;s there, then start the download.
                <br />
                Progress shows here.
              </div>
            ) : (
              <div
                className={`rounded-xl border bg-surface p-4 ${
                  phase === 'done'
                    ? 'border-ok/40'
                    : phase === 'error'
                      ? 'border-danger/40'
                      : phase === 'warning'
                        ? 'border-warn/40'
                        : busy
                          ? 'border-accent/50'
                          : 'border-edge'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 shrink-0">
                    {phase === 'running' && <Loader2 size={16} className="animate-spin text-accent" />}
                    {phase === 'combining' && <Film size={16} className="animate-pulse text-accent" />}
                    {phase === 'done' && <CheckCircle2 size={16} className="text-ok" />}
                    {(phase === 'warning' || phase === 'error') && (
                      <AlertTriangle size={16} className={phase === 'error' ? 'text-danger' : 'text-warn'} />
                    )}
                    {phase === 'cancelled' && <X size={16} className="text-muted" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">
                      {probe?.channel ?? 'Channel download'}
                      <span className="ml-2 text-xs font-normal text-muted">
                        {phase === 'running'
                          ? 'downloading oldest → newest'
                          : phase === 'combining'
                            ? 'stitching oldest → newest'
                            : phase}
                      </span>
                    </div>
                  </div>
                  {busy && (
                    <button
                      onClick={() => void invoke('cancel')}
                      className="shrink-0 rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60"
                    >
                      Cancel
                    </button>
                  )}
                </div>

                {busy && (
                  <div className="mt-3 space-y-2">
                    {progress && progress.total > 1 && (
                      <div className="text-xs font-medium text-muted">
                        {phase === 'combining' ? 'Clip' : 'Video'} {progress.index} of {progress.total}
                      </div>
                    )}
                    <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
                      <div
                        className="h-full rounded-full bg-accent transition-[width]"
                        style={{ width: `${Math.min(100, progress?.percent ?? 0)}%` }}
                      />
                    </div>
                    {progress && (
                      <div className="flex items-center justify-between gap-2 text-xs text-muted">
                        <span className="min-w-0 truncate">{progress.title || '…'}</span>
                        <span className="shrink-0 tabular-nums">
                          {progress.percent.toFixed(1)}% {progress.speed && `· ${progress.speed}`}{' '}
                          {progress.eta && `· ETA ${progress.eta}`}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <p className={`mt-2.5 text-sm ${phase === 'error' ? 'text-danger' : phase === 'warning' ? 'text-warn' : busy ? 'text-muted' : 'text-ink'}`}>
                  {message}
                </p>
                {combinedPath && (
                  <p className="mt-1 break-all text-xs text-accent" title={combinedPath}>
                    <Film size={12} className="mr-1 inline" />
                    Saved: {combinedPath}
                  </p>
                )}
                {phase === 'done' && (
                  <button onClick={() => void invoke('open-folder')} className="mt-1.5 text-sm text-accent hover:underline">
                    Open download folder
                  </button>
                )}

                {log.length > 0 && (
                  <div className="mt-3 rounded-lg border border-edge bg-raised/30 p-2.5">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted/80">Activity</div>
                    <div className="mt-1.5 max-h-64 space-y-0.5 overflow-y-auto font-mono text-xs leading-relaxed text-muted">
                      {log.slice(-50).map((l, i) => (
                        <div key={i} className="break-all">
                          {l}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

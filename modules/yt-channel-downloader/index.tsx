import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Film,
  FolderOpen,
  History,
  Loader2,
  RefreshCw,
  Search,
  Tv,
  X
} from 'lucide-react'
import { QUALITIES, isAudioPreset } from '../yt-downloader/store'
import { JobProgress } from '../yt-downloader/progress'

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

interface ChannelRecord {
  id: string
  url: string
  channel: string
  folder: string | null
  quality: string
  downloadedCount: number
  stitchedCount: number
  lastDownloadAt: number
  lastStitchAt: number | null
  lastStitchPath: string | null
  autoRescan: boolean
  /** videos fetched by launch-time auto-rescan, awaiting a stitch decision */
  autoDownloadedPending: number
}

interface RescanResult {
  id: string
  channel: string
  remoteCount: number
  downloadedCount: number
  newCount: number
  backlog: number
}

type Phase = 'idle' | 'running' | 'combining' | 'done' | 'warning' | 'error' | 'cancelled'

interface JobResult {
  ok?: boolean
  warning?: boolean
  cancelled?: boolean
  completed?: number
  error?: string
  combined?: { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean } | null
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

const VIDEO_QUALITIES = QUALITIES.filter((q) => !isAudioPreset(q.id))

const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

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
  const [jobLabel, setJobLabel] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [combinedPath, setCombinedPath] = useState<string | null>(null)

  const [history, setHistory] = useState<ChannelRecord[]>([])
  const [rescanBusy, setRescanBusy] = useState<string | null>(null)
  const [rescan, setRescan] = useState<RescanResult | null>(null)
  /** channels whose auto-rescan grabbed videos awaiting a stitch decision */
  const [autoQueue, setAutoQueue] = useState<ChannelRecord[]>([])

  const loadHistory = async (): Promise<ChannelRecord[]> => {
    const res = (await invoke('history')) as { ok?: boolean; channels?: ChannelRecord[] }
    const channels = res.ok && res.channels ? res.channels : []
    if (res.ok) setHistory(channels)
    return channels
  }

  useEffect(() => {
    void (async () => {
      const st = (await invoke('status')) as { downloadDir?: string; ffmpegReady?: boolean }
      if (st.downloadDir) setDownloadDir(st.downloadDir)
      setFfmpegReady(st.ffmpegReady !== false)
      const channels = await loadHistory()
      // auto-rescan fetched new videos while you were away → ask about stitching
      setAutoQueue(channels.filter((c) => c.autoDownloadedPending > 0))
    })()
    const off = window.wicked.on(`${ID}:progress`, (raw) => {
      const p = raw as {
        kind?: string
        note?: string
        done?: number
        total?: number
        label?: string
        mode?: string
        resumed?: boolean
        ok?: boolean
        warning?: boolean
        cancelled?: boolean
        completed?: number
        error?: string
        combined?: JobResult['combined']
      } & Progress
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
      } else if (p.kind === 'job-start') {
        // covers jobs this UI didn't start: crash resume + launch auto-rescan
        setPhase(p.mode === 'stitch' ? 'combining' : 'running')
        setJobLabel(`${String(p.label ?? 'Channel job')}${p.resumed ? ' (resumed)' : ''}`)
        setProgress(null)
        setLog([])
        setCombinedPath(null)
        setMessage(p.resumed ? 'Resumed after restart — finished videos are skipped.' : 'Starting…')
      } else if (p.kind === 'job-end') {
        finishJob(p as unknown as JobResult, p.mode === 'stitch' ? 'Stitch' : 'Channel download')
      }
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const busy = phase === 'running' || phase === 'combining'

  const finishJob = (res: JobResult, what: string): void => {
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
      setMessage(`${what} cancelled.`)
    } else if (res.ok && !res.warning) {
      setPhase(c && !c.ok && !c.cancelled ? 'warning' : 'done')
      setMessage(
        res.completed != null
          ? `Done — ${Number(res.completed) || 0} video(s) downloaded.${combineMsg}`
          : `Done.${combineMsg}`
      )
    } else if (res.warning) {
      setPhase('warning')
      setMessage(`Finished with some skips — ${Number(res.completed) || 0} downloaded.${combineMsg} ${res.error ?? ''}`.trim())
    } else {
      setPhase('error')
      setMessage(res.error ?? `${what} failed.`)
    }
    setProgress(null)
    void loadHistory()
  }

  const runDownload = async (opts: {
    url: string
    quality: string
    combine: boolean
    channel: string
    folder?: string | null
  }): Promise<void> => {
    if (busy) return
    setPhase('running')
    setJobLabel(opts.channel || 'Channel download')
    setProgress(null)
    setLog([])
    setCombinedPath(null)
    setError('')
    setMessage('Starting channel download…')
    const res = (await invoke('download', opts)) as JobResult & { started?: boolean }
    // once started, job-start / job-end events drive the card (they also cover
    // resumed and auto-rescan jobs); only pre-claim rejections land here
    if (res.started !== true && res.ok !== true) {
      setPhase('error')
      setMessage(res.error ?? 'Channel download failed.')
      setProgress(null)
    }
  }

  const runStitch = async (rec: ChannelRecord): Promise<void> => {
    if (busy) return
    setPhase('combining')
    setJobLabel(rec.channel || 'Channel stitch')
    setProgress(null)
    setLog([])
    setCombinedPath(null)
    setError('')
    setMessage('Preparing the complete stitched movie…')
    const res = (await invoke('stitch', { id: rec.id })) as JobResult & { started?: boolean }
    if (res.started !== true && res.ok !== true) {
      setPhase('error')
      setMessage(res.error ?? 'Stitch failed.')
      setProgress(null)
    }
  }

  const doRescan = async (rec: ChannelRecord): Promise<void> => {
    if (rescanBusy || busy) return
    setRescanBusy(rec.id)
    setError('')
    const res = (await invoke('rescan', { id: rec.id })) as (RescanResult & { ok?: boolean; error?: string }) | null
    setRescanBusy(null)
    if (res?.ok) setRescan(res)
    else setError(res?.error ?? 'Rescan failed.')
  }

  const setAuto = async (rec: ChannelRecord, enabled: boolean): Promise<void> => {
    await invoke('set-auto', { id: rec.id, enabled })
    await loadHistory()
  }

  const dismissAutoAlert = async (rec: ChannelRecord, stitch: boolean): Promise<void> => {
    setAutoQueue((q) => q.filter((c) => c.id !== rec.id))
    if (stitch) {
      await runStitch(rec)
    } else {
      await invoke('ack-auto', { id: rec.id })
      await loadHistory()
    }
  }

  const rescanRecord = rescan ? history.find((h) => h.id === rescan.id) ?? null : null

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
                    single file <strong>in order, oldest → newest</strong>. Saved in the channel's folder. If you
                    skip it now, a later rescan can complete the full movie any time.
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
                onClick={() =>
                  void runDownload({ url, quality, combine, channel: probe?.channel ?? '' })
                }
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

            {/* channel history */}
            {history.length > 0 && (
              <div className="rounded-xl border border-edge bg-surface p-4">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <History size={14} className="text-accent" /> Downloaded channels
                </div>
                <div className="mt-2 space-y-2">
                  {history.map((rec) => {
                    const backlog = Math.max(0, rec.downloadedCount - rec.stitchedCount)
                    return (
                      <div key={rec.id} className="rounded-lg border border-edge bg-raised/40 p-2.5">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{rec.channel || 'Channel'}</div>
                            <div className="mt-0.5 text-[11px] text-muted">
                              {rec.downloadedCount} video(s) · last download {fmtDate(rec.lastDownloadAt)}
                            </div>
                            <div className={`mt-0.5 text-[11px] ${backlog > 0 ? 'text-warn' : rec.stitchedCount > 0 ? 'text-ok' : 'text-muted'}`}>
                              {rec.stitchedCount === 0
                                ? 'Never stitched into a movie'
                                : backlog > 0
                                  ? `${backlog} video(s) not yet in the stitched movie`
                                  : 'Stitched movie is complete'}
                              {rec.autoDownloadedPending > 0 && ` · ${rec.autoDownloadedPending} auto-downloaded`}
                            </div>
                          </div>
                          <button
                            onClick={() => void doRescan(rec)}
                            disabled={rescanBusy !== null || busy}
                            title="Check this channel for new uploads"
                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium hover:bg-raised disabled:opacity-40"
                          >
                            {rescanBusy === rec.id ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <RefreshCw size={13} />
                            )}
                            Rescan
                          </button>
                        </div>
                        <label className="mt-1.5 flex w-fit cursor-pointer items-center gap-1.5 text-[11px] text-muted hover:text-ink">
                          <input
                            type="checkbox"
                            checked={rec.autoRescan}
                            onChange={(e) => void setAuto(rec, e.target.checked)}
                            className="h-3.5 w-3.5 accent-[rgb(var(--wk-accent))]"
                          />
                          Auto rescan — grab new uploads at every app launch (stitching still asks first)
                        </label>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* status */}
          <div className="space-y-4">
            {phase === 'idle' ? (
              <div className="rounded-xl border border-dashed border-edge p-10 text-center text-sm text-muted">
                <Tv size={24} className="mx-auto mb-3 opacity-40" />
                Paste a channel URL, hit Check to see what&apos;s there, then start the download.
                <br />
                Downloaded channels appear in the history — Rescan them any time for new uploads.
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
                      {jobLabel}
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

                {busy && <JobProgress state={phase} progress={progress} />}

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

      {/* auto-rescan "new videos arrived while you were away" popup */}
      {!rescan && autoQueue.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-xl border border-edge bg-surface p-5 shadow-xl">
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="text-accent" />
              <span className="text-sm font-semibold">{autoQueue[0].channel || 'Channel'}</span>
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
                Auto rescan
              </span>
            </div>
            <p className="mt-3 text-sm">
              While you were away, <strong>{autoQueue[0].autoDownloadedPending} new video(s)</strong> from this
              channel were downloaded automatically. They are not in the stitched movie yet
              {Math.max(0, autoQueue[0].downloadedCount - autoQueue[0].stitchedCount) >
                autoQueue[0].autoDownloadedPending &&
                ` (${Math.max(0, autoQueue[0].downloadedCount - autoQueue[0].stitchedCount)} unstitched in total)`}
              .
            </p>
            <p className="mt-2 text-xs text-muted">
              Creating the movie now stitches ALL {autoQueue[0].downloadedCount} downloaded videos into one
              complete film, oldest → newest.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => void dismissAutoAlert(autoQueue[0], true)}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <Film size={14} /> Create the new full-channel movie now
              </button>
              <button
                onClick={() => void dismissAutoAlert(autoQueue[0], false)}
                className="flex items-center justify-center gap-2 rounded-lg border border-edge px-4 py-2.5 text-sm font-medium hover:bg-raised"
              >
                Postpone — I&apos;ll stitch later
              </button>
            </div>
          </div>
        </div>
      )}

      {/* rescan result popup */}
      {rescan && rescanRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-md rounded-xl border border-edge bg-surface p-5 shadow-xl">
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="text-accent" />
              <span className="text-sm font-semibold">{rescan.channel || 'Channel'}</span>
            </div>

            {rescan.newCount > 0 ? (
              <>
                <p className="mt-3 text-sm">
                  <strong>{rescan.newCount} new upload(s)</strong> since your last download
                  {rescan.backlog > 0 && (
                    <>
                      {' '}
                      — and <strong>{rescan.backlog} earlier video(s)</strong> you downloaded before are not in
                      the stitched movie yet
                    </>
                  )}
                  .
                </p>
                <p className="mt-2 text-xs text-muted">
                  {rescan.backlog > 0
                    ? 'Creating the movie now stitches EVERYTHING — old, backlog and new — into one complete film, oldest → newest.'
                    : 'You can grab the new videos and rebuild the complete movie, or just download them for now and stitch later.'}
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setRescan(null)
                      void runDownload({
                        url: rescanRecord.url,
                        quality: rescanRecord.quality,
                        combine: true,
                        channel: rescan.channel || rescanRecord.channel,
                        folder: rescanRecord.folder
                      })
                    }}
                    className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90"
                  >
                    <Film size={14} /> Download new videos + create the complete stitched movie
                  </button>
                  <button
                    onClick={() => {
                      setRescan(null)
                      void runDownload({
                        url: rescanRecord.url,
                        quality: rescanRecord.quality,
                        combine: false,
                        channel: rescan.channel || rescanRecord.channel,
                        folder: rescanRecord.folder
                      })
                    }}
                    className="flex items-center justify-center gap-2 rounded-lg border border-edge px-4 py-2.5 text-sm font-medium hover:bg-raised"
                  >
                    <Download size={14} /> Just download the new videos (stitch later)
                  </button>
                  <button
                    onClick={() => setRescan(null)}
                    className="rounded-lg px-4 py-2 text-xs text-muted hover:bg-raised"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : rescan.backlog > 0 ? (
              <>
                <p className="mt-3 text-sm">
                  No new uploads — but <strong>{rescan.backlog} downloaded video(s)</strong> are not in the
                  stitched movie yet.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Stitch now to build the complete film ({rescan.downloadedCount} videos, oldest → newest).
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setRescan(null)
                      void runStitch(rescanRecord)
                    }}
                    className="flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90"
                  >
                    <Film size={14} /> Create the complete stitched movie now
                  </button>
                  <button
                    onClick={() => setRescan(null)}
                    className="rounded-lg px-4 py-2 text-xs text-muted hover:bg-raised"
                  >
                    Not now
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="mt-3 text-sm">
                  Up to date — all {rescan.remoteCount} video(s) are downloaded
                  {rescanRecord.stitchedCount > 0 ? ' and the stitched movie is complete.' : '.'}
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => setRescan(null)}
                    className="rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60"
                  >
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

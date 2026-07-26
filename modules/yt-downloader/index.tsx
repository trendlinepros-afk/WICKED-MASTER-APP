import { useEffect } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderOpen,
  ListVideo,
  Loader2,
  Music,
  RefreshCw,
  Search,
  Video,
  X,
  Youtube
} from 'lucide-react'
import { ID, QUALITIES, isAudioPreset, useYt } from './store'

function fmtDuration(sec: number | null): string {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export default function YtDownloader(): React.JSX.Element {
  const s = useYt()

  useEffect(() => {
    void s.loadStatus()
    void s.loadPrefs()
    const offP = window.wicked.on(`${ID}:progress`, (p) => s._onProgress(p))
    const offM = window.wicked.on(`${ID}:status-msg`, (m) => s._onStatusMsg(m))
    return () => {
      offP()
      offM()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const status = s.status
  const binReady = status?.binReady ?? false
  /** the audio-only setting is actively governing the current URL */
  const musicForced = s.urlIsMusic && s.musicAudioOnly && !s.musicOverride

  /** What the download button will actually fetch, given the probe + choice. */
  const downloadTargetLabel = (): string => {
    const p = s.probe
    if (!p) return 'this URL'
    const item = p.isMusic ? 'track' : 'video'
    const takeAll = p.canChooseSingle ? s.wholePlaylist : p.kind === 'playlist'
    if (!takeAll) return `this ${item}`
    if (p.playlistKind === 'album') return `album (${p.count} tracks)`
    if (p.playlistKind === 'mix') return `radio mix (${p.count}+)`
    if (p.kind === 'playlist') return `playlist (${p.count} ${item}s)`
    return `this ${item}`
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-danger">
          <Youtube size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">YouTube Downloader</h1>
          <p className="truncate text-xs text-muted">
            {binReady ? (
              <>
                yt-dlp {status?.version ?? ''} {status?.ffmpegReady ? '· ffmpeg ready' : '· ffmpeg missing'} ·{' '}
                <button onClick={() => void s.openFolder()} className="text-accent hover:underline">
                  {status?.downloadDir}
                </button>
              </>
            ) : (
              'Video & playlist downloader'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {binReady && (
            <>
              <button
                onClick={() => void s.pickFolder()}
                className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
                title="Change download folder"
              >
                <FolderOpen size={14} /> Folder
              </button>
              <button
                onClick={() => void s.updateBin()}
                disabled={s.ensuring}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-40 ${status?.stale ? 'bg-warn/20 text-warn' : 'bg-raised hover:bg-edge/60'}`}
                title="Update yt-dlp to the latest release"
              >
                {s.ensuring ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {status?.stale ? 'Update' : 'yt-dlp'}
              </button>
            </>
          )}
        </div>
      </header>

      {/* error */}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl space-y-5">
          {/* first-run setup */}
          {status && !binReady && (
            <div className="rounded-xl border border-edge bg-surface p-5 text-center">
              <Download size={26} className="mx-auto text-accent" />
              <h2 className="mt-3 text-base font-bold">One-time setup</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
                This tool uses <strong>yt-dlp</strong> (the industry-standard downloader). Click below to
                fetch the latest copy — about 20&nbsp;MB, kept up to date from inside the app.
              </p>
              <button
                onClick={() => void s.ensureBin()}
                disabled={s.ensuring}
                className="mx-auto mt-4 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {s.ensuring ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                Install yt-dlp
              </button>
            </div>
          )}

          {/* URL input */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            <label className="text-sm font-semibold">
              YouTube / YouTube Music URL — video, track, playlist or album
            </label>
            <div className="mt-2 flex gap-2">
              <input
                value={s.url}
                onChange={(e) => s.setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void s.doProbe()
                }}
                placeholder="youtube.com/watch?v=…  ·  music.youtube.com/playlist?list=OLAK5uy_…"
                spellCheck={false}
                disabled={s.downloading}
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-60"
              />
              <button
                onClick={() => void s.doProbe()}
                disabled={s.probing || s.downloading || !s.url.trim() || !binReady}
                className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
              >
                {s.probing ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                Check
              </button>
            </div>

            {/* probe result */}
            {s.probe && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-3 rounded-lg border border-edge bg-raised/40 p-3">
                  {/* External thumbnails are blocked by the shell CSP (img-src),
                      so use a type icon rather than loosening it for one module. */}
                  <span className={`flex h-14 w-24 shrink-0 items-center justify-center rounded bg-raised ${s.probe.isMusic ? 'text-danger' : s.probe.kind === 'playlist' ? 'text-accent' : 'text-ok'}`}>
                    {s.probe.isMusic ? <Music size={22} /> : s.probe.kind === 'playlist' ? <ListVideo size={22} /> : <Video size={22} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {s.probe.isMusic && (
                        <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-danger">
                          YT Music
                        </span>
                      )}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${s.probe.kind === 'playlist' ? 'bg-accent/15 text-accent' : 'bg-ok/15 text-ok'}`}>
                        {s.probe.playlistKind === 'album'
                          ? `Album · ${s.probe.count} tracks`
                          : s.probe.playlistKind === 'mix'
                            ? `Radio mix · ${s.probe.count}+`
                            : s.probe.kind === 'playlist'
                              ? `Playlist · ${s.probe.count} ${s.probe.isMusic ? 'tracks' : 'videos'}`
                              : s.probe.isMusic
                                ? 'Track'
                                : 'Video'}
                      </span>
                      {s.probe.duration ? <span className="text-xs text-muted">{fmtDuration(s.probe.duration)}</span> : null}
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">{s.probe.title}</div>
                    {s.probe.uploader && <div className="truncate text-xs text-muted">{s.probe.uploader}</div>}
                  </div>
                </div>

                {/* track vs whole playlist — YT Music song links carry an
                    auto-radio/album list, so make the choice explicit */}
                {s.probe.canChooseSingle && (
                  <div className="rounded-lg border border-edge bg-raised/40 p-3">
                    <div className="text-xs font-semibold">
                      This link contains a {s.probe.isMusic ? 'track' : 'video'} <em>and</em> a{' '}
                      {s.probe.playlistKind === 'album' ? 'album' : s.probe.playlistKind === 'mix' ? 'radio mix' : 'playlist'}. What do you want?
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        onClick={() => s.setWholePlaylist(false)}
                        disabled={s.downloading}
                        className={`rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-50 ${!s.wholePlaylist ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'}`}
                      >
                        <div className="font-semibold">Just this {s.probe.isMusic ? 'track' : 'video'}</div>
                        <div className="truncate opacity-80">{s.probe.singleTitle ?? 'single item'}</div>
                      </button>
                      <button
                        onClick={() => s.setWholePlaylist(true)}
                        disabled={s.downloading}
                        className={`rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-50 ${s.wholePlaylist ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'}`}
                      >
                        <div className="font-semibold">
                          {s.probe.playlistKind === 'album' ? 'Whole album' : s.probe.playlistKind === 'mix' ? 'Whole radio mix' : 'Whole playlist'} ({s.probe.count})
                        </div>
                        <div className="truncate opacity-80">{s.probe.title}</div>
                      </button>
                    </div>
                    {s.probe.playlistKind === 'mix' && s.wholePlaylist && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        Radio mixes are auto-generated and effectively endless — YouTube only exposes a
                        chunk at a time, so this may pull far more than you expect.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* music setting */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={s.musicAudioOnly}
                onChange={(e) => void s.setMusicAudioOnly(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[rgb(var(--wk-accent))]"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Music size={14} className="text-danger" />
                  Audio only for YouTube Music links
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  When the URL is a <code>music.youtube.com</code> link, always download audio instead
                  of video. Applies the moment you paste the link.
                </span>
              </span>
            </label>
            {s.musicAudioOnly && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
                <span className="text-xs text-muted">Music format:</span>
                {QUALITIES.filter((q) => isAudioPreset(q.id)).map((q) => (
                  <button
                    key={q.id}
                    onClick={() => void s.setMusicFormat(q.id)}
                    disabled={s.downloading}
                    title={q.note}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                      s.musicFormat === q.id ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'
                    }`}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* quality */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Quality</div>
              {musicForced && (
                <span className="flex items-center gap-1.5 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                  <Music size={11} /> Music link — audio only (setting)
                </span>
              )}
              {s.musicOverride && (
                <button
                  onClick={s.clearMusicOverride}
                  className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn hover:bg-warn/25"
                  title="Go back to the audio-only setting for this music link"
                >
                  Video override active — back to audio
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {QUALITIES.map((q) => {
                const dimmed = musicForced && !isAudioPreset(q.id)
                return (
                  <button
                    key={q.id}
                    onClick={() => s.setQuality(q.id)}
                    disabled={s.downloading}
                    title={dimmed ? `${q.note} — click to override audio-only for this link` : q.note}
                    className={`rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-50 ${
                      s.quality === q.id
                        ? 'border-accent bg-accent/10 text-ink'
                        : dimmed
                          ? 'border-edge/60 bg-raised/40 text-muted/50 hover:text-muted'
                          : 'border-edge bg-raised text-muted hover:text-ink'
                    }`}
                  >
                    <div className="font-semibold">{q.label}</div>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              {QUALITIES.find((q) => q.id === s.quality)?.note}
              {musicForced && ' · Video tiers are dimmed because this is a Music link — click one anyway to override.'}
            </p>
          </div>

          {/* download button / progress */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            {!s.downloading ? (
              <button
                onClick={() => void s.download()}
                disabled={!binReady || !s.url.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <Download size={16} />
                Download {downloadTargetLabel()} in {QUALITIES.find((q) => q.id === s.quality)?.label}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Loader2 size={15} className="animate-spin text-accent" />
                    {s.progress && s.progress.total > 1 ? `Video ${s.progress.index} of ${s.progress.total}` : 'Downloading…'}
                  </span>
                  <button onClick={() => void s.cancel()} className="rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60">
                    Cancel
                  </button>
                </div>
                {s.progress && (
                  <>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
                      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.min(100, s.progress.percent)}%` }} />
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span className="min-w-0 truncate">{s.progress.title || '…'}</span>
                      <span className="shrink-0 tabular-nums">
                        {s.progress.percent.toFixed(1)}% {s.progress.speed && `· ${s.progress.speed}`} {s.progress.eta && `· ETA ${s.progress.eta}`}
                      </span>
                    </div>
                  </>
                )}
                <p className="text-xs text-muted">
                  Long playlists can take a while — this won&apos;t time out. You can keep using WICKED; the
                  download continues in the background.
                </p>
              </div>
            )}

            {s.lastResult === 'done' && (
              <div className="mt-3 flex items-center gap-2 text-sm text-ok">
                <CheckCircle2 size={15} /> Download complete.
                <button onClick={() => void s.openFolder()} className="text-accent hover:underline">
                  Open folder
                </button>
              </div>
            )}
          </div>

          {/* activity log */}
          {s.log.length > 0 && (
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="text-xs font-semibold text-muted">Activity</div>
              <div className="mt-2 max-h-40 space-y-0.5 overflow-y-auto font-mono text-[11px] text-muted">
                {s.log.slice(-30).map((l, i) => (
                  <div key={i} className="truncate">
                    {l}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* status bar */}
      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {(s.downloading || s.ensuring || s.probing) && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <span className="truncate">{s.statusMsg}</span>
      </footer>
    </div>
  )
}

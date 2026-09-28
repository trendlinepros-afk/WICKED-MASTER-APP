import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Clapperboard, ExternalLink, FolderOpen, LoaderCircle, Music, Pause, Play, Sparkles, Volume2, X } from 'lucide-react'
import { inv, useRec } from '../store'
import type { MusicInfo, RenderPrefs } from '../types'
import { fmtBytes, fmtDuration } from '../lib/geometry'
import { outputName } from '../lib/render-plan'
import { btn, btnAccent, card, ClipThumb, DbSlider, input, Section, Segmented, Toggle } from './ui'

const MUSIC_PRESETS = [
  { db: -28, label: 'Barely there' },
  { db: -22, label: 'Background' },
  { db: -16, label: 'Noticeable' },
  { db: -10, label: 'Loud' }
]

/** rough output size: bits per pixel per frame of x264 veryfast on screen content */
function estimateBytes(totalMs: number, fps: number, quality: RenderPrefs['quality']): number {
  const mbps = { standard: 4, high: 7, max: 12 }[quality] * (fps === 60 ? 1.5 : 1)
  return (totalMs / 1000) * ((mbps * 1_000_000 + 192_000) / 8)
}

function MusicPicker({ prefs, set }: { prefs: RenderPrefs; set: (p: Partial<RenderPrefs>) => void }): React.JSX.Element {
  const s = useRec()
  const [info, setInfo] = useState<MusicInfo | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    void (inv('music-info') as Promise<MusicInfo>).then(setInfo)
  }, [prefs.musicPath])
  useEffect(() => {
    if (audio.current) audio.current.volume = Math.min(1, Math.pow(10, prefs.musicDb / 20))
  }, [prefs.musicDb])
  useEffect(
    () => () => {
      audio.current?.pause()
    },
    []
  )
  const stop = (): void => {
    audio.current?.pause()
    setPlaying(false)
  }
  const preview = async (): Promise<void> => {
    if (playing) return stop()
    setLoading(true)
    const r = (await inv('music-data')) as { ok: boolean; dataUrl?: string; error?: string }
    setLoading(false)
    if (!r.ok || !r.dataUrl) return s.showToast('err', r.error ?? 'Could not load the track')
    audio.current?.pause()
    const a = new Audio(r.dataUrl)
    a.volume = Math.min(1, Math.pow(10, prefs.musicDb / 20))
    a.onended = () => setPlaying(false)
    audio.current = a
    await a.play().catch(() => setPlaying(false))
    setPlaying(true)
  }
  const choose = async (): Promise<void> => {
    stop()
    const r = (await inv('pick-music')) as { ok: boolean; info?: MusicInfo }
    if (r.ok && r.info) setInfo(r.info)
  }
  if (!prefs.musicPath)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-edge p-4">
        <Music size={18} className="text-muted" />
        <div className="min-w-0 flex-1 text-sm text-muted">No music — the video uses only your recorded audio.</div>
        <button className={btnAccent} onClick={() => void choose()}>
          <Music size={14} /> Choose a track…
        </button>
      </div>
    )
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-bg p-3">
        <button className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${info?.exists ? 'bg-accent text-accent-ink' : 'bg-raised text-muted'}`} disabled={!info?.exists || loading} onClick={() => void preview()} title="Preview at this level">
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : playing ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink" title={prefs.musicPath}>
            {info?.name ?? prefs.musicPath.split(/[\\/]/).pop()}
          </div>
          <div className="text-xs text-muted">{info?.exists === false ? <span className="text-danger">Not found on this PC</span> : info?.durationSec ? fmtDuration(info.durationSec * 1000) : '…'}</div>
        </div>
        <button className={btn} onClick={() => void choose()}>
          Change…
        </button>
        <button
          className={btn}
          onClick={() => {
            stop()
            set({ musicPath: '' })
          }}
          title="No music"
        >
          <X size={14} />
        </button>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm text-ink">Music level</span>
          <span className="text-xs text-muted">kept as your preset for every render</span>
        </div>
        <DbSlider value={prefs.musicDb} min={-40} max={0} onChange={(v) => set({ musicDb: v })} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {MUSIC_PRESETS.map((p) => (
            <button key={p.db} onClick={() => set({ musicDb: p.db })} className={`rounded-md border px-2 py-1 text-xs ${prefs.musicDb === p.db ? 'border-accent bg-accent/15 text-accent' : 'border-edge text-muted hover:text-ink'}`}>
              {p.label} · {p.db} dB
            </button>
          ))}
        </div>
      </div>
      <div className="divide-y divide-edge">
        <Toggle checked={prefs.musicLoop} onChange={(v) => set({ musicLoop: v })} label="Loop the track to fill the whole video" />
        <Toggle checked={prefs.musicFade} onChange={(v) => set({ musicFade: v })} label="Fade the music in and out" />
        <Toggle checked={prefs.musicDuck} onChange={(v) => set({ musicDuck: v })} label="Lower the music while I talk" hint="Automatic ducking under your voice, back up in the pauses." />
      </div>
    </div>
  )
}

export default function RenderView(): React.JSX.Element {
  const s = useRec()
  const [prefs, setPrefs] = useState<RenderPrefs>(s.settings.render)
  const [fileName, setFileName] = useState('')
  const [starting, setStarting] = useState(false)
  // local edits win while a save is pending (slider drags), then the store is the truth
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(prefs)
  useEffect(() => {
    if (!pending.current) setPrefs(s.settings.render)
  }, [s.settings.render])
  useEffect(
    () => () => {
      if (pending.current) {
        clearTimeout(pending.current)
        void s.saveSettings({ render: latest.current })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const set = (p: Partial<RenderPrefs>): void => {
    const next = { ...latest.current, ...p }
    latest.current = next
    setPrefs(next)
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void s.saveSettings({ render: latest.current })
    }, 350)
  }
  const sess = s.session
  const clips = (sess?.clips ?? []).filter((c) => c.include)
  const totalMs = sess?.includedMs ?? 0
  const job = s.job
  const running = !!job && (job.phase === 'preparing' || job.phase === 'clips' || job.phase === 'mixing')
  const notReady = clips.some((c) => c.status !== 'ready')
  const recording = s.rec?.phase === 'recording' || s.rec?.phase === 'stopping'
  const placeholder = outputName('').replace(/\.mp4$/, '')

  const start = async (): Promise<void> => {
    setStarting(true)
    if (pending.current) {
      clearTimeout(pending.current)
      pending.current = null
    }
    const r = (await inv('render', { prefs: latest.current, fileName })) as { ok: boolean; error?: string }
    setStarting(false)
    if (!r.ok) s.showToast('err', r.error ?? 'Could not start the render')
    else setFileName('')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <h1 className="text-xl font-bold text-ink">Complete session</h1>
        <p className="mb-5 text-sm text-muted">Joins every included clip, in order, into one 1920×1080 MP4 with your audio and an optional music track.</p>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_360px]">
          <div className="space-y-4">
            <Section icon={<Music size={16} />} title="Music" sub="Pick an MP3 (or WAV, M4A, FLAC…) from this PC. It’s mixed under your recording at the level below.">
              <MusicPicker prefs={prefs} set={set} />
            </Section>
            <Section icon={<Volume2 size={16} />} title="Your recorded audio" sub="Microphone (and computer sound, if you record it) — raise or lower it against the music.">
              <DbSlider value={prefs.voiceDb} min={-12} max={12} onChange={(v) => set({ voiceDb: v })} />
            </Section>
            <Section icon={<Clapperboard size={16} />} title="Video" sub="Always 1920×1080 H.264 MP4 — the format YouTube and editors expect.">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink">Frame rate</span>
                  <Segmented value={prefs.fps} options={[{ id: 30, label: '30 fps' }, { id: 60, label: '60 fps' }]} onChange={(v) => set({ fps: v })} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink">When a clip isn’t 16:9</span>
                  <Segmented
                    value={prefs.fit}
                    options={[
                      { id: 'fit', label: 'Show everything', hint: 'Thin black bars where the shape differs' },
                      { id: 'fill', label: 'Fill the frame', hint: 'Crops a little off the edges instead' }
                    ]}
                    onChange={(v) => set({ fit: v })}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink">Quality</span>
                  <Segmented
                    value={prefs.quality}
                    options={[
                      { id: 'standard', label: 'Standard' },
                      { id: 'high', label: 'High' },
                      { id: 'max', label: 'Maximum' }
                    ]}
                    onChange={(v) => set({ quality: v })}
                  />
                </div>
              </div>
            </Section>
            <Section icon={<FolderOpen size={16} />} title="Save as">
              <div className="flex flex-wrap items-center gap-2">
                <input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder={placeholder} className={`${input} min-w-[220px] flex-1`} />
                <span className="text-sm text-muted">.mp4</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="truncate">in {s.paths.outputDir}</span>
                <button className="text-accent hover:underline" onClick={() => void inv('choose-dir', 'output')}>
                  Change
                </button>
              </div>
              <div className="mt-2 border-t border-edge pt-1">
                <Toggle checked={prefs.deleteRawAfter} onChange={(v) => set({ deleteRawAfter: v })} label="Delete the raw clips after a successful render" hint="Off keeps them in the Raw clips folder in case you want to re-render." />
              </div>
            </Section>
          </div>

          <div className="space-y-4 lg:sticky lg:top-0 lg:self-start">
            <div className={`${card} p-5`}>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">This session</div>
              <div className="mt-1 text-3xl font-bold tabular-nums text-ink">{fmtDuration(totalMs)}</div>
              <div className="text-sm text-muted">
                {clips.length} clip{clips.length === 1 ? '' : 's'} · ≈ {fmtBytes(estimateBytes(totalMs, prefs.fps, prefs.quality))}
              </div>
              {clips.length > 0 && (
                <div className="mt-3 grid grid-cols-4 gap-1">
                  {clips.slice(0, 8).map((c) => (
                    <ClipThumb key={c.id} id={c.id} thumb={c.thumb} className="rounded" />
                  ))}
                </div>
              )}
              <div className="mt-3 space-y-1 text-xs text-muted">
                <div>
                  <b className="text-ink">1920×1080</b> · {prefs.fps} fps · {prefs.fit === 'fit' ? 'nothing cropped' : 'fills the frame'}
                </div>
                <div>{prefs.musicPath ? `Music at ${prefs.musicDb} dB${prefs.musicDuck ? ', ducked under voice' : ''}${prefs.musicLoop ? ', looped' : ''}` : 'No music'}</div>
              </div>

              {job && !running && job.phase === 'done' ? (
                <div className="mt-4 rounded-lg border border-ok/40 bg-ok/10 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <Sparkles size={15} className="text-ok" /> {job.message}
                  </div>
                  <div className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">{job.output}</div>
                  <div className="mt-2 flex gap-2">
                    <button className={btnAccent} onClick={() => void inv('job-open', false)}>
                      <ExternalLink size={14} /> Play
                    </button>
                    <button className={btn} onClick={() => void inv('job-open', true)}>
                      <FolderOpen size={14} /> Show in folder
                    </button>
                  </div>
                  <div className="mt-2 text-xs text-muted">The session is complete — your next recording starts a new one.</div>
                </div>
              ) : running && job ? (
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="text-ink">{job.message}</span>
                    <span className="tabular-nums text-muted">{Math.round(job.progress * 100)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted">
                    <span>{job.etaSec != null ? `about ${fmtDuration(job.etaSec * 1000)} left` : 'estimating…'}</span>
                    <button className="text-danger hover:underline" onClick={() => void inv('render-cancel')}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {job && (job.phase === 'failed' || job.phase === 'cancelled') && (
                    <div className={`mt-4 flex items-start gap-2 rounded-lg border p-3 text-xs ${job.phase === 'failed' ? 'border-danger/40 bg-danger/10' : 'border-edge bg-raised'}`}>
                      <CircleAlert size={14} className={`mt-0.5 shrink-0 ${job.phase === 'failed' ? 'text-danger' : 'text-muted'}`} />
                      <div className="min-w-0 text-ink">
                        <div className="font-medium">{job.message}</div>
                        {job.error && <div className="mt-0.5 break-words text-muted">{job.error}</div>}
                      </div>
                    </div>
                  )}
                  <button className={`${btnAccent} mt-4 w-full py-2.5 text-base`} disabled={!clips.length || notReady || recording || starting} onClick={() => void start()}>
                    {starting ? <LoaderCircle size={16} className="animate-spin" /> : <Clapperboard size={16} />} Render video
                  </button>
                  <div className="mt-2 text-center text-xs text-muted">
                    {!clips.length ? 'Record a clip first.' : recording ? 'Stop the recording first.' : notReady ? 'Waiting for the last clip to finish preparing…' : 'The session closes once the video is saved.'}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

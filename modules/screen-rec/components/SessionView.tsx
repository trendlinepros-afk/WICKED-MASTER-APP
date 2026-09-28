import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Clapperboard, ExternalLink, FolderOpen, LoaderCircle, MicOff, Mic, MonitorPlay, RotateCcw, Settings, Square, Trash2, Volume2 } from 'lucide-react'
import { inv, useRec } from '../store'
import type { ClipView } from '../types'
import { fmtBytes, fmtDuration } from '../lib/geometry'
import { btn, btnAccent, btnDanger, btnIcon, card, ClipThumb, fmtWhen, Keys } from './ui'

function useTicker(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [on])
  return now
}

function StatusHero(): React.JSX.Element {
  const s = useRec()
  const rec = s.rec
  const phase = rec?.phase ?? 'idle'
  const now = useTicker(phase === 'recording')
  const scr = s.screens
  const def = scr?.screens.find((x) => x.id === s.machine.defaultScreenId)
  const area = def ? scr?.areas[def.id] : undefined
  const m = s.machine.mic
  const mic = !m ? 'No microphone' : m.deviceId === 'default' ? (m.label ? `Default mic (${m.label})` : 'Windows default mic') : m.label || 'Microphone'
  const recClip = s.session?.clips.find((c) => c.id === rec?.clipId)

  if (phase === 'recording' || phase === 'stopping') {
    return (
      <div className="flex flex-wrap items-center gap-5 rounded-xl border border-danger/50 bg-danger/10 p-5">
        <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-danger/15">
          <span className="h-4 w-4 animate-pulse rounded-full bg-danger" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-ink">
            Recording{recClip ? ` clip ${recClip.n}` : ''} · <span className="tabular-nums">{fmtDuration(rec?.startedAt ? now - rec.startedAt : 0)}</span>
          </div>
          <div className="text-sm text-muted">
            {rec?.screen ? `Screen ${rec.screen.number} · ${rec.screen.label}` : ''} — press <Keys accel={s.hotkey.accelerator} /> in any app to stop.
          </div>
          {rec?.warnings[0] && <div className="mt-1 text-xs text-warn">{rec.warnings[0]}</div>}
        </div>
        <button className={btnDanger} disabled={phase === 'stopping'} onClick={() => void inv('record-stop')}>
          {phase === 'stopping' ? <LoaderCircle size={15} className="animate-spin" /> : <Square size={14} fill="currentColor" />} Stop
        </button>
      </div>
    )
  }
  if (phase !== 'idle') {
    const text =
      phase === 'picking' ? 'Pick a screen — click it, or press its number' : phase === 'armed' ? 'Press R to start recording' : phase === 'countdown' ? 'Get ready…' : 'Starting…'
    return (
      <div className="flex flex-wrap items-center gap-5 rounded-xl border border-accent/50 bg-accent/10 p-5">
        <LoaderCircle size={28} className="animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-ink">{text}</div>
          <div className="text-sm text-muted">Esc cancels.</div>
        </div>
        <button className={btn} onClick={() => void inv('record-stop')}>
          Cancel
        </button>
      </div>
    )
  }
  return (
    <div className={`${card} p-5`}>
      <div className="flex flex-wrap items-center gap-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent">
          <MonitorPlay size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-bold text-ink">Ready to record</div>
          <div className="text-sm text-muted">
            Press <Keys accel={s.hotkey.accelerator} /> in any app{' '}
            {def ? (
              <>
                — recording starts right away on <b className="text-ink">Screen {def.number}</b>.
              </>
            ) : (
              <>
                — pick a screen, then press <Keys accel="R" /> to start.
              </>
            )}{' '}
            Press <Keys accel={s.hotkey.accelerator} /> again to stop.
          </div>
        </div>
        <button className={btnAccent} onClick={() => void inv('record-toggle')}>
          <span className="h-2.5 w-2.5 rounded-full bg-current" /> Record now
        </button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-edge pt-3 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-muted">
          <MonitorPlay size={12} /> {def ? `Screen ${def.number} · ${area?.text ?? ''}` : 'Ask which screen each time'}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-muted">
          {s.machine.mic ? <Mic size={12} /> : <MicOff size={12} />} {mic}
          {s.settings.systemAudio && ' + computer sound'}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-muted">
          <Clapperboard size={12} /> Final video 1920×1080 MP4
        </span>
        <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-accent hover:bg-accent/10" onClick={() => s.setTab('settings')}>
          <Settings size={12} /> Change
        </button>
      </div>
    </div>
  )
}

function ClipCard({ c, index, count }: { c: ClipView; index: number; count: number }): React.JSX.Element {
  const s = useRec()
  const [confirm, setConfirm] = useState(false)
  const busy = c.status === 'recording' || c.status === 'processing'
  const act = async (action: string, arg: unknown): Promise<void> => {
    const r = (await inv(action, arg)) as { ok: boolean; error?: string }
    if (!r.ok && r.error) s.showToast('err', r.error)
  }
  return (
    <div className={`${card} overflow-hidden ${c.include ? '' : 'opacity-55'}`}>
      <div className="relative">
        <ClipThumb id={c.id} thumb={c.thumb} />
        <span className="absolute left-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">{index + 1}</span>
        {c.durationMs > 0 && <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{fmtDuration(c.durationMs)}</span>}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/55 text-xs text-white">
            <LoaderCircle size={14} className="animate-spin" /> {c.status === 'recording' ? 'Recording…' : 'Preparing…'}
          </div>
        )}
        {c.status === 'failed' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65 p-3 text-center text-xs text-white">
            <CircleAlert size={16} className="text-danger" />
            {c.error || 'This clip could not be read'}
            <button className="rounded-md bg-white/15 px-2 py-0.5 hover:bg-white/25" onClick={() => void act('clip-retry', c.id)}>
              <RotateCcw size={11} className="mr-1 inline" />
              Try again
            </button>
          </div>
        )}
        {!c.exists && c.status === 'ready' && <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white">File moved or deleted</div>}
      </div>
      <div className="p-2.5">
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-medium text-ink" title={c.include ? 'Included in the video — click to leave it out' : 'Left out of the video — click to include'}>
            <input type="checkbox" checked={c.include} onChange={(e) => void act('clip-include', { id: c.id, include: e.target.checked })} className="accent-accent" />
            <span className="truncate">Clip {c.n}</span>
          </label>
          <span className="shrink-0 text-[11px] text-muted">{fmtWhen(c.createdAt)}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-muted" title={`${c.audioLabel} · ${c.width}×${c.height}`}>
          {c.hasAudio ? <Volume2 size={11} className="shrink-0" /> : <MicOff size={11} className="shrink-0 text-warn" />}
          <span className="truncate">
            Screen {c.screen.number} · {c.hasAudio ? c.audioLabel.replace(/^Mic: /, '') : 'no audio'}
            {c.bytes > 0 ? ` · ${fmtBytes(c.bytes)}` : ''}
          </span>
        </div>
        {c.warnings[0] && (
          <div className="mt-1 truncate text-[11px] text-warn" title={c.warnings.join('\n')}>
            {c.warnings[0]}
          </div>
        )}
        <div className="mt-2 flex items-center gap-0.5">
          <button className={btnIcon} disabled={index === 0} onClick={() => void act('clip-move', { id: c.id, delta: -1 })} title="Move earlier">
            <ArrowLeft size={14} />
          </button>
          <button className={btnIcon} disabled={index === count - 1} onClick={() => void act('clip-move', { id: c.id, delta: 1 })} title="Move later">
            <ArrowRight size={14} />
          </button>
          <button className={btnIcon} disabled={!c.exists || busy} onClick={() => void act('clip-open', { id: c.id })} title="Play">
            <ExternalLink size={14} />
          </button>
          <button className={btnIcon} disabled={!c.exists} onClick={() => void act('clip-open', { id: c.id, reveal: true })} title="Show in folder">
            <FolderOpen size={14} />
          </button>
          <span className="flex-1" />
          {confirm ? (
            <span className="flex items-center gap-1 text-[11px]">
              <button className="rounded-md bg-danger px-2 py-1 font-medium text-white" onClick={() => void act('clip-remove', c.id)}>
                Delete
              </button>
              <button className="rounded-md px-1.5 py-1 text-muted hover:text-ink" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button className={`${btnIcon} hover:text-danger`} disabled={c.status === 'recording'} onClick={() => setConfirm(true)} title="Delete this clip">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function SessionView(): React.JSX.Element {
  const s = useRec()
  const [discard, setDiscard] = useState(false)
  const sess = s.session
  const clips = sess?.clips ?? []
  const included = clips.filter((c) => c.include)
  const job = s.job
  const rendering = !!job && (job.phase === 'preparing' || job.phase === 'clips' || job.phase === 'mixing')
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-6">
          <div>
            <h1 className="text-xl font-bold text-ink">Session</h1>
            <p className="text-sm text-muted">Every recording lands here as a clip. When you’re done, complete the session to get one 1920×1080 video.</p>
          </div>
          {s.hotkey.enabled && !s.hotkey.registered && s.hotkey.error && (
            <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-ink">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
              <span className="flex-1">{s.hotkey.error}. Use the Record button meanwhile, or choose another hotkey in Settings.</span>
              <button className={btn} onClick={() => s.setTab('settings')}>
                Settings
              </button>
            </div>
          )}
          {s.rec?.lastError && s.rec.phase === 'idle' && (
            <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-ink">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
              <span className="flex-1">{s.rec.lastError}</span>
            </div>
          )}
          <StatusHero />
          {clips.length === 0 ? (
            <div className={`${card} flex flex-col items-center gap-2 border-dashed p-12 text-center`}>
              <Clapperboard size={26} className="text-accent" />
              <div className="text-sm font-medium text-ink">No clips yet</div>
              <div className="max-w-md text-sm text-muted">
                Press <Keys accel={s.hotkey.accelerator} /> whenever you want to capture something. Record as many clips as you like — they’re joined in order when you complete the session.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {clips.map((c, i) => (
                <ClipCard key={c.id} c={c} index={i} count={clips.length} />
              ))}
            </div>
          )}
        </div>
      </div>
      {clips.length > 0 && (
        <div className="border-t border-edge bg-surface px-6 py-3">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
            <div className="flex-1 text-sm text-ink">
              <b>{included.length}</b> of {clips.length} clip{clips.length === 1 ? '' : 's'} · <b className="tabular-nums">{fmtDuration(sess?.includedMs ?? 0)}</b>
              <span className="text-muted"> → one 1920×1080 MP4</span>
            </div>
            {discard ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-muted">Delete all {clips.length} clips?</span>
                <button
                  className={btnDanger}
                  onClick={async () => {
                    const r = (await inv('session-discard', { deleteFiles: true })) as { ok: boolean; error?: string }
                    setDiscard(false)
                    if (!r.ok) s.showToast('err', r.error ?? 'Could not discard')
                  }}
                >
                  Delete
                </button>
                <button className={btn} onClick={() => setDiscard(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button className={btn} disabled={rendering || s.rec?.phase !== 'idle'} onClick={() => setDiscard(true)}>
                <Trash2 size={14} /> Discard session
              </button>
            )}
            <button className={btn} onClick={() => void inv('open-folder', 'session')}>
              <FolderOpen size={14} /> Raw clips
            </button>
            <button className={`${btnAccent} px-4 py-2`} disabled={!included.length} onClick={() => s.setTab('render')}>
              {rendering ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />} Complete session & render
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

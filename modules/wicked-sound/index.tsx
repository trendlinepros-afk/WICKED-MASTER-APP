import React, { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AudioLines,
  Download,
  Link2,
  Link2Off,
  Loader2,
  Power,
  RefreshCw,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { ModuleTitle } from '@/shell/moduleContext'
import {
  BANDS,
  FX_META,
  KNOWN_DEVICES,
  clampFxLevel,
  clampGain,
  clampPreamp,
  emptyFx,
  type AiTuneResult,
  type EqFx,
  type EqProfile,
  type SoundStatus
} from './types'

/**
 * WICKED SOUND — renderer.
 *
 * FxSound-style system EQ: a power button, mix profiles, a device selector
 * (System Default + every output), device→mix Links, an Auto mode that follows
 * the Windows default output, Gemini-powered tuning, and a live wave rendered
 * from a system-audio loopback capture. All actual filtering happens in
 * Equalizer APO (managed by main — see ipc.ts); this UI is the mixing desk.
 */
const ID = 'wicked-sound'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

interface OutputDevice {
  deviceId: string
  label: string
  /** Equalizer APO match token derived from the label (e.g. "EDIFIER M60") */
  match: string
}

/** "Default - Speakers (2- EDIFIER M60)" → "EDIFIER M60" (the APO match token). */
function matchToken(label: string): string {
  let s = label.replace(/^(Default|Communications) - /i, '').trim()
  // drop a trailing USB vid:pid parenthetical like "(0b05:1a52)" — it's a
  // hardware id, not part of the device NAME Equalizer APO matches against
  s = s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
  const paren = s.match(/\(([^()]+)\)\s*$/)
  if (paren) s = paren[1]
  s = s.replace(/^\d+-\s*/, '').trim()
  return s.slice(0, 120)
}

export default function WickedSound(): React.JSX.Element {
  const [status, setStatus] = useState<SoundStatus | null>(null)
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [defaultLabel, setDefaultLabel] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiGoal, setAiGoal] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSummary, setAiSummary] = useState('')
  const [waveOn, setWaveOn] = useState(false)

  // sliders edit a local draft and commit debounced, so dragging doesn't spam
  // config writes (each write hot-reloads the engine)
  interface Draft {
    id: string
    preampDb: number
    gains: number[]
    fx: EqFx
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const statusRef = useRef<SoundStatus | null>(null)
  statusRef.current = status
  const autoBusyRef = useRef(false)
  const draftRef = useRef<Draft | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const waveStream = useRef<MediaStream | null>(null)
  const waveCtx = useRef<AudioContext | null>(null)
  const waveRaf = useRef(0)

  const settings = status?.settings
  const active = settings?.profiles.find((p) => p.id === settings.activeProfileId) ?? null
  const shown: { preampDb: number; gains: number[]; fx: EqFx } = draft ?? {
    preampDb: active?.preampDb ?? 0,
    gains: active?.gains ?? new Array(10).fill(0),
    fx: { ...emptyFx(), ...(active?.fx ?? {}) }
  }

  const applyStatus = (res: unknown): void => {
    const r = res as { ok?: boolean; error?: string; status?: SoundStatus }
    if (r.status) setStatus(r.status)
    if (!r.ok && r.error) setError(r.error)
    else setError('')
  }

  const refresh = async (): Promise<void> => {
    const res = (await invoke('status')) as SoundStatus
    if (res.ok) setStatus(res)
  }

  const listOutputs = async (): Promise<void> => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const outs: OutputDevice[] = []
      let def = ''
      for (const d of all) {
        if (d.kind !== 'audiooutput') continue
        if (d.deviceId === 'default') {
          def = matchToken(d.label)
          continue
        }
        if (d.deviceId === 'communications') continue
        if (!d.label) continue
        outs.push({ deviceId: d.deviceId, label: d.label, match: matchToken(d.label) })
      }
      setDevices(outs)
      setDefaultLabel(def)
    } catch {
      /* enumeration unavailable — selector just shows System Default */
    }
  }

  /* ------------------------- Auto mode (follow default) ------------------- */

  const autoFollow = async (): Promise<void> => {
    const st = statusRef.current
    if (!st?.settings.auto || autoBusyRef.current) return
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    const def = all.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
    const label = def ? def.label.replace(/^Default - /i, '') : ''
    if (!label) return
    const token = matchToken(label)
    const link = st.settings.links.find((l) => label.toUpperCase().includes(l.match.toUpperCase()))
    if (link) {
      if (st.settings.activeProfileId !== link.profileId || st.settings.target !== link.match) {
        setMessage(`Auto: switched to the "${st.settings.profiles.find((p) => p.id === link.profileId)?.name ?? link.profileId}" mix for ${link.deviceLabel}.`)
        applyStatus(await invoke('set', { activeProfileId: link.profileId, target: link.match, targetLabel: link.deviceLabel }))
      }
      return
    }
    // Unlinked device → calibrate a starter mix for it once (Gemini), link it.
    if (!st.hasGeminiKey) return
    autoBusyRef.current = true
    try {
      setMessage(`Auto: calibrating a mix for ${token}…`)
      const tune = (await invoke('ai-tune', {
        deviceLabel: label,
        goal: 'Auto-calibrate a balanced everyday mix for this output device.'
      })) as AiTuneResult
      if (!tune.ok || !tune.gains) {
        setMessage('')
        return
      }
      const id = `auto-${token.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`
      await invoke('profile-upsert', {
        id,
        name: `${token} (Auto)`,
        preampDb: tune.preampDb ?? 0,
        gains: tune.gains,
        note: tune.summary ?? 'Auto-calibrated by Gemini'
      })
      await invoke('link-set', { match: token, deviceLabel: label, profileId: id })
      applyStatus(await invoke('set', { activeProfileId: id, target: token, targetLabel: label }))
      setMessage(`Auto: calibrated and linked a mix for ${token}.`)
    } finally {
      autoBusyRef.current = false
    }
  }

  useEffect(() => {
    void refresh().then(() => void autoFollow())
    void listOutputs()
    const onChange = (): void => {
      void listOutputs()
      void autoFollow()
    }
    navigator.mediaDevices.addEventListener?.('devicechange', onChange)
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', onChange)
      stopWave()
      if (commitTimer.current) clearTimeout(commitTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ------------------------------ EQ editing ------------------------------ */

  /** Slider edits: builtins are cloned into a custom mix on the first change. */
  const editCurve = (patch: Partial<{ preampDb: number; gains: number[]; fx: EqFx }>): void => {
    if (!settings || !active) return
    const cur =
      draft ?? { id: active.id, preampDb: active.preampDb, gains: [...active.gains], fx: { ...emptyFx(), ...(active.fx ?? {}) } }
    const next: Draft = {
      id: cur.id,
      preampDb: patch.preampDb ?? cur.preampDb,
      gains: patch.gains ?? cur.gains,
      fx: patch.fx ?? cur.fx
    }
    setDraft(next)
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => void commitDraft(next), 500)
  }

  const commitDraft = async (d: Draft): Promise<void> => {
    const st = statusRef.current
    if (!st) return
    const base = st.settings.profiles.find((p) => p.id === d.id)
    let id = d.id
    let name = base?.name ?? 'Custom mix'
    if (base?.builtin) {
      id = `custom-${Date.now().toString(36)}`
      name = `${base.name} (custom)`
    }
    const res = (await invoke('profile-upsert', {
      id,
      name,
      preampDb: d.preampDb,
      gains: d.gains,
      fx: d.fx,
      note: base?.note
    })) as { ok?: boolean; error?: string; status?: SoundStatus }
    if (!res.ok) {
      setError(res.error ?? 'Could not save the mix.')
      return
    }
    if (id !== d.id) {
      // cloned a builtin → make the clone active and keep editing it
      setDraft({ ...d, id })
      applyStatus(await invoke('set', { activeProfileId: id }))
    } else if (res.status) setStatus(res.status)
  }

  const pickProfile = async (id: string): Promise<void> => {
    setDraft(null)
    setAiSummary('')
    applyStatus(await invoke('set', { activeProfileId: id }))
  }

  const deleteProfile = async (id: string): Promise<void> => {
    setDraft(null)
    applyStatus(await invoke('profile-delete', { id }))
  }

  const togglePower = async (): Promise<void> => {
    if (!settings) return
    setBusy(true)
    applyStatus(await invoke('set', { power: !settings.power }))
    setBusy(false)
  }

  const pickTarget = async (value: string): Promise<void> => {
    const dev = devices.find((d) => d.deviceId === value)
    applyStatus(
      await invoke('set', dev ? { target: dev.match, targetLabel: dev.label } : { target: '', targetLabel: '' })
    )
  }

  const linkCurrent = async (): Promise<void> => {
    if (!settings || !active) return
    if (!settings.target) {
      setError('Pick a specific output first — System Default cannot be linked.')
      return
    }
    applyStatus(
      await invoke('link-set', { match: settings.target, deviceLabel: settings.targetLabel || settings.target, profileId: active.id })
    )
    setMessage(`Linked ${settings.targetLabel || settings.target} → "${active.name}".`)
  }

  const runAiTune = async (): Promise<void> => {
    if (!settings || !active || aiBusy) return
    setAiBusy(true)
    setAiSummary('')
    setError('')
    try {
      const deviceLabel = settings.targetLabel || defaultLabel || 'unknown output'
      const tune = (await invoke('ai-tune', { profileId: active.id, deviceLabel, goal: aiGoal })) as AiTuneResult
      if (!tune.ok || !tune.gains) {
        setError(tune.error ?? 'AI tuning failed.')
        return
      }
      editCurve({ preampDb: tune.preampDb ?? active.preampDb, gains: tune.gains, fx: tune.fx })
      setAiSummary(`${tune.summary ?? 'Tuned.'} (via ${tune.provider ?? 'Gemini'})`)
    } finally {
      setAiBusy(false)
    }
  }

  /* ------------------------------- live wave ------------------------------ */

  const stopWave = (): void => {
    cancelAnimationFrame(waveRaf.current)
    waveStream.current?.getTracks().forEach((t) => t.stop())
    waveStream.current = null
    void waveCtx.current?.close().catch(() => undefined)
    waveCtx.current = null
  }

  const toggleWave = async (): Promise<void> => {
    if (waveOn) {
      stopWave()
      setWaveOn(false)
      return
    }
    try {
      // Windows system-audio loopback via the desktop capturer; the video track
      // is required to start the capture and is stopped immediately.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 320, maxHeight: 180, maxFrameRate: 2 } }
      } as unknown as MediaStreamConstraints)
      stream.getVideoTracks().forEach((t) => t.stop())
      const ac = new AudioContext()
      const src = ac.createMediaStreamSource(stream)
      const analyser = ac.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.82
      src.connect(analyser) // analysis only — never to destination (no echo)
      waveStream.current = stream
      waveCtx.current = ac
      setWaveOn(true)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const draw = (): void => {
        const cv = canvasRef.current
        if (!cv || !waveCtx.current) return
        const g = cv.getContext('2d')
        if (!g) return
        const W = (cv.width = cv.clientWidth * 2)
        const H = (cv.height = cv.clientHeight * 2)
        analyser.getByteFrequencyData(data)
        g.clearRect(0, 0, W, H)
        const nyquist = ac.sampleRate / 2
        const fMin = 25
        const fMax = 18000
        const xOf = (f: number): number => (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * W
        // spectrum
        g.beginPath()
        g.moveTo(0, H)
        const cols = 120
        for (let i = 0; i <= cols; i++) {
          const f = fMin * Math.pow(fMax / fMin, i / cols)
          const bin = Math.min(data.length - 1, Math.round((f / nyquist) * data.length))
          const v = data[bin] / 255
          g.lineTo((i / cols) * W, H - v * H * 0.92)
        }
        g.lineTo(W, H)
        g.closePath()
        g.fillStyle = 'rgba(139, 92, 246, 0.35)' // accent violet, both themes
        g.fill()
        // EQ curve overlay (from the sliders) for tuning against the wave
        const st = statusRef.current
        const cur = st?.settings.profiles.find((p) => p.id === st.settings.activeProfileId)
        const gains = (draftRef.current?.gains ?? cur?.gains ?? []) as number[]
        if (gains.length === 10) {
          g.beginPath()
          BANDS.forEach((f, i) => {
            const y = H / 2 - (gains[i] / 12) * (H / 2) * 0.9
            if (i === 0) g.moveTo(xOf(f), y)
            else g.lineTo(xOf(f), y)
          })
          g.strokeStyle = 'rgba(34, 197, 94, 0.9)' // ok green
          g.lineWidth = 3
          g.stroke()
        }
        g.strokeStyle = 'rgba(148, 155, 170, 0.35)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(0, H / 2)
        g.lineTo(W, H / 2)
        g.stroke()
        waveRaf.current = requestAnimationFrame(draw)
      }
      waveRaf.current = requestAnimationFrame(draw)
    } catch (err) {
      setError(`Could not start the live wave: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  draftRef.current = draft

  /* --------------------------------- UI ----------------------------------- */

  const power = settings?.power ?? false
  const knownTip = KNOWN_DEVICES.find((d) =>
    (settings?.targetLabel || defaultLabel).toUpperCase().includes(d.match.toUpperCase())
  )

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <AudioLines size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="WICKED Sound" />
          </h1>
          <p className="truncate text-xs text-muted">
            System-wide EQ — mixes, device links, Auto mode and Gemini tuning (Equalizer APO engine)
          </p>
        </div>
        <button
          onClick={() => void togglePower()}
          disabled={busy || !status?.engineInstalled}
          title={power ? 'Turn the mix off (passthrough)' : 'Turn the mix on'}
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40 ${
            power ? 'border-ok bg-ok/15 text-ok shadow-[0_0_18px_rgba(34,197,94,0.35)]' : 'border-edge text-muted hover:border-accent/60'
          }`}
        >
          {busy ? <Loader2 size={20} className="animate-spin" /> : <Power size={20} />}
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button onClick={() => setError('')} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}
      {message && (
        <div className="flex items-center gap-2 border-b border-edge bg-raised/50 px-5 py-1.5 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate">{message}</span>
          <button onClick={() => setMessage('')} className="rounded p-1 hover:bg-edge/60">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto grid max-w-[1500px] grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* ------------------------- left rail ------------------------- */}
          <div className="space-y-4">
            {/* engine */}
            {status && !status.engineInstalled && (
              <section className="rounded-xl border border-warn/50 bg-warn/10 p-3">
                <h2 className="text-sm font-semibold text-warn">One-time setup: install the engine</h2>
                <p className="mt-1 text-xs text-muted">
                  Windows only lets a driver-level component reshape ALL system audio, so WICKED Sound drives{' '}
                  <span className="font-medium">Equalizer APO</span> (free, open source). Install it once:
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-muted">
                  <li>Download and run the installer (admin prompt).</li>
                  <li>In its Configurator, tick your playback devices (Edifier M60, DT 770, Astro A40…).</li>
                  <li>Reboot when asked, then come back and hit Recheck.</li>
                </ol>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void invoke('open-download')}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-ink hover:opacity-90"
                  >
                    <Download size={13} /> Open download page
                  </button>
                  <button
                    onClick={() => void refresh()}
                    className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-xs font-medium hover:border-accent/60"
                  >
                    <RefreshCw size={13} /> Recheck
                  </button>
                </div>
              </section>
            )}
            {status?.engineInstalled && !status.configWritable && (
              <p className="rounded-xl border border-warn/50 bg-warn/10 p-2.5 text-[11px] text-warn">
                The Equalizer APO config folder needs admin rights on this PC — every mix change will show a UAC
                prompt. (Re-running the Equalizer APO installer normally restores user write access.)
              </p>
            )}

            {/* output picker */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <h2 className="text-sm font-semibold">Output</h2>
              <select
                value={devices.find((d) => d.match === settings?.target)?.deviceId ?? ''}
                onChange={(e) => void pickTarget(e.target.value)}
                className="mt-2 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              >
                <option value="">System Default (all outputs){defaultLabel ? ` — ${defaultLabel}` : ''}</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>

              <div className="mt-3 flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium">Auto mode</span>
                  <p className="text-[10px] text-muted">Follow the default output — apply its linked mix, calibrate new devices</p>
                </div>
                <button
                  onClick={() => settings && void invoke('set', { auto: !settings.auto }).then(applyStatus)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${settings?.auto ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-muted'}`}
                >
                  {settings?.auto ? 'On' : 'Off'}
                </button>
              </div>

              <button
                onClick={() => void linkCurrent()}
                disabled={!settings?.target || !active}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-xs font-medium hover:border-accent/60 disabled:opacity-40"
              >
                <Link2 size={13} /> Link this output to “{active?.name ?? '—'}”
              </button>

              {(settings?.links.length ?? 0) > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Linked devices</p>
                  {settings!.links.map((l) => (
                    <div key={l.match} className="flex items-center gap-2 rounded-lg bg-raised/60 px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 truncate" title={l.deviceLabel}>
                        {l.deviceLabel}
                        <span className="text-muted"> → {settings!.profiles.find((p) => p.id === l.profileId)?.name ?? l.profileId}</span>
                      </span>
                      <button
                        onClick={() => void invoke('link-remove', { match: l.match }).then(applyStatus)}
                        title="Unlink"
                        className="rounded p-1 text-muted hover:text-danger"
                      >
                        <Link2Off size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* device tips */}
            {knownTip && (
              <section className="rounded-xl border border-edge bg-surface p-3">
                <h2 className="text-sm font-semibold">Tuning tips — {knownTip.name}</h2>
                <p className="mt-1 text-xs text-muted">{knownTip.notes}</p>
              </section>
            )}

            {/* AI tune */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                <Sparkles size={14} className="text-accent" /> Tune with AI (Gemini)
              </h2>
              <input
                value={aiGoal}
                onChange={(e) => setAiGoal(e.target.value)}
                placeholder='e.g. "less harsh treble, keep the bass punchy"'
                className="mt-2 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => void runAiTune()}
                disabled={aiBusy || !active || !status?.hasGeminiKey}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                Tune “{active?.name ?? '—'}” for {settings?.targetLabel ? matchToken(settings.targetLabel) : defaultLabel || 'my output'}
              </button>
              {!status?.hasGeminiKey && (
                <p className="mt-1.5 text-[10px] text-muted">Add your Gemini key in Settings → API Keys to enable AI tuning.</p>
              )}
              {aiSummary && <p className="mt-2 rounded-lg bg-raised/60 p-2 text-xs">{aiSummary}</p>}
            </section>
          </div>

          {/* --------------------------- main panel --------------------------- */}
          <div className="space-y-4">
            {/* profiles */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <h2 className="text-sm font-semibold">Mixes</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {settings?.profiles.map((p: EqProfile) => (
                  <span key={p.id} className="group relative">
                    <button
                      onClick={() => void pickProfile(p.id)}
                      title={p.note ?? p.name}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                        p.id === settings.activeProfileId
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-edge text-muted hover:border-accent/50 hover:text-ink'
                      }`}
                    >
                      {p.name}
                    </button>
                    {!p.builtin && (
                      <button
                        onClick={() => void deleteProfile(p.id)}
                        title="Delete this mix"
                        className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-danger text-white group-hover:flex"
                      >
                        <Trash2 size={9} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {active?.note && <p className="mt-2 text-[11px] text-muted">{active.note}</p>}
            </section>

            {/* effects levers (FxSound-style) */}
            <section className={`rounded-xl border border-edge bg-surface p-4 ${power ? '' : 'opacity-60'}`}>
              <h2 className="text-sm font-semibold">Effects {active ? `— ${active.name}` : ''}</h2>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 xl:grid-cols-5">
                {FX_META.map((m) => (
                  <label key={m.key} className="block" title={m.hint}>
                    <span className="flex items-center justify-between text-xs font-medium">
                      {m.label}
                      <span className="tabular-nums text-muted">{shown.fx[m.key].toFixed(1)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={0.5}
                      value={shown.fx[m.key]}
                      onChange={(e) => editCurve({ fx: { ...shown.fx, [m.key]: clampFxLevel(Number(e.target.value)) } })}
                      className="mt-1 w-full accent-[rgb(var(--wk-accent))]"
                    />
                    <span className="text-[10px] leading-tight text-muted">{m.hint}</span>
                  </label>
                ))}
              </div>
            </section>

            {/* EQ */}
            <section className={`rounded-xl border border-edge bg-surface p-4 ${power ? '' : 'opacity-60'}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  Equalizer {active ? `— ${active.name}` : ''}
                  {!power && <span className="ml-2 text-xs font-normal text-muted">(power is off — passthrough)</span>}
                </h2>
                <label className="flex items-center gap-2 text-xs text-muted">
                  Preamp {shown.preampDb.toFixed(1)} dB
                  <input
                    type="range"
                    min={-20}
                    max={6}
                    step={0.5}
                    value={shown.preampDb}
                    onChange={(e) => editCurve({ preampDb: clampPreamp(Number(e.target.value)) })}
                    className="w-36 accent-[rgb(var(--wk-accent))]"
                  />
                </label>
              </div>
              <div className="mt-3 flex items-end justify-between gap-1 overflow-x-auto pb-1">
                {BANDS.map((f, i) => (
                  <div key={f} className="flex min-w-[52px] flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] tabular-nums text-muted">
                      {(shown.gains[i] ?? 0) > 0 ? '+' : ''}
                      {(shown.gains[i] ?? 0).toFixed(1)}
                    </span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={0.5}
                      value={shown.gains[i] ?? 0}
                      onChange={(e) => {
                        const gains = [...shown.gains]
                        gains[i] = clampGain(Number(e.target.value))
                        editCurve({ gains })
                      }}
                      style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 150, width: 22 }}
                      className="accent-[rgb(var(--wk-accent))]"
                    />
                    <span className="text-[10px] text-muted">{f >= 1000 ? `${f / 1000}k` : f}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* live wave */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Activity size={14} className="text-accent" /> Live wave
                  <span className="text-[10px] font-normal text-muted">system audio spectrum + your EQ curve (green)</span>
                </h2>
                <button
                  onClick={() => void toggleWave()}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${waveOn ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-muted hover:border-accent/60'}`}
                >
                  {waveOn ? 'Stop' : 'Start'}
                </button>
              </div>
              <canvas ref={canvasRef} className="mt-2 h-36 w-full rounded-lg bg-black/25" />
              {!waveOn && (
                <p className="mt-1 text-[10px] text-muted">
                  Start playback somewhere (YouTube, Spotify…) and hit Start — the wave shows what the whole PC is
                  outputting, with the active EQ curve overlaid so you can tune against it.
                </p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

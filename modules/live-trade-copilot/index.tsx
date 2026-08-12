import React, { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Crosshair,
  Loader2,
  MonitorPlay,
  Pause,
  Play,
  RefreshCw,
  Square,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import { ModuleTitle } from '@/shell/moduleContext'
import type { Action, AnalyzeResult, PositionState, SessionSummary, Signal, Stats, Verdict } from './types'

/**
 * LIVE TRADE COPILOT — renderer.
 *
 * Owns the screen capture (desktopCapturer source → getUserMedia legacy
 * constraints, no display-media handler needed) and the analysis loop: every
 * N seconds one JPEG frame of the captured window goes to main via invoke,
 * main blends it with live Webull data and returns a verdict. The banner and
 * callout feed update live; a WebAudio chime fires when the call flips into
 * BUY or SELL.
 */
const ID = 'live-trade-copilot'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

const INTERVALS = [10, 15, 30, 60]
const SESSION_CAP_MS = 60 * 60_000 // hard stop after an hour
const MAX_FAILS = 5
// rough per-call cost estimates (1280px frame + ~1.5k prompt + ~300 out tokens)
const EST_COST: Record<string, number> = { lite: 0.005, pro: 0.02 }

interface SourceInfo {
  id: string
  name: string
  thumbnail: string
}

interface FeedItem {
  t: number
  kind: 'verdict' | 'system' | 'signal'
  verdict?: Verdict
  provider?: string
  barsOk?: boolean
  text?: string
  tone?: 'open' | 'win' | 'loss' | 'flat'
}

const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour12: false })
const fmtElapsed = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const fmtCost = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

/** Two-note WebAudio chime — rising for BUY, falling for SELL. No assets. */
function chime(ctx: AudioContext, kind: 'buy' | 'sell'): void {
  const notes = kind === 'buy' ? [660, 880] : [880, 660]
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    const t0 = ctx.currentTime + i * 0.14
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0)
    osc.stop(t0 + 0.15)
  })
}

const ACTION_STYLE: Record<Action, string> = {
  BUY: 'bg-ok text-white',
  SELL: 'bg-danger text-white',
  HOLD: 'bg-warn text-black',
  WAIT: 'bg-raised text-muted'
}

export default function LiveTradeCopilot(): React.JSX.Element {
  const [sources, setSources] = useState<SourceInfo[] | null>(null)
  const [sourcesBusy, setSourcesBusy] = useState(false)
  const [captureName, setCaptureName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [intervalSec, setIntervalSec] = useState(15)
  const [model, setModel] = useState<'lite' | 'pro'>('lite')
  const [soundOn, setSoundOn] = useState(true)
  const [position, setPosition] = useState<PositionState>({ inPosition: false })
  const [entryText, setEntryText] = useState('')
  const [running, setRunning] = useState(false)
  const [paused, setPaused] = useState(false)
  const [verdict, setVerdict] = useState<(Verdict & { t: number }) | null>(null)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [barsWarn, setBarsWarn] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [calls, setCalls] = useState(0)
  const [cost, setCost] = useState(0)
  const [history, setHistory] = useState<SessionSummary[]>([])
  const [error, setError] = useState('')
  const [view, setView] = useState<'live' | 'analytics'>('live')
  const [analytics, setAnalytics] = useState<{ stats: Stats; signals: Signal[] } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlightRef = useRef(false)
  const sessionIdRef = useRef('')
  const startedAtRef = useRef(0)
  const failsRef = useRef(0)
  const callsRef = useRef(0)
  const flipsRef = useRef(0)
  const lastActionRef = useRef<Action | null>(null)
  const audioRef = useRef<AudioContext | null>(null)
  const positionRef = useRef(position)
  positionRef.current = position
  const modelRef = useRef(model)
  modelRef.current = model
  const soundRef = useRef(soundOn)
  soundRef.current = soundOn

  const pushFeed = (item: FeedItem): void => setFeed((f) => [item, ...f].slice(0, 200))
  const sys = (text: string): void => pushFeed({ t: Date.now(), kind: 'system', text })

  const loadHistory = async (): Promise<void> => {
    const res = (await invoke('get-history')) as { ok?: boolean; sessions?: SessionSummary[] }
    if (res.ok) setHistory(res.sessions ?? [])
  }

  const loadAnalytics = async (): Promise<void> => {
    const res = (await invoke('get-analytics')) as { ok?: boolean; stats?: Stats; signals?: Signal[] }
    if (res.ok && res.stats) setAnalytics({ stats: res.stats, signals: res.signals ?? [] })
  }

  useEffect(() => {
    void loadHistory()
    return () => {
      // leaving the tool tears everything down
      if (timerRef.current) clearInterval(timerRef.current)
      if (clockRef.current) clearInterval(clockRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  /* ------------------------------- capture -------------------------------- */

  const openPicker = async (): Promise<void> => {
    setSourcesBusy(true)
    try {
      const res = (await invoke('list-sources')) as { ok?: boolean; sources?: SourceInfo[]; error?: string }
      if (res.ok) setSources(res.sources ?? [])
      else setError(res.error ?? 'Could not list windows.')
    } finally {
      setSourcesBusy(false)
    }
  }

  const pickSource = async (src: SourceInfo): Promise<void> => {
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      // legacy Electron desktop-capture constraints (chromeMediaSourceId) —
      // not in the TS lib types, hence the cast
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxWidth: 1920,
            maxHeight: 1200,
            maxFrameRate: 5
          }
        }
      } as unknown as MediaStreamConstraints
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      setCaptureName(src.name)
      setSources(null)
      setError('')
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        void videoRef.current.play().catch(() => undefined)
      }
      const track = stream.getVideoTracks()[0]
      if (track)
        track.onended = () => {
          setCaptureName('')
          if (sessionIdRef.current) {
            setPaused(true)
            if (timerRef.current) clearInterval(timerRef.current)
            timerRef.current = null
            sys('Capture ended (window closed?) — pick the window again to resume.')
          }
        }
      // resume a paused session once capture is back
      if (sessionIdRef.current && paused) {
        setPaused(false)
        startTimer()
        sys('Capture re-attached — resuming analysis.')
      }
    } catch (err) {
      setError(`Could not capture that window: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const grabFrame = (): string | null => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return null
    if (!canvasRef.current) canvasRef.current = document.createElement('canvas')
    const cv = canvasRef.current
    const scale = Math.min(1, 1280 / video.videoWidth)
    cv.width = Math.round(video.videoWidth * scale)
    cv.height = Math.round(video.videoHeight * scale)
    const c2d = cv.getContext('2d')
    if (!c2d) return null
    c2d.drawImage(video, 0, 0, cv.width, cv.height)
    return cv.toDataURL('image/jpeg', 0.8)
  }

  /* --------------------------------- loop ---------------------------------- */

  const tick = async (): Promise<void> => {
    if (inFlightRef.current || !sessionIdRef.current) return
    if (Date.now() - startedAtRef.current > SESSION_CAP_MS) {
      sys('Session hit the 60-minute cap — stopped. Start again to keep going.')
      await stopSession()
      return
    }
    const image = grabFrame()
    if (!image) return
    inFlightRef.current = true
    try {
      const res = (await invoke('analyze', {
        sessionId: sessionIdRef.current,
        image,
        position: positionRef.current,
        model: modelRef.current
      })) as AnalyzeResult
      if (!sessionIdRef.current) return
      if (res.ok) {
        failsRef.current = 0
        callsRef.current++
        setCalls((n) => n + 1)
        setCost((c) => c + (EST_COST[modelRef.current] ?? 0.005))
        setVerdict({ ...res.verdict, t: res.t })
        setBarsWarn(res.barsOk ? '' : (res.barsError ?? 'No live bars — vision only.'))
        pushFeed({ t: res.t, kind: 'verdict', verdict: res.verdict, provider: res.provider, barsOk: res.barsOk })
        // hypothetical trade markers: entry price on flips, % on closes
        for (const ev of res.signalEvents ?? []) {
          const s = ev.signal
          if (ev.type === 'open') {
            pushFeed({
              t: res.t,
              kind: 'signal',
              tone: 'open',
              text: `▶ ${s.dir} opened ${s.entryP != null ? `@${s.entryP.toFixed(2)}` : '(no price)'}`
            })
          } else {
            pushFeed({
              t: res.t,
              kind: 'signal',
              tone: s.pct == null ? 'flat' : s.pct > 0 ? 'win' : s.pct < 0 ? 'loss' : 'flat',
              text: `✔ ${s.dir} closed ${s.pct != null ? `${s.pct >= 0 ? '+' : ''}${s.pct.toFixed(2)}%` : '(no price)'} (${s.reason})`
            })
          }
        }
        const prev = lastActionRef.current
        const act = res.verdict.action
        if (act !== prev && (act === 'BUY' || act === 'SELL')) {
          flipsRef.current++
          if (soundRef.current && audioRef.current) chime(audioRef.current, act === 'BUY' ? 'buy' : 'sell')
        }
        lastActionRef.current = act
      } else {
        failsRef.current++
        sys(`Analysis failed: ${res.error}`)
        if (failsRef.current >= MAX_FAILS) {
          setPaused(true)
          if (timerRef.current) clearInterval(timerRef.current)
          timerRef.current = null
          sys(`${MAX_FAILS} failures in a row — paused. Fix the issue and press Resume.`)
        }
      }
    } finally {
      inFlightRef.current = false
    }
  }

  const startTimer = (): void => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => void tick(), intervalSec * 1000)
  }

  const startSession = async (): Promise<void> => {
    if (!streamRef.current) {
      setError('Pick the window to watch first.')
      return
    }
    setError('')
    // AudioContext must be born from a user gesture
    if (!audioRef.current) {
      try {
        audioRef.current = new AudioContext()
      } catch {
        audioRef.current = null
      }
    }
    const res = (await invoke('start-session', { symbol })) as {
      ok?: boolean
      sessionId?: string
      hasWebull?: boolean
      error?: string
    }
    if (!res.ok || !res.sessionId) {
      setError(res.error ?? 'Could not start.')
      return
    }
    sessionIdRef.current = res.sessionId
    startedAtRef.current = Date.now()
    failsRef.current = 0
    flipsRef.current = 0
    lastActionRef.current = null
    setRunning(true)
    setPaused(false)
    setVerdict(null)
    setFeed([])
    callsRef.current = 0
    setCalls(0)
    setCost(0)
    setElapsed(0)
    sys(
      `Session started on ${symbol || '(no ticker — vision only)'} · every ${intervalSec}s · ${model === 'pro' ? 'Smart' : 'Fast'} model${res.hasWebull && symbol ? ' · live Webull bars on' : ''}`
    )
    clockRef.current = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 1000)
    startTimer()
    void tick()
  }

  const pauseSession = (): void => {
    if (!sessionIdRef.current) return
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    setPaused(true)
    sys('Paused — session memory, signals and feed are kept. Resume when ready.')
  }

  const resumeSession = (): void => {
    if (!sessionIdRef.current) return
    failsRef.current = 0
    setPaused(false)
    startTimer()
    sys('Resumed.')
  }

  const stopSession = async (): Promise<void> => {
    const id = sessionIdRef.current
    sessionIdRef.current = ''
    if (timerRef.current) clearInterval(timerRef.current)
    if (clockRef.current) clearInterval(clockRef.current)
    timerRef.current = null
    clockRef.current = null
    setRunning(false)
    setPaused(false)
    if (id) {
      const summary: SessionSummary = {
        symbol,
        startedAt: startedAtRef.current,
        endedAt: Date.now(),
        verdictCount: callsRef.current,
        flips: flipsRef.current,
        lastAction: lastActionRef.current,
        note: barsWarn ? 'vision-only' : undefined
      }
      await invoke('stop-session', { sessionId: id, summary })
      sys('Session stopped — transcript saved to The Brain.')
      void loadHistory()
      void loadAnalytics()
    }
  }

  /* ---------------------------------- UI ----------------------------------- */

  const setInPosition = (inPos: boolean): void => {
    const entry = Number(entryText)
    setPosition(inPos ? { inPosition: true, entryPrice: Number.isFinite(entry) && entry > 0 ? entry : undefined } : { inPosition: false })
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Crosshair size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Live Trade Copilot" />
          </h1>
          <p className="truncate text-xs text-muted">
            Watches your chart window live · hybrid vision + Webull 1-minute bars · 1-10 minute scalps
          </p>
        </div>
        {running && (
          <span className="text-xs text-muted">
            {fmtElapsed(elapsed)} · {calls} check(s) · ~{fmtCost(cost)}
          </span>
        )}
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

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="mx-auto grid h-full max-w-[1600px] grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* left rail */}
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            {/* setup */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <h2 className="text-sm font-semibold">Session</h2>
              <button
                onClick={() => void openPicker()}
                disabled={sourcesBusy}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm font-medium hover:border-accent/60 disabled:opacity-40"
              >
                {sourcesBusy ? <Loader2 size={14} className="animate-spin" /> : <MonitorPlay size={14} />}
                {captureName ? 'Change window' : 'Pick window to watch'}
              </button>
              {captureName && <p className="mt-1 truncate text-[11px] text-muted">Watching: {captureName}</p>}

              <label className="mt-3 block text-xs font-medium text-muted">Ticker on the chart</label>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                disabled={running}
                placeholder="e.g. NVDA (powers live bars)"
                className="mt-1 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-muted">Check every</label>
                  <select
                    value={intervalSec}
                    onChange={(e) => {
                      setIntervalSec(Number(e.target.value))
                      if (running && !paused && timerRef.current) {
                        clearInterval(timerRef.current)
                        timerRef.current = setInterval(() => void tick(), Number(e.target.value) * 1000)
                      }
                    }}
                    className="mt-1 w-full rounded-lg border border-edge bg-raised px-2 py-2 text-sm outline-none focus:border-accent"
                  >
                    {INTERVALS.map((s) => (
                      <option key={s} value={s}>
                        {s}s
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted">Model</label>
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value === 'pro' ? 'pro' : 'lite')}
                    disabled={running}
                    className="mt-1 w-full rounded-lg border border-edge bg-raised px-2 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
                  >
                    <option value="lite">Fast (Haiku)</option>
                    <option value="pro">Smart (Sonnet)</option>
                  </select>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs font-medium text-muted">Chime on BUY/SELL flips</span>
                <button
                  onClick={() => setSoundOn((v) => !v)}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${soundOn ? 'border-accent text-accent' : 'border-edge text-muted'}`}
                >
                  {soundOn ? <Volume2 size={12} /> : <VolumeX size={12} />} {soundOn ? 'On' : 'Off'}
                </button>
              </div>

              {/* position state */}
              <label className="mt-3 block text-xs font-medium text-muted">Your position (advice adapts)</label>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setInPosition(false)}
                  className={`rounded-lg border px-2 py-1.5 text-xs font-medium ${!position.inPosition ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-muted'}`}
                >
                  I&apos;m flat
                </button>
                <button
                  onClick={() => setInPosition(true)}
                  className={`rounded-lg border px-2 py-1.5 text-xs font-medium ${position.inPosition ? 'border-ok bg-ok/10 text-ok' : 'border-edge text-muted'}`}
                >
                  I&apos;m in
                </button>
              </div>
              {position.inPosition && (
                <input
                  value={entryText}
                  onChange={(e) => {
                    setEntryText(e.target.value.replace(/[^0-9.]/g, ''))
                    const v = Number(e.target.value)
                    if (Number.isFinite(v) && v > 0) setPosition({ inPosition: true, entryPrice: v })
                  }}
                  placeholder="Entry price $"
                  className="mt-1.5 w-full rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
              )}

              {running ? (
                paused ? (
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <button
                      onClick={resumeSession}
                      className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90"
                    >
                      <Play size={14} /> Resume
                    </button>
                    <button
                      onClick={() => void stopSession()}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-danger/60 px-3 py-2.5 text-sm font-semibold text-danger hover:bg-danger/10"
                    >
                      <Square size={14} /> Stop
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-1.5">
                    <button
                      onClick={pauseSession}
                      title="Pause the checks — everything (memory, signals, feed) is kept for Resume"
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-edge px-3 py-2.5 text-sm font-semibold hover:border-accent/60"
                    >
                      <Pause size={14} /> Pause
                    </button>
                    <button
                      onClick={() => void stopSession()}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-danger/60 px-3 py-2.5 text-sm font-semibold text-danger hover:bg-danger/10"
                    >
                      <Square size={14} /> Stop
                    </button>
                  </div>
                )
              ) : (
                <button
                  onClick={() => void startSession()}
                  disabled={!captureName}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
                >
                  <Play size={15} /> Start watching
                </button>
              )}
            </section>

            {/* verdict banner */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <div className={`rounded-xl px-4 py-5 text-center ${verdict ? ACTION_STYLE[verdict.action] : 'bg-raised text-muted'}`}>
                <div className="text-3xl font-black tracking-wide">{verdict?.action ?? '—'}</div>
                {verdict && (
                  <div className="mt-1 text-xs font-medium opacity-90">
                    {verdict.bias} · confidence {verdict.confidence} · {fmtClock(verdict.t)}
                  </div>
                )}
              </div>
              {verdict?.oneLiner && <p className="mt-2 text-sm font-medium">{verdict.oneLiner}</p>}
              {verdict?.exitHint && verdict.exitHint !== '-' && (
                <p className="mt-1 text-xs text-muted">Exit: {verdict.exitHint}</p>
              )}
              {barsWarn && (
                <p className="mt-2 rounded-lg border border-warn/50 bg-warn/10 px-2 py-1 text-[11px] text-warn">
                  No live bars — {barsWarn}
                </p>
              )}
              <p className="mt-2 text-center text-[10px] text-muted">AI analysis, not financial advice.</p>
            </section>

            {/* recent sessions */}
            {!running && history.length > 0 && (
              <section className="rounded-xl border border-edge bg-surface p-3">
                <h2 className="text-sm font-semibold">Recent sessions</h2>
                <div className="mt-2 space-y-1">
                  {history.slice(0, 8).map((h, i) => (
                    <div key={i} className="rounded-lg border border-edge px-2 py-1.5 text-xs">
                      <span className="font-semibold">{h.symbol || '(no ticker)'}</span>
                      <span className="text-muted">
                        {' '}
                        · {new Date(h.startedAt).toLocaleString()} · {h.verdictCount} check(s) · {h.flips} signal(s)
                        {h.note ? ` · ${h.note}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* right: preview + callouts, or analytics */}
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-muted">{view === 'analytics' ? 'Analytics — signal track record' : 'Live view'}</h2>
              <button
                onClick={() => {
                  if (view === 'live') {
                    void loadAnalytics()
                    setView('analytics')
                  } else setView('live')
                }}
                className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs font-medium hover:border-accent/60"
              >
                {view === 'live' ? (
                  <>
                    <BarChart3 size={13} /> Analytics
                  </>
                ) : (
                  <>
                    <ArrowLeft size={13} /> Back to live
                  </>
                )}
              </button>
            </div>
            {view === 'analytics' && <AnalyticsPanel data={analytics} />}
            {/* the live view is HIDDEN (never unmounted) in analytics — grabFrame
                reads the <video>, so a running session keeps ticking */}
            <div className={`rounded-xl border border-edge bg-surface p-2 ${view === 'analytics' ? 'hidden' : ''}`}>
              <video
                ref={videoRef}
                muted
                autoPlay
                playsInline
                className="max-h-[42vh] w-full rounded-lg bg-black/40 object-contain"
              />
              {!captureName && (
                <p className="py-8 text-center text-xs text-muted">
                  Pick the Firefox window with your TradingView chart — the live preview shows here.
                </p>
              )}
            </div>
            <div className={`min-h-0 flex-1 overflow-y-auto rounded-xl border border-edge bg-surface p-3 ${view === 'analytics' ? 'hidden' : ''}`}>
              <h2 className="text-sm font-semibold">Callouts</h2>
              {feed.length === 0 && (
                <p className="mt-2 text-xs text-muted">
                  Start a session and every check lands here — action, patterns as they form, key levels, and the
                  reasoning.
                </p>
              )}
              <div className="mt-2 space-y-2">
                {feed.map((item, i) =>
                  item.kind === 'system' ? (
                    <p key={i} className="text-[11px] text-muted">
                      {fmtClock(item.t)} — {item.text}
                    </p>
                  ) : item.kind === 'signal' ? (
                    <p
                      key={i}
                      className={`text-xs font-semibold ${
                        item.tone === 'win'
                          ? 'text-ok'
                          : item.tone === 'loss'
                            ? 'text-danger'
                            : item.tone === 'open'
                              ? 'text-accent'
                              : 'text-muted'
                      }`}
                    >
                      {fmtClock(item.t)} {item.text}
                    </p>
                  ) : (
                    <div key={i} className="rounded-lg border border-edge bg-raised p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-muted">{fmtClock(item.t)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${ACTION_STYLE[item.verdict!.action]}`}>
                          {item.verdict!.action}
                        </span>
                        <span className="text-[11px] text-muted">conf {item.verdict!.confidence}</span>
                        {item.verdict!.patterns.map((p, j) => (
                          <span
                            key={j}
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              p.status === 'confirmed'
                                ? 'border-ok/60 text-ok'
                                : p.status === 'failed'
                                  ? 'border-edge text-muted line-through'
                                  : 'border-warn/60 text-warn'
                            }`}
                          >
                            {p.name}
                          </span>
                        ))}
                        {item.barsOk === false && <span className="text-[10px] text-warn">vision-only</span>}
                      </div>
                      {(item.verdict!.levels.support.length > 0 || item.verdict!.levels.resistance.length > 0) && (
                        <p className="mt-1 text-[11px] text-muted">
                          {item.verdict!.levels.support.length > 0 && <>S: {item.verdict!.levels.support.join(' / ')} </>}
                          {item.verdict!.levels.resistance.length > 0 && <>R: {item.verdict!.levels.resistance.join(' / ')}</>}
                        </p>
                      )}
                      {item.verdict!.detail && <p className="mt-1 text-xs">{item.verdict!.detail}</p>}
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* analytics panel is rendered inside the right column (see above) */}
      {/* window picker modal */}
      {sources !== null && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-6" onClick={() => setSources(null)}>
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-edge bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Pick the window to watch</h2>
              <div className="flex gap-1.5">
                <button
                  onClick={() => void openPicker()}
                  className="flex items-center gap-1 rounded-lg border border-edge px-2 py-1 text-xs text-muted hover:text-ink"
                >
                  <RefreshCw size={12} /> Refresh
                </button>
                <button onClick={() => setSources(null)} className="rounded-lg border border-edge px-2 py-1 text-xs text-muted hover:text-ink">
                  <X size={12} />
                </button>
              </div>
            </div>
            {sources.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted">No capturable windows found.</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {sources.map((src) => (
                  <button
                    key={src.id}
                    onClick={() => void pickSource(src)}
                    className="rounded-lg border border-edge p-2 text-left hover:border-accent"
                  >
                    <img src={src.thumbnail} alt="" className="h-24 w-full rounded object-cover" />
                    <p className="mt-1.5 truncate text-xs font-medium">{src.name}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ analytics panel ---------------------------- */

const pct = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

function AnalyticsPanel({ data }: { data: { stats: Stats; signals: Signal[] } | null }): React.JSX.Element {
  if (!data)
    return (
      <div className="flex items-center justify-center rounded-xl border border-edge bg-surface p-10 text-sm text-muted">
        <Loader2 size={15} className="mr-2 animate-spin" /> Loading track record…
      </div>
    )
  const { stats, signals } = data
  if (stats.signals === 0 && stats.unpriced === 0)
    return (
      <div className="rounded-xl border border-edge bg-surface p-10 text-center text-sm text-muted">
        No signals recorded yet — run sessions and every BUY/SELL flip gets scored here (closed on the opposite flip,
        a 10-minute timeout, or session end).
      </div>
    )

  // cumulative % curve, oldest → newest priced signals
  const priced = [...signals].filter((s) => s.pct != null).sort((a, b) => (a.exitT ?? 0) - (b.exitT ?? 0))
  let run = 0
  const curve = priced.map((s) => (run += s.pct ?? 0))
  const W = 260
  const H = 48
  const min = Math.min(0, ...curve)
  const max = Math.max(0, ...curve)
  const span = max - min || 1
  const pts = curve.map((v, i) => `${(i / Math.max(1, curve.length - 1)) * W},${H - ((v - min) / span) * H}`).join(' ')
  const zeroY = H - ((0 - min) / span) * H

  const card = (label: string, value: string, tone?: 'ok' | 'danger'): React.JSX.Element => (
    <div className="rounded-lg border border-edge bg-raised px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`text-lg font-bold ${tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : ''}`}>{value}</p>
    </div>
  )

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <div className="rounded-xl border border-edge bg-surface p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {card('Signals', `${stats.signals}${stats.unpriced ? ` (+${stats.unpriced} unpriced)` : ''}`)}
          {card('Win rate', `${stats.winRate}%`, stats.winRate >= 50 ? 'ok' : 'danger')}
          {card('Avg / signal', pct(stats.avgPct), stats.avgPct >= 0 ? 'ok' : 'danger')}
          {card('Net cumulative', pct(stats.netPct), stats.netPct >= 0 ? 'ok' : 'danger')}
          {card('Long / Short', `${stats.long.winRate}% · ${stats.short.winRate}%`)}
        </div>
        {curve.length >= 2 && (
          <div className="mt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Cumulative % over signals</p>
            <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-14 w-full" preserveAspectRatio="none">
              <line x1={0} y1={zeroY} x2={W} y2={zeroY} className="stroke-current text-edge" strokeWidth={1} />
              <polyline
                points={pts}
                fill="none"
                strokeWidth={1.6}
                className={`stroke-current ${stats.netPct >= 0 ? 'text-ok' : 'text-danger'}`}
              />
            </svg>
          </div>
        )}
      </div>

      {stats.patterns.length > 0 && (
        <div className="rounded-xl border border-edge bg-surface p-3">
          <h3 className="text-sm font-semibold">By pattern (at entry)</h3>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-2 font-medium">Pattern</th>
                <th className="py-1 pr-2 text-right font-medium">Signals</th>
                <th className="py-1 pr-2 text-right font-medium">Win %</th>
                <th className="py-1 text-right font-medium">Avg %</th>
              </tr>
            </thead>
            <tbody>
              {stats.patterns.map((p) => (
                <tr key={p.name} className="border-t border-edge">
                  <td className="py-1 pr-2">{p.name}</td>
                  <td className="py-1 pr-2 text-right">{p.count}</td>
                  <td className="py-1 pr-2 text-right">{p.winRate}</td>
                  <td className={`py-1 text-right ${p.avgPct >= 0 ? 'text-ok' : 'text-danger'}`}>{pct(p.avgPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-edge bg-surface p-3">
        <h3 className="text-sm font-semibold">Recent signals</h3>
        <table className="mt-2 w-full text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 pr-2 font-medium">When</th>
              <th className="py-1 pr-2 font-medium">Ticker</th>
              <th className="py-1 pr-2 font-medium">Dir</th>
              <th className="py-1 pr-2 font-medium">Entry → Exit</th>
              <th className="py-1 pr-2 text-right font-medium">%</th>
              <th className="py-1 font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((s, i) => (
              <tr key={i} className="border-t border-edge">
                <td className="py-1 pr-2 text-muted">{new Date(s.entryT).toLocaleString()}</td>
                <td className="py-1 pr-2 font-semibold">{s.symbol || '(no ticker)'}</td>
                <td className="py-1 pr-2">{s.dir}</td>
                <td className="py-1 pr-2">
                  {s.entryP != null ? `$${s.entryP.toFixed(2)}` : 'no price'} →{' '}
                  {s.exitP != null ? `$${s.exitP.toFixed(2)}` : 'no price'}
                </td>
                <td className={`py-1 pr-2 text-right font-semibold ${s.pct == null ? 'text-muted' : s.pct >= 0 ? 'text-ok' : 'text-danger'}`}>
                  {pct(s.pct)}
                </td>
                <td className="py-1 text-muted">{s.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

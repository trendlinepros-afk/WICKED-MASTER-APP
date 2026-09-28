/**
 * ScreenRec — main process.
 *
 * Ctrl+R (configurable, registered through the shell) drives a small state
 * machine:
 *
 *   idle ──Ctrl+R──▶ picking (overlay on every monitor: click it or press its number)
 *                      └─▶ armed (the chosen area is outlined: press R) ─▶ [countdown] ─▶ recording
 *   idle ──Ctrl+R with a default screen──────────────────────────────────▶ [countdown] ─▶ recording
 *   recording ──Ctrl+R──▶ stopping ─▶ idle (clip added to the open session)
 *
 * Capture runs in a hidden shell helper window (Chromium desktop capture +
 * microphone [+ computer sound] → MediaRecorder), streamed to disk in 1 s
 * chunks so a crash loses at most a second. Each finished clip is remuxed to
 * MKV (seekable), measured and thumbnailed. "Complete session" renders every
 * included clip into one 1920×1080 MP4 (ipc/render.ts) with an optional music
 * bed at a preset dB, then starts a fresh session.
 */
import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync } from 'fs'
import { open as openFile, type FileHandle } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { HelperWindow, ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import type { AreaMode, Clip, ClipView, Frac, HistoryItem, HotkeyStatus, MusicInfo, Paths, Phase, RecState, RenderJob, RenderPrefs, ScreenInfo, Session, SessionView, Settings } from './types'
import { areaFor, areaLabel, fmtDuration, numberScreens, videoBitrate } from './lib/geometry'
import { prettyAccelerator } from './lib/hotkey'
import { outputName, thumbArgs } from './lib/render-plan'
import { decodeDuration, probeMedia, runFfmpeg } from './ipc/ffmpeg'
import { indicatorHtml, overlayHtml, recorderHtml } from './ipc/pages'
import { renderSession } from './ipc/render'
import { createStorage, ID, sanitizeRender, sanitizeSettings } from './ipc/storage'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const rid = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const rmQuiet = (p: string): void => {
  try {
    if (p && existsSync(p)) unlinkSync(p)
  } catch {
    /* best-effort */
  }
}
const sizeOf = (p: string): number => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma']
const AUDIO_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma' }

interface RecEvent {
  type: string
  clipId?: string
  phase?: string
  [k: string]: unknown
}

interface Active {
  clip: Clip
  fh: FileHandle
  bytes: number
  startedAt: number
  screen: ScreenInfo
  chain: Promise<void>
  writeError: string
  lastTick: number
}

export default function register(ctx: ModuleIpcContext): void {
  const h = ctx.ipcMain
  const store = createStorage(ctx.app)

  /* ------------------------------ broadcasting ------------------------------ */

  const broadcast = (event: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(`${ID}:${event}`, payload)
    }
  }

  /* --------------------------------- screens -------------------------------- */

  const getScreens = (): ScreenInfo[] =>
    numberScreens(
      screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, size: d.size })),
      screen.getPrimaryDisplay().id
    )
  const screenUnderCursor = (): ScreenInfo | null => {
    const list = getScreens()
    try {
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      return list.find((s) => s.id === String(d.id)) ?? list[0] ?? null
    } catch {
      return list[0] ?? null
    }
  }
  const areaOf = (s: ScreenInfo): { mode: AreaMode; frac: Frac } => {
    const st = store.getSettings()
    const custom = store.getMachine().customAreas[s.id] ?? null
    const mode: AreaMode = st.areaMode === 'custom' && !custom ? 'workarea' : st.areaMode
    return { mode, frac: areaFor(mode, s, custom) }
  }
  const hotkeyLabel = (): string => prettyAccelerator(store.getSettings().hotkey)
  const audioSummary = (): string => {
    const st = store.getSettings()
    const m = store.getMachine()
    const parts: string[] = []
    if (m.mic) parts.push(m.mic.deviceId === 'default' || !m.mic.label ? 'Windows default microphone' : m.mic.label)
    if (st.systemAudio) parts.push('computer sound')
    return parts.join(' + ') || 'none — no microphone selected'
  }

  /* ---------------------------------- state --------------------------------- */

  let phase: Phase = 'idle'
  let target: ScreenInfo | null = null
  let warnings: string[] = []
  let lastError = ''
  let hotkey: HotkeyStatus = { accelerator: store.getSettings().hotkey, enabled: store.getSettings().hotkeyEnabled, registered: false, error: '' }
  let active: Active | null = null

  /** read the phase through a call so TS doesn't narrow it across awaits */
  const curPhase = (): Phase => phase
  const stateView = (): RecState => ({ phase, screen: target, clipId: active?.clip.id ?? null, startedAt: active?.startedAt || null, warnings, lastError, hotkey })
  const emitState = (): void => broadcast('state', stateView())
  const setPhase = (p: Phase): void => {
    phase = p
    emitState()
  }

  const sessionView = (): SessionView | null => {
    const s = store.getSession()
    if (!s) return null
    const clips: ClipView[] = s.clips.map((c) => ({ ...c, exists: existsSync(c.file) }))
    return {
      id: s.id,
      createdAt: s.createdAt,
      dir: s.dir,
      clips,
      totalMs: clips.reduce((a, c) => a + c.durationMs, 0),
      includedMs: clips.filter((c) => c.include).reduce((a, c) => a + c.durationMs, 0)
    }
  }
  const emitSession = (): void => broadcast('session', sessionView())

  const pathsView = (): Paths => ({ rawDir: store.rawDir(), outputDir: store.outputDir(), dataDir: store.dataDir })
  const settingsView = (): { settings: Settings; machine: ReturnType<typeof store.getMachine>; hotkey: HotkeyStatus; paths: Paths } => ({
    settings: store.getSettings(),
    machine: store.getMachine(),
    hotkey,
    paths: pathsView()
  })
  const emitSettings = (): void => broadcast('settings', settingsView())

  /* --------------------------------- hotkeys -------------------------------- */

  function applyHotkey(): void {
    if (hotkey.registered) ctx.unregisterGlobalShortcut(hotkey.accelerator)
    const st = store.getSettings()
    hotkey = { accelerator: st.hotkey, enabled: st.hotkeyEnabled, registered: false, error: '' }
    if (st.hotkeyEnabled) {
      const r = ctx.registerGlobalShortcut(st.hotkey, onHotkey)
      if (r.ok) hotkey.registered = true
      else hotkey.error = r.error
    }
    emitState()
  }

  /** plain keys (R, Esc, 1–9) are only grabbed system-wide while the picker is up */
  let tempKeys: string[] = []
  const clearTempKeys = (): void => {
    for (const k of tempKeys) ctx.unregisterGlobalShortcut(k)
    tempKeys = []
  }
  const setTempKeys = (map: Record<string, () => void>): void => {
    clearTempKeys()
    for (const [k, fn] of Object.entries(map)) {
      if (k === hotkey.accelerator) continue
      if (ctx.registerGlobalShortcut(k, fn).ok) tempKeys.push(k)
    }
  }

  let flowTimer: ReturnType<typeof setTimeout> | null = null
  const clearFlowTimer = (): void => {
    if (flowTimer) clearTimeout(flowTimer)
    flowTimer = null
  }
  const armFlowTimer = (): void => {
    clearFlowTimer()
    flowTimer = setTimeout(() => cancelFlow(), 90_000)
  }

  function onHotkey(): void {
    switch (phase) {
      case 'idle':
        void beginFlow()
        break
      case 'picking':
      case 'countdown':
        cancelFlow()
        break
      case 'armed':
        void go()
        break
      case 'recording':
        void stopRecording()
        break
      default:
        break // starting / stopping — ignore repeats
    }
  }

  /* -------------------------------- overlays -------------------------------- */

  const overlays = new Map<string, HelperWindow>()
  function overlayFor(s: ScreenInfo): HelperWindow {
    const have = overlays.get(s.id)
    if (have?.isAlive()) {
      have.setBounds(s.bounds)
      return have
    }
    const w = ctx.createHelperWindow({ html: overlayHtml(s.id), bounds: s.bounds, transparent: true, alwaysOnTop: true, focusable: true, excludeFromCapture: true })
    w.onClosed(() => {
      if (overlays.get(s.id) === w) overlays.delete(s.id)
    })
    overlays.set(s.id, w)
    return w
  }
  function hideOverlays(except?: string): void {
    for (const [id, w] of overlays) {
      if (id === except) continue
      w.send(`${ID}:ov`, { mode: 'hidden' })
      w.hide()
    }
  }
  function dropOverlays(): void {
    for (const w of overlays.values()) w.close()
    overlays.clear()
  }
  const onDisplaysAddedRemoved = (): void => {
    if (phase === 'picking' || phase === 'armed' || phase === 'countdown') cancelFlow()
    dropOverlays()
    broadcast('screens', null)
  }
  screen.on('display-added', onDisplaysAddedRemoved)
  screen.on('display-removed', onDisplaysAddedRemoved)
  screen.on('display-metrics-changed', () => {
    if (phase === 'idle') dropOverlays()
    broadcast('screens', null)
  })

  const pickPayload = (s: ScreenInfo, total: number, mode: 'pick' | 'identify'): Record<string, unknown> => ({
    mode,
    number: s.number,
    total,
    label: s.label,
    res: `${s.pixels.width}×${s.pixels.height}`,
    primary: s.primary,
    warning: mode === 'pick' ? (warnings[0] ?? '') : ''
  })

  async function beginFlow(): Promise<void> {
    lastError = ''
    warnings = []
    const list = getScreens()
    if (!list.length) return fail(null, 'No screens were found.')
    const m = store.getMachine()
    const def = m.defaultScreenId ? list.find((s) => s.id === m.defaultScreenId) : undefined
    if (def) {
      // a default screen skips the picker and the R step — record right away
      target = def
      return go()
    }
    if (m.defaultScreenId) warnings = ['Your default screen isn’t connected — pick one for now.']
    if (list.length === 1) return arm(list[0])
    target = null
    setPhase('picking')
    const cursor = screenUnderCursor()
    for (const s of list) {
      const w = overlayFor(s)
      await w.ready
      if (curPhase() !== 'picking') return
      w.send(`${ID}:ov`, pickPayload(s, list.length, 'pick'))
      w.show({ focus: cursor?.id === s.id })
    }
    const keys: Record<string, () => void> = { Escape: () => cancelFlow() }
    for (const s of list.slice(0, 9)) keys[String(s.number)] = () => void pickNumber(s.number)
    setTempKeys(keys)
    armFlowTimer()
  }

  async function pickNumber(n: number): Promise<void> {
    if (phase !== 'picking') return
    const s = getScreens().find((x) => x.number === n)
    if (s) await arm(s)
  }

  async function arm(s: ScreenInfo): Promise<void> {
    target = s
    setPhase('armed')
    hideOverlays(s.id)
    const w = overlayFor(s)
    await w.ready
    if (curPhase() !== 'armed' || target?.id !== s.id) return
    const { mode, frac } = areaOf(s)
    w.send(`${ID}:ov`, {
      mode: 'armed',
      number: s.number,
      label: s.label,
      area: frac,
      areaText: areaLabel(mode, frac, s.pixels),
      audio: audioSummary(),
      hotkey: hotkeyLabel(),
      warning: warnings[0] ?? ''
    })
    w.show({ focus: true })
    setTempKeys({ R: () => void go(), Escape: () => cancelFlow() })
    armFlowTimer()
  }

  function cancelFlow(): void {
    if (phase !== 'picking' && phase !== 'armed' && phase !== 'countdown') return
    clearTempKeys()
    clearFlowTimer()
    hideOverlays()
    target = null
    setPhase('idle')
  }

  /** from "armed" (R) or straight from idle with a default screen */
  async function go(): Promise<void> {
    const s = target
    if (!s || (phase !== 'armed' && phase !== 'idle')) return
    clearTempKeys()
    clearFlowTimer()
    const st = store.getSettings()
    if (st.countdown > 0) {
      setPhase('countdown')
      const { frac } = areaOf(s)
      hideOverlays(s.id)
      const w = overlayFor(s)
      await w.ready
      setTempKeys({ Escape: () => cancelFlow() })
      for (let n = st.countdown; n > 0; n--) {
        if (curPhase() !== 'countdown') return
        w.send(`${ID}:ov`, { mode: 'countdown', n, area: frac })
        if (n === st.countdown) w.show({ focus: true })
        await sleep(1000)
      }
      if (curPhase() !== 'countdown') return
      clearTempKeys()
    }
    setPhase('starting') // set before any await so a second R can't double-start
    hideOverlays()
    await sleep(220) // let the compositor drop the overlay before the first frame
    await startRecording(s)
  }

  /* --------------------------------- recorder -------------------------------- */

  let recorder: HelperWindow | null = null
  let recorderReady: Promise<HelperWindow> | null = null
  let resolveReady: (() => void) | null = null

  function ensureRecorder(): Promise<HelperWindow> {
    if (recorder?.isAlive() && recorderReady) return recorderReady
    const w = ctx.createHelperWindow({ html: recorderHtml(), bounds: { x: 0, y: 0, width: 360, height: 240 } })
    recorder = w
    const ready = new Promise<HelperWindow>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the recorder did not start in time')), 15_000)
      resolveReady = () => {
        clearTimeout(t)
        resolve(w)
      }
    })
    recorderReady = ready
    ready.catch(() => {
      if (recorder === w) resetRecorder()
    })
    w.onClosed(() => {
      if (recorder === w) {
        recorder = null
        recorderReady = null
      }
      void onRecorderGone()
    })
    return ready
  }
  function resetRecorder(): void {
    const w = recorder
    recorder = null
    recorderReady = null
    w?.close()
  }

  const waiters: { type: string; clipId: string; resolve: (e: RecEvent) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []
  function waitRec(type: string, clipId: string, ms: number): Promise<RecEvent> {
    return new Promise((resolve, reject) => {
      const w = {
        type,
        clipId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('the recorder did not answer in time'))
        }, ms)
      }
      waiters.push(w)
    })
  }
  function settle(e: RecEvent): void {
    for (const w of [...waiters]) {
      if (w.clipId !== e.clipId) continue
      const startFailed = e.type === 'error' && e.phase === 'start' && w.type === 'started'
      if (w.type !== e.type && !startFailed) continue
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      if (startFailed) w.reject(new Error(String(e.message ?? 'the recorder failed')))
      else w.resolve(e)
    }
  }
  function rejectAllWaiters(message: string): void {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error(message))
    }
  }

  /* -------------------------------- indicator ------------------------------- */

  let indicator: HelperWindow | null = null
  let indicatorTimer: ReturnType<typeof setTimeout> | null = null
  let indicatorLive = false
  const indicatorBounds = (s: ScreenInfo, w: number, hgt: number): { x: number; y: number; width: number; height: number } => ({
    x: s.bounds.x + Math.round((s.bounds.width - w) / 2),
    y: s.bounds.y + 8,
    width: w,
    height: hgt
  })
  function indicatorWin(b: { x: number; y: number; width: number; height: number }): HelperWindow {
    if (indicator?.isAlive()) {
      indicator.setBounds(b)
      return indicator
    }
    const w = ctx.createHelperWindow({ html: indicatorHtml(), bounds: b, transparent: true, alwaysOnTop: true, focusable: false, excludeFromCapture: true })
    w.onClosed(() => {
      if (indicator === w) indicator = null
    })
    indicator = w
    return w
  }
  function clearIndicatorTimer(): void {
    if (indicatorTimer) clearTimeout(indicatorTimer)
    indicatorTimer = null
  }
  function showIndicator(s: ScreenInfo, payload: { mode: 'starting' | 'recording'; startedAt?: number; hasAudio?: boolean; warning?: string }): void {
    clearIndicatorTimer()
    if (!store.getSettings().indicator) return hideIndicator()
    const size = payload.mode === 'starting' ? { w: 240, h: 48 } : payload.warning ? { w: 600, h: 74 } : { w: 340, h: 48 }
    const w = indicatorWin(indicatorBounds(s, size.w, size.h))
    indicatorLive = payload.mode === 'recording'
    void w.ready.then(() => {
      w.send(`${ID}:ind`, { ...payload, hotkey: hotkeyLabel() })
      w.show()
    })
  }
  function showMessage(s: ScreenInfo, mode: 'saved' | 'error', text: string, sub: string, ms: number): void {
    clearIndicatorTimer()
    indicatorLive = false
    const width = Math.round(Math.min(640, Math.max(320, 70 + Math.max(text.length, sub.length) * 7.1)))
    const perLine = Math.max(20, Math.floor((width - 60) / 7.1))
    const lines = Math.ceil(text.length / perLine) + (sub ? Math.ceil(sub.length / (perLine * 1.1)) : 0)
    const w = indicatorWin(indicatorBounds(s, width + 16, 42 + lines * 19))
    void w.ready.then(() => {
      w.send(`${ID}:ind`, { mode, text, sub })
      w.show()
    })
    indicatorTimer = setTimeout(() => hideIndicator(), ms)
  }
  function hideIndicator(): void {
    clearIndicatorTimer()
    indicatorLive = false
    indicator?.hide()
  }

  function fail(s: ScreenInfo | null, message: string): void {
    lastError = message
    target = null
    clearTempKeys()
    clearFlowTimer()
    hideOverlays()
    setPhase('idle')
    const where = s ?? screenUnderCursor()
    if (where) showMessage(where, 'error', message, '', 9000)
  }

  /* -------------------------------- recording ------------------------------- */

  async function startRecording(s: ScreenInfo): Promise<void> {
    setPhase('starting')
    target = s
    lastError = ''
    const st = store.getSettings()
    const m = store.getMachine()
    const { mode, frac } = areaOf(s)
    showIndicator(s, { mode: 'starting' })
    let clipId = ''
    try {
      const rec = await ensureRecorder()
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      const src = sources.find((x) => x.display_id === s.id) ?? (sources.length === 1 ? sources[0] : undefined)
      if (!src) throw new Error('Windows did not offer this screen for capture — try again or pick another screen.')
      const sess = store.ensureSession()
      mkdirSync(sess.dir, { recursive: true })
      const n = sess.clips.reduce((x, c) => Math.max(x, c.n), 0) + 1
      clipId = `c${rid()}`
      const file = join(sess.dir, `Clip ${String(n).padStart(3, '0')}.webm`)
      const fh = await openFile(file, 'w')
      const clip: Clip = {
        id: clipId,
        n,
        file,
        thumb: '',
        createdAt: Date.now(),
        durationMs: 0,
        screen: { id: s.id, number: s.number, label: s.label },
        areaMode: mode,
        crop: frac,
        width: s.pixels.width,
        height: s.pixels.height,
        fps: st.fps,
        hasAudio: false,
        audioLabel: '',
        mime: '',
        status: 'recording',
        include: true,
        bytes: 0,
        warnings: [],
        error: ''
      }
      store.addClip(clip)
      active = { clip, fh, bytes: 0, startedAt: 0, screen: s, chain: Promise.resolve(), writeError: '', lastTick: Date.now() }
      const started = waitRec('started', clipId, 20_000)
      rec.send(`${ID}:rec-cmd`, {
        cmd: 'start',
        clipId,
        sourceId: src.id,
        width: s.pixels.width,
        height: s.pixels.height,
        fps: st.fps,
        videoBitsPerSecond: videoBitrate(s.pixels, st.fps, st.quality),
        mic: m.mic,
        systemAudio: st.systemAudio,
        noiseSuppression: st.noiseSuppression,
        micGainDb: st.micGainDb
      })
      const ev = await started
      const warn = Array.isArray(ev.warnings) ? ev.warnings.map(String) : []
      const now = Date.now()
      active.startedAt = now
      active.lastTick = now
      const audioLabel = [ev.micLabel ? `Mic: ${String(ev.micLabel)}` : '', ev.systemAudio ? 'computer sound' : ''].filter(Boolean).join(' + ') || 'No audio'
      const updated = store.updateClip(clipId, {
        width: Number(ev.width) || s.pixels.width,
        height: Number(ev.height) || s.pixels.height,
        mime: String(ev.mime ?? ''),
        hasAudio: !!ev.hasAudio,
        audioLabel,
        warnings: warn
      })
      if (updated) active.clip = updated
      warnings = warn
      setPhase('recording')
      emitSession()
      showIndicator(s, { mode: 'recording', startedAt: now, hasAudio: !!ev.hasAudio, warning: warn[0] ?? '' })
    } catch (err) {
      const message = errMsg(err)
      if (active && active.clip.id === clipId) {
        const a = active
        active = null
        await a.fh.close().catch(() => undefined)
        store.removeClip(clipId)
        rmQuiet(a.clip.file)
        recorder?.send(`${ID}:rec-cmd`, { cmd: 'stop', clipId })
        emitSession()
      }
      if (/in time/i.test(message)) resetRecorder()
      fail(s, `Couldn’t start recording: ${message}`)
    }
  }

  async function finishActive(durationMs: number, note?: string): Promise<Clip | null> {
    const a = active
    if (!a) return null
    active = null
    await a.chain.catch(() => undefined)
    await a.fh.close().catch(() => undefined)
    return store.updateClip(a.clip.id, {
      durationMs: Math.max(0, Math.round(durationMs)),
      bytes: a.bytes,
      status: 'processing',
      warnings: note ? [...a.clip.warnings, note] : a.clip.warnings,
      error: a.writeError ? `Stopped early: ${a.writeError}` : ''
    })
  }

  async function stopRecording(force = false): Promise<void> {
    if (phase !== 'recording' || !active) return
    const a = active
    setPhase('stopping')
    let durationMs = Date.now() - a.startedAt
    const rec = recorder
    if (rec?.isAlive()) {
      const wait = waitRec('stopped', a.clip.id, force ? 2_500 : 20_000)
      rec.send(`${ID}:rec-cmd`, { cmd: 'stop', clipId: a.clip.id })
      try {
        const ev = await wait
        if (Number(ev.durationMs) > 0) durationMs = Number(ev.durationMs)
      } catch {
        if (!force) warnings = [...warnings, 'The recorder took too long to finish — the clip was kept up to the last saved second.']
      }
    }
    const writeError = a.writeError
    const clip = await finishActive(durationMs)
    target = null
    setPhase('idle')
    if (!clip) return
    const sess = store.getSession()
    const included = (sess?.clips ?? []).filter((c) => c.include)
    const total = included.reduce((x, c) => x + c.durationMs, 0)
    if (writeError) showMessage(a.screen, 'error', `Clip ${clip.n} stopped early: ${writeError}`, 'What was recorded so far is kept.', 9000)
    else
      showMessage(
        a.screen,
        'saved',
        `Clip ${clip.n} saved · ${fmtDuration(clip.durationMs)}`,
        `Session: ${included.length} clip${included.length === 1 ? '' : 's'} · ${fmtDuration(total)} — open ScreenRec to render`,
        3200
      )
    emitSession()
    void finalizeClip(clip.id)
  }

  async function onRecorderGone(): Promise<void> {
    rejectAllWaiters('the recorder closed')
    if (!active) return
    const a = active
    const clip = await finishActive(Date.now() - (a.startedAt || Date.now()), 'The recorder closed while recording — the clip was kept up to the last saved second.')
    target = null
    setPhase('idle')
    if (clip) {
      emitSession()
      void finalizeClip(clip.id)
    }
  }

  // watchdog: the recorder page ticks every 2 s while recording
  setInterval(() => {
    if (phase === 'recording' && active && Date.now() - active.lastTick > 12_000) {
      warnings = ['The recorder stopped responding — the clip was kept up to the last saved second.']
      void stopRecording(true)
    }
  }, 3_000)

  /* ------------------------------ clip finishing ----------------------------- */

  let finalizeChain: Promise<void> = Promise.resolve()
  function finalizeClip(id: string): Promise<void> {
    finalizeChain = finalizeChain.then(() => finalizeNow(id)).catch(() => undefined)
    return finalizeChain
  }
  async function finalizeNow(id: string): Promise<void> {
    try {
      const c0 = store.getSession()?.clips.find((c) => c.id === id)
      if (!c0) return
      let file = c0.file
      // MediaRecorder WebM has no duration/cues — a stream-copy remux to MKV
      // makes it seekable and measurable (no re-encode, seconds even for long clips)
      if (/\.webm$/i.test(file) && existsSync(file)) {
        const mkv = file.replace(/\.webm$/i, '.mkv')
        try {
          await runFfmpeg(['-i', file, '-map', '0', '-c', 'copy', mkv])
          const p = await probeMedia(mkv)
          if (p.hasVideo) {
            rmQuiet(file)
            file = mkv
          } else rmQuiet(mkv)
        } catch {
          rmQuiet(mkv)
        }
      }
      if (!existsSync(file)) {
        store.updateClip(id, { status: 'failed', error: 'The recording file is missing.' })
        return
      }
      let probe: Awaited<ReturnType<typeof probeMedia>> | null = null
      try {
        probe = await probeMedia(file)
      } catch {
        probe = null
      }
      let durationMs = c0.durationMs
      if (!(durationMs > 200)) {
        const d = probe?.durationSec ?? (await decodeDuration(file))
        durationMs = d ? Math.round(d * 1000) : 0
      }
      const thumb = file.replace(/\.(webm|mkv)$/i, '.jpg')
      try {
        await runFfmpeg(thumbArgs(file, c0.crop, Math.min(1, durationMs / 2000), thumb))
      } catch {
        await runFfmpeg(thumbArgs(file, c0.crop, 0, thumb)).catch(() => undefined)
      }
      const ok = !!probe?.hasVideo && durationMs > 0
      store.updateClip(id, {
        file,
        thumb: existsSync(thumb) ? thumb : '',
        durationMs,
        hasAudio: probe ? probe.hasAudio : c0.hasAudio,
        bytes: sizeOf(file),
        status: ok ? 'ready' : 'failed',
        error: ok ? c0.error : probe ? 'The recording has no video.' : 'The recording could not be read.'
      })
    } catch (err) {
      store.updateClip(id, { status: 'failed', error: errMsg(err) })
    } finally {
      emitSession()
    }
  }

  /* --------------------------------- render --------------------------------- */

  let job: RenderJob | null = null
  let jobAbort: AbortController | null = null
  const jobRunning = (): boolean => !!job && (job.phase === 'preparing' || job.phase === 'clips' || job.phase === 'mixing')
  const emitJob = (): void => broadcast('render', job)

  const uniquePath = (p: string): string => {
    if (!existsSync(p)) return p
    const ext = extname(p)
    const base = p.slice(0, -ext.length)
    for (let i = 2; i < 1000; i++) {
      const c = `${base} (${i})${ext}`
      if (!existsSync(c)) return c
    }
    return `${base} ${rid()}${ext}`
  }

  async function runJob(j: RenderJob, clips: Clip[], prefs: RenderPrefs, sess: Session, signal: AbortSignal): Promise<void> {
    const atStart = new Set(sess.clips.map((c) => c.id))
    let lastEmit = 0
    try {
      const res = await renderSession({
        clips,
        prefs,
        outFile: j.output,
        workDir: join(sess.dir, '.render-temp'),
        signal,
        onProgress: (p) => {
          j.phase = p.phase
          j.progress = p.progress
          j.clipIndex = p.clipIndex
          j.message = p.message
          const elapsed = (Date.now() - j.startedAt) / 1000
          j.etaSec = p.progress > 0.02 ? Math.max(0, Math.round((elapsed / p.progress) * (1 - p.progress))) : null
          if (Date.now() - lastEmit > 250) {
            lastEmit = Date.now()
            emitJob()
          }
        }
      })
      j.phase = 'done'
      j.progress = 1
      j.etaSec = 0
      j.message = 'Your video is ready'
      store.addHistory({
        id: rid(),
        file: j.output,
        createdAt: Date.now(),
        durationSec: res.durationSec,
        clipCount: clips.length,
        bytes: res.bytes,
        music: prefs.musicPath ? basename(prefs.musicPath) : '',
        rawDir: sess.dir,
        rawDeleted: prefs.deleteRawAfter
      })
      if (prefs.deleteRawAfter) {
        for (const c of clips) {
          rmQuiet(c.file)
          if (c.thumb) rmQuiet(c.thumb)
        }
        try {
          if (existsSync(sess.dir) && readdirSync(sess.dir).length === 0) rmdirSync(sess.dir)
        } catch {
          /* leave it */
        }
      }
      // complete the session; anything recorded while rendering starts the next one
      const carry = (store.getSession()?.clips ?? []).filter((c) => !atStart.has(c.id))
      store.closeSession(carry)
      emitSession()
    } catch (err) {
      if (signal.aborted) {
        j.phase = 'cancelled'
        j.message = 'Render cancelled — your clips are untouched'
      } else {
        j.phase = 'failed'
        j.error = errMsg(err)
        j.message = 'Render failed — your clips are untouched'
      }
    } finally {
      jobAbort = null
      emitJob()
    }
  }

  /* --------------------------------- music --------------------------------- */

  async function musicInfo(p: string): Promise<MusicInfo> {
    const exists = !!p && existsSync(p)
    let durationSec: number | null = null
    if (exists) {
      try {
        durationSec = (await probeMedia(p)).durationSec
      } catch {
        durationSec = null
      }
    }
    return { path: p, name: p ? basename(p) : '', durationSec, exists }
  }

  const parentWin = (): BrowserWindow | null => BrowserWindow.getFocusedWindow() ?? ctx.getMainWindow()

  /* -------------------------------- handlers -------------------------------- */

  // helper-window channels (only the recorder / overlays / indicator may call these)
  h.handle(`${ID}:rec-ready`, (e) => {
    if (recorder && e.sender.id === recorder.id) resolveReady?.()
    return { ok: true }
  })
  h.handle(`${ID}:rec-event`, (e, raw: unknown) => {
    if (!recorder || e.sender.id !== recorder.id) return { ok: false }
    const ev = (raw && typeof raw === 'object' ? raw : { type: '' }) as RecEvent
    const a = active
    const mine = !!a && ev.clipId === a.clip.id
    if (ev.type === 'level') {
      if (mine && indicatorLive) indicator?.send(`${ID}:ind`, { mode: 'level', value: Number(ev.value) || 0 })
      return { ok: true }
    }
    if (ev.type === 'tick' && mine && a) a.lastTick = Date.now()
    if (ev.type === 'ended' && mine && phase === 'recording') {
      warnings = ['The screen stopped sending video (disconnected or locked?) — the clip was saved.']
      void stopRecording()
    }
    if (ev.type === 'error' && ev.phase !== 'start' && mine && phase === 'recording') {
      lastError = String(ev.message ?? 'Recorder error')
      void stopRecording()
    }
    settle(ev)
    return { ok: true }
  })
  h.handle(`${ID}:rec-chunk`, async (e, raw: unknown) => {
    if (!recorder || e.sender.id !== recorder.id) return { ok: false, error: 'not the recorder' }
    const p = (raw && typeof raw === 'object' ? raw : {}) as { clipId?: string; data?: unknown }
    const a = active
    if (!a || p.clipId !== a.clip.id) return { ok: false, error: 'no clip is recording' }
    if (a.writeError) return { ok: false, error: a.writeError }
    if (!ArrayBuffer.isView(p.data)) return { ok: false, error: 'bad data' }
    const view = p.data as Uint8Array
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
    a.lastTick = Date.now()
    a.chain = a.chain.then(async () => {
      await a.fh.write(buf)
      a.bytes += buf.length
    })
    try {
      await a.chain
      return { ok: true }
    } catch (err) {
      a.writeError = /ENOSPC/i.test(errMsg(err)) ? 'the disk is full' : errMsg(err)
      if (phase === 'recording') void stopRecording()
      return { ok: false, error: a.writeError }
    }
  })
  h.handle(`${ID}:ov-action`, (e, raw: unknown) => {
    const entry = [...overlays.entries()].find(([, w]) => w.id === e.sender.id)
    if (!entry) return { ok: false }
    const sid = entry[0]
    const a = (raw && typeof raw === 'object' ? raw : {}) as { action?: string; n?: number }
    if (a.action === 'select' && phase === 'picking') {
      const s = getScreens().find((x) => x.id === sid)
      if (s) void arm(s)
    } else if (a.action === 'key' && phase === 'picking') void pickNumber(Number(a.n))
    else if (a.action === 'start' && phase === 'armed' && target?.id === sid) void go()
    else if (a.action === 'cancel') cancelFlow()
    return { ok: true }
  })
  h.handle(`${ID}:ind-action`, (e, action: unknown) => {
    if (!indicator || e.sender.id !== indicator.id) return { ok: false }
    if (action === 'stop') void stopRecording()
    return { ok: true }
  })

  // UI / MCP channels
  h.handle(`${ID}:status`, () => ({ state: stateView(), session: sessionView(), job, ...settingsView() }))
  h.handle(`${ID}:state`, () => stateView())

  h.handle(`${ID}:record-toggle`, () => {
    onHotkey()
    return stateView()
  })
  h.handle(`${ID}:record-stop`, async () => {
    if (phase === 'recording') await stopRecording()
    else cancelFlow()
    return stateView()
  })

  h.handle(`${ID}:screens`, () => {
    const list = getScreens()
    const areas: Record<string, { mode: AreaMode; frac: Frac; text: string }> = {}
    for (const s of list) {
      const a = areaOf(s)
      areas[s.id] = { ...a, text: areaLabel(a.mode, a.frac, s.pixels) }
    }
    return { screens: list, defaultScreenId: store.getMachine().defaultScreenId, areas }
  })
  h.handle(`${ID}:identify`, async () => {
    if (phase !== 'idle') return { ok: false, error: 'Busy recording' }
    const list = getScreens()
    for (const s of list) {
      const w = overlayFor(s)
      await w.ready
      w.send(`${ID}:ov`, pickPayload(s, list.length, 'identify'))
      w.show()
    }
    setTimeout(() => {
      if (phase === 'idle') hideOverlays()
    }, 2500)
    return { ok: true }
  })
  h.handle(`${ID}:screen-thumb`, async (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { screenId?: string; width?: number }
    const s = getScreens().find((x) => x.id === String(r.screenId))
    if (!s) return { ok: false, error: 'That screen is not connected' }
    const width = Math.min(1600, Math.max(160, Math.round(Number(r.width) || 960)))
    const height = Math.round((width * s.pixels.height) / Math.max(1, s.pixels.width))
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
      const src = sources.find((x) => x.display_id === s.id) ?? (sources.length === 1 ? sources[0] : undefined)
      if (!src) return { ok: false, error: 'Windows did not offer this screen' }
      return { ok: true, dataUrl: `data:image/jpeg;base64,${src.thumbnail.toJPEG(82).toString('base64')}` }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  h.handle(`${ID}:settings`, () => settingsView())
  h.handle(`${ID}:settings-set`, (_e, raw: unknown) => {
    const before = store.getSettings()
    const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
    const next = sanitizeSettings({ ...before, ...p, render: p.render ? { ...before.render, ...p.render } : before.render }, before)
    const hotkeyChanged = next.hotkey !== before.hotkey || next.hotkeyEnabled !== before.hotkeyEnabled
    if (hotkeyChanged && next.hotkeyEnabled) {
      // try the new combination before committing it
      if (hotkey.registered) ctx.unregisterGlobalShortcut(hotkey.accelerator)
      hotkey = { ...hotkey, registered: false }
      const r = ctx.registerGlobalShortcut(next.hotkey, onHotkey)
      if (!r.ok) {
        applyHotkey() // put the previous one back
        return { ok: false, error: r.error, ...settingsView() }
      }
      ctx.unregisterGlobalShortcut(next.hotkey)
    }
    store.setSettings(next)
    if (hotkeyChanged) applyHotkey()
    emitSettings()
    return { ok: true, ...settingsView() }
  })
  // while Settings captures a new combination, the current one must not
  // swallow the key press — suspend it (auto-resumes after 60 s)
  let suspendTimer: ReturnType<typeof setTimeout> | null = null
  h.handle(`${ID}:hotkey-suspend`, (_e, on: unknown) => {
    if (suspendTimer) clearTimeout(suspendTimer)
    suspendTimer = null
    if (on && phase === 'idle') {
      if (hotkey.registered) ctx.unregisterGlobalShortcut(hotkey.accelerator)
      hotkey = { ...hotkey, registered: false }
      suspendTimer = setTimeout(() => applyHotkey(), 60_000)
      emitState()
    } else if (!on) applyHotkey()
    return hotkey
  })
  h.handle(`${ID}:hotkey-retry`, () => {
    applyHotkey()
    emitSettings()
    return settingsView()
  })
  h.handle(`${ID}:machine-set`, (_e, raw: unknown) => {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if ('defaultScreenId' in p) patch.defaultScreenId = p.defaultScreenId
    if ('mic' in p) patch.mic = p.mic
    if ('customAreas' in p) patch.customAreas = p.customAreas
    store.setMachine(patch)
    emitSettings()
    return settingsView()
  })
  h.handle(`${ID}:choose-dir`, async (_e, which: unknown) => {
    const key = which === 'output' ? 'outputDir' : 'rawDir'
    const current = key === 'outputDir' ? store.outputDir() : store.rawDir()
    const win = parentWin()
    const opts = { title: key === 'outputDir' ? 'Where finished videos go' : 'Where raw clips are kept', defaultPath: current, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return settingsView()
    store.setSettings({ [key]: r.filePaths[0] } as Partial<Settings>)
    emitSettings()
    return settingsView()
  })
  h.handle(`${ID}:reset-dir`, (_e, which: unknown) => {
    store.setSettings({ [which === 'output' ? 'outputDir' : 'rawDir']: '' } as Partial<Settings>)
    emitSettings()
    return settingsView()
  })
  h.handle(`${ID}:open-folder`, async (_e, which: unknown) => {
    const dir = which === 'output' ? store.outputDir() : which === 'session' ? (store.getSession()?.dir ?? store.rawDir()) : store.rawDir()
    mkdirSync(dir, { recursive: true })
    const err = await ctx.shell.openPath(dir)
    return err ? { ok: false, error: err } : { ok: true }
  })

  // session
  h.handle(`${ID}:session`, () => sessionView())
  h.handle(`${ID}:clip-thumb`, (_e, id: unknown) => {
    const c = store.getSession()?.clips.find((x) => x.id === id)
    if (!c?.thumb || !existsSync(c.thumb)) return { ok: false }
    return { ok: true, dataUrl: `data:image/jpeg;base64,${readFileSync(c.thumb).toString('base64')}` }
  })
  h.handle(`${ID}:clip-remove`, (_e, id: unknown) => {
    if (active?.clip.id === id) return { ok: false, error: 'That clip is still recording.' }
    if (jobRunning()) return { ok: false, error: 'Wait for the render to finish.' }
    const c = store.removeClip(String(id))
    if (c) {
      rmQuiet(c.file)
      rmQuiet(c.file.replace(/\.mkv$/i, '.webm'))
      if (c.thumb) rmQuiet(c.thumb)
    }
    emitSession()
    return { ok: true }
  })
  h.handle(`${ID}:clip-move`, (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { id?: string; delta?: number }
    if (jobRunning()) return { ok: false, error: 'Wait for the render to finish.' }
    store.moveClip(String(r.id), Number(r.delta) < 0 ? -1 : 1)
    emitSession()
    return { ok: true }
  })
  h.handle(`${ID}:clip-include`, (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { id?: string; include?: boolean }
    store.updateClip(String(r.id), { include: !!r.include })
    emitSession()
    return { ok: true }
  })
  h.handle(`${ID}:clip-open`, async (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { id?: string; reveal?: boolean }
    const c = store.getSession()?.clips.find((x) => x.id === r.id)
    if (!c || !existsSync(c.file)) return { ok: false, error: 'The clip file is missing.' }
    if (r.reveal) {
      ctx.shell.showItemInFolder(c.file)
      return { ok: true }
    }
    const err = await ctx.shell.openPath(c.file)
    return err ? { ok: false, error: err } : { ok: true }
  })
  h.handle(`${ID}:clip-retry`, async (_e, id: unknown) => {
    const c = store.getSession()?.clips.find((x) => x.id === id)
    if (!c || c.status === 'recording') return { ok: false }
    store.updateClip(c.id, { status: 'processing', error: '' })
    emitSession()
    await finalizeClip(c.id)
    return { ok: true }
  })
  h.handle(`${ID}:session-discard`, (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { deleteFiles?: boolean }
    if (active || phase === 'recording' || phase === 'starting' || phase === 'stopping') return { ok: false, error: 'Stop the recording first.' }
    if (jobRunning()) return { ok: false, error: 'Wait for the render to finish.' }
    const sess = store.getSession()
    if (sess && r.deleteFiles !== false) {
      for (const c of sess.clips) {
        rmQuiet(c.file)
        rmQuiet(c.file.replace(/\.mkv$/i, '.webm'))
        if (c.thumb) rmQuiet(c.thumb)
      }
      try {
        if (existsSync(sess.dir) && readdirSync(sess.dir).length === 0) rmdirSync(sess.dir)
      } catch {
        /* leave it */
      }
    }
    store.closeSession()
    emitSession()
    return { ok: true }
  })

  // render
  h.handle(`${ID}:render`, (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { prefs?: unknown; fileName?: unknown }
    if (jobRunning()) return { ok: false, error: 'A render is already running.' }
    const prefs = store.setSettings({ render: sanitizeRender(r.prefs ?? {}, store.getSettings().render) }).render
    emitSettings()
    const sess = store.getSession()
    const clips = (sess?.clips ?? []).filter((c) => c.include)
    if (!sess || !clips.length) return { ok: false, error: `There are no clips to render yet — press ${hotkeyLabel()} to record one.` }
    if (clips.some((c) => c.status === 'recording')) return { ok: false, error: `Stop the recording first (${hotkeyLabel()}).` }
    if (clips.some((c) => c.status === 'processing')) return { ok: false, error: 'A clip is still being prepared — try again in a few seconds.' }
    const bad = clips.find((c) => c.status === 'failed' || !existsSync(c.file))
    if (bad) return { ok: false, error: `Clip ${bad.n} can’t be used (${bad.error || 'file missing'}) — untick or remove it.` }
    if (prefs.musicPath && !existsSync(prefs.musicPath)) return { ok: false, error: `The music file isn’t on this PC: ${prefs.musicPath}` }
    const outDir = store.outputDir()
    try {
      mkdirSync(outDir, { recursive: true })
    } catch (err) {
      return { ok: false, error: `Can’t create the output folder: ${errMsg(err)}` }
    }
    const outFile = uniquePath(join(outDir, outputName(String(r.fileName ?? ''))))
    job = { id: rid(), startedAt: Date.now(), phase: 'preparing', progress: 0, clipIndex: 0, clipCount: clips.length, etaSec: null, output: outFile, message: 'Preparing…', error: '' }
    jobAbort = new AbortController()
    emitJob()
    void runJob(job, clips, prefs, sess, jobAbort.signal)
    return { ok: true, job }
  })
  h.handle(`${ID}:render-cancel`, () => {
    jobAbort?.abort()
    return { ok: true }
  })
  h.handle(`${ID}:render-status`, () => job)
  h.handle(`${ID}:render-dismiss`, () => {
    if (!jobRunning()) job = null
    emitJob()
    return { ok: true }
  })

  // music
  h.handle(`${ID}:pick-music`, async () => {
    const win = parentWin()
    const current = store.getSettings().render.musicPath
    const opts = {
      title: 'Choose a music track',
      defaultPath: current && existsSync(current) ? dirname(current) : ctx.app.getPath('music'),
      properties: ['openFile'] as 'openFile'[],
      filters: [{ name: 'Audio', extensions: AUDIO_EXT }]
    }
    const r = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    store.setSettings({ render: { ...store.getSettings().render, musicPath: r.filePaths[0] } })
    emitSettings()
    return { ok: true, info: await musicInfo(r.filePaths[0]) }
  })
  h.handle(`${ID}:music-info`, () => musicInfo(store.getSettings().render.musicPath))
  h.handle(`${ID}:music-data`, () => {
    const p = store.getSettings().render.musicPath
    const ext = extname(p).slice(1).toLowerCase()
    if (!p || !existsSync(p) || !AUDIO_EXT.includes(ext)) return { ok: false, error: 'No music file chosen' }
    if (sizeOf(p) > 60 * 1024 * 1024) return { ok: false, error: 'The file is too large to preview here' }
    return { ok: true, dataUrl: `data:${AUDIO_MIME[ext] ?? 'audio/mpeg'};base64,${readFileSync(p).toString('base64')}` }
  })

  // history
  h.handle(`${ID}:history`, () => store.getHistory().map((it: HistoryItem) => ({ ...it, exists: existsSync(it.file) })))
  h.handle(`${ID}:history-open`, async (_e, raw: unknown) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { id?: string; reveal?: boolean }
    const it = store.getHistory().find((x) => x.id === r.id)
    if (!it || !existsSync(it.file)) return { ok: false, error: 'The video is no longer there.' }
    if (r.reveal) {
      ctx.shell.showItemInFolder(it.file)
      return { ok: true }
    }
    const err = await ctx.shell.openPath(it.file)
    return err ? { ok: false, error: err } : { ok: true }
  })
  h.handle(`${ID}:history-remove`, (_e, id: unknown) => {
    store.removeHistory(String(id))
    return { ok: true }
  })
  h.handle(`${ID}:job-open`, async (_e, reveal: unknown) => {
    if (!job || job.phase !== 'done' || !existsSync(job.output)) return { ok: false }
    if (reveal) {
      ctx.shell.showItemInFolder(job.output)
      return { ok: true }
    }
    const err = await ctx.shell.openPath(job.output)
    return err ? { ok: false, error: err } : { ok: true }
  })

  h.handle(`${ID}:data-paths`, (): ModuleDataPath[] => [
    { label: 'Finished videos', path: store.outputDir(), note: 'Rendered 1920×1080 MP4s' },
    { label: 'Raw clips', path: store.rawDir(), note: 'One folder per session; not part of Backup / Cloud Sync' },
    { label: 'Settings & session', path: store.dataDir, note: 'Monitor and microphone choices are kept per PC' }
  ])

  /* --------------------------------- startup -------------------------------- */

  applyHotkey()
  // bring back clips from a session that was interrupted (crash / closed while
  // recording) — only the ones already unfinished at launch, never a clip the
  // user starts in the first seconds
  const unfinishedAtLaunch = (store.getSession()?.clips ?? []).filter((c) => c.status === 'recording' || c.status === 'processing').map((c) => ({ id: c.id, wasRecording: c.status === 'recording' }))
  setTimeout(() => {
    for (const u of unfinishedAtLaunch) {
      const c = store.getSession()?.clips.find((x) => x.id === u.id)
      if (!c || active?.clip.id === c.id) continue
      if (u.wasRecording) store.updateClip(c.id, { status: 'processing', durationMs: 0, warnings: [...c.warnings, 'WICKED closed while this clip was recording — it was recovered up to the last saved second.'] })
      void finalizeClip(c.id)
    }
  }, 2_500)
  // warm the recorder so a default-screen Ctrl+R starts instantly
  setTimeout(() => {
    if (store.getSettings().hotkeyEnabled) ensureRecorder().catch(() => undefined)
  }, 6_000)
  // clean up render leftovers from a crash (never while a render is using the folder)
  const leftover = store.getSession()?.dir
  if (leftover && !jobRunning()) rmSync(join(leftover, '.render-temp'), { recursive: true, force: true })
}

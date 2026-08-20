import { create } from 'zustand'
import { useNowPlaying } from '@/stores/nowPlaying'
import type { PlayerCommand, PlayerSnapshot, Track } from './shared/types'

/**
 * The PLAYBACK ENGINE — everything here lives at ES-module scope, so it is
 * created once when the module's chunk first loads and SURVIVES route
 * changes (the React component tree unmounts when you switch tools; this
 * file's Audio element and store do not — the yt-downloader/robocopy
 * module-scope pattern). It also:
 *   - publishes track/play state into the shell's nowPlaying store, which
 *     renders the sidebar mini transport visible from every tool;
 *   - wires navigator.mediaSession so hardware media keys work (the only
 *     compliant option — modules must not register global shortcuts);
 *   - listens for `music-player:cmd` pushes (MCP control) and reports a
 *     snapshot back to main so MCP can answer "what's playing".
 *
 * NOTE: a standalone module window (/w/music-player) is a separate renderer
 * process with its own engine instance — by design, no cross-window sync.
 */

const ID = 'music-player'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

export type Repeat = 'off' | 'all' | 'one'

interface PlayerState {
  /** library root + track lookup, fed by the UI when the library loads */
  root: string
  byId: Map<string, Track>
  /** the play queue as track ids (original order) */
  queue: string[]
  /** playback order: indexes into queue — identity, or shuffled (prev() retraces it) */
  order: number[]
  /** position within `order`; -1 = nothing loaded */
  pos: number
  playing: boolean
  position: number
  duration: number
  shuffle: boolean
  repeat: Repeat
  /** 0–1, persisted per device (renderer Local Storage) */
  volume: number
  muted: boolean
  /** user-facing error, e.g. the NAS went away */
  error: string
}

const VOLUME_KEY = 'music-player.volume'

function savedVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1
  } catch {
    return 1
  }
}

export const usePlayer = create<PlayerState>(() => ({
  root: '',
  byId: new Map(),
  queue: [],
  order: [],
  pos: -1,
  playing: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off',
  volume: savedVolume(),
  muted: false,
  error: ''
}))

const audio = new Audio()
audio.preload = 'auto'
audio.volume = savedVolume()

/** consecutive load failures — cap so an unplugged NAS doesn't machine-gun the queue */
let errorStreak = 0
const MAX_ERROR_STREAK = 5

export function trackUrl(root: string, relPath: string): string {
  const sep = root.endsWith('/') || root.endsWith('\\') ? '' : '/'
  return `wkmusic://${encodeURIComponent(`${root}${sep}${relPath}`)}`
}

const currentTrack = (): Track | null => {
  const s = usePlayer.getState()
  if (s.pos < 0 || s.pos >= s.order.length) return null
  return s.byId.get(s.queue[s.order[s.pos]]) ?? null
}

function shuffledOrder(n: number, firstQueueIndex?: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  // keep the just-started track first so shuffle-on doesn't jump songs
  if (firstQueueIndex != null) {
    const at = order.indexOf(firstQueueIndex)
    if (at > 0) {
      order.splice(at, 1)
      order.unshift(firstQueueIndex)
    }
  }
  return order
}

function loadAndPlay(): void {
  const t = currentTrack()
  const { root } = usePlayer.getState()
  if (!t || !root) return
  audio.src = trackUrl(root, t.relPath)
  usePlayer.setState({ position: 0, duration: 0, error: '' })
  void audio.play().catch(() => {
    /* the 'error' listener handles real failures */
  })
}

/** Set the library context (called by the UI whenever the library loads). */
export function setLibrary(root: string, tracks: Track[]): void {
  usePlayer.setState({ root, byId: new Map(tracks.map((t) => [t.id, t])) })
}

/** Start playing `trackIds` as the queue, from `startId` (or the first). */
export function playQueue(trackIds: string[], startId?: string): void {
  const s = usePlayer.getState()
  const queue = trackIds.filter((id) => s.byId.has(id))
  if (queue.length === 0) return
  const startIdx = Math.max(0, startId ? queue.indexOf(startId) : 0)
  const order = s.shuffle ? shuffledOrder(queue.length, startIdx) : queue.map((_, i) => i)
  const pos = s.shuffle ? 0 : startIdx
  errorStreak = 0
  usePlayer.setState({ queue, order, pos })
  loadAndPlay()
}

export function toggle(): void {
  if (usePlayer.getState().pos < 0) return
  if (audio.paused) void audio.play().catch(() => undefined)
  else audio.pause()
}

export function next(auto = false): void {
  const s = usePlayer.getState()
  if (s.order.length === 0) return
  if (auto && s.repeat === 'one') {
    audio.currentTime = 0
    void audio.play().catch(() => undefined)
    return
  }
  let pos = s.pos + 1
  if (pos >= s.order.length) {
    if (s.repeat === 'all' || !auto) pos = 0 // manual Next always wraps
    else {
      audio.pause()
      usePlayer.setState({ playing: false })
      return
    }
  }
  usePlayer.setState({ pos })
  loadAndPlay()
}

export function prev(): void {
  const s = usePlayer.getState()
  if (s.order.length === 0) return
  // standard player behavior: >3s in, previous restarts the track
  if (audio.currentTime > 3) {
    audio.currentTime = 0
    return
  }
  const pos = s.pos > 0 ? s.pos - 1 : s.order.length - 1
  usePlayer.setState({ pos })
  loadAndPlay()
}

export function seek(seconds: number): void {
  // setting currentTime before metadata arrives throws/drops — guard it
  if (!Number.isFinite(audio.duration)) return
  audio.currentTime = Math.max(0, Math.min(audio.duration, seconds))
}

export function setShuffle(on: boolean): void {
  const s = usePlayer.getState()
  const curQueueIdx = s.pos >= 0 ? s.order[s.pos] : undefined
  const order = on ? shuffledOrder(s.queue.length, curQueueIdx) : s.queue.map((_, i) => i)
  const pos = s.pos < 0 ? s.pos : on ? 0 : (curQueueIdx ?? 0)
  usePlayer.setState({ shuffle: on, order, pos })
}

export function setRepeat(mode: Repeat): void {
  usePlayer.setState({ repeat: mode })
}

export function setVolume(v: number): void {
  const vol = Math.max(0, Math.min(1, v))
  audio.volume = vol
  if (vol > 0 && audio.muted) audio.muted = false
  try {
    localStorage.setItem(VOLUME_KEY, String(vol))
  } catch {
    /* private-mode etc. — volume just won't persist */
  }
  usePlayer.setState({ volume: vol, muted: audio.muted })
}

/** Mute keeps the slider position — unmute restores the previous loudness. */
export function toggleMute(): void {
  audio.muted = !audio.muted
  usePlayer.setState({ muted: audio.muted })
}

/* ------------------------- audio element wiring --------------------------- */

audio.addEventListener('timeupdate', () => usePlayer.setState({ position: audio.currentTime }))
audio.addEventListener('durationchange', () => {
  if (Number.isFinite(audio.duration)) usePlayer.setState({ duration: audio.duration })
})
audio.addEventListener('play', () => {
  errorStreak = 0
  usePlayer.setState({ playing: true, error: '' })
})
audio.addEventListener('pause', () => usePlayer.setState({ playing: false }))
audio.addEventListener('ended', () => next(true))
audio.addEventListener('error', () => {
  errorStreak++
  if (errorStreak >= MAX_ERROR_STREAK) {
    audio.pause()
    usePlayer.setState({
      playing: false,
      error: 'Several tracks in a row failed to load — is the music folder still reachable?'
    })
    return
  }
  next(true) // skip the unreadable file
})

/* --------------------- shell mini bar + media session --------------------- */

function publishToShell(): void {
  const s = usePlayer.getState()
  const t = currentTrack()
  const np = useNowPlaying.getState()
  if (!t) {
    np.clear()
    return
  }
  np.publish(
    {
      title: t.title,
      artist: t.artist,
      artUrl: t.art && s.root ? trackUrl(s.root, t.art) : null,
      route: '/m/music-player'
    },
    s.playing,
    { toggle, next: () => next(), prev }
  )
}

function updateMediaSession(): void {
  if (!('mediaSession' in navigator)) return
  const s = usePlayer.getState()
  const t = currentTrack()
  try {
    navigator.mediaSession.playbackState = t ? (s.playing ? 'playing' : 'paused') : 'none'
    if (t) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        // artwork over the custom scheme is cosmetic — degrade silently
        ...(t.art && s.root ? { artwork: [{ src: trackUrl(s.root, t.art) }] } : {})
      })
    }
  } catch {
    /* metadata is cosmetic */
  }
}

if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => toggle())
    navigator.mediaSession.setActionHandler('pause', () => toggle())
    navigator.mediaSession.setActionHandler('previoustrack', () => prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
  } catch {
    /* older runtimes — media keys just won't work */
  }
}

/* -------------------- MCP bridge (commands + snapshot) -------------------- */

window.wicked.on(`${ID}:cmd`, (raw) => {
  const cmd = raw as PlayerCommand
  if (cmd === 'toggle') toggle()
  else if (cmd === 'play' && audio.paused) toggle()
  else if (cmd === 'pause' && !audio.paused) toggle()
  else if (cmd === 'next') next()
  else if (cmd === 'prev') prev()
})

let lastReport = 0
function reportToMain(force: boolean): void {
  const now = Date.now()
  if (!force && now - lastReport < 5000) return
  lastReport = now
  const s = usePlayer.getState()
  const t = currentTrack()
  const snap: PlayerSnapshot = {
    playing: s.playing,
    trackId: t?.id ?? null,
    title: t?.title ?? '',
    artist: t?.artist ?? '',
    position: Math.round(s.position),
    duration: Math.round(s.duration),
    shuffle: s.shuffle,
    repeat: s.repeat,
    queueLength: s.queue.length
  }
  void invoke('report-state', snap).catch(() => undefined)
}

/* One subscription drives the shell bar, media session and MCP snapshot.
 * Position ticks only refresh the throttled MCP report — never the shell
 * store (the sidebar must not re-render 4x/second). */
let lastKey = ''
usePlayer.subscribe((s) => {
  const key = `${s.pos}|${s.playing}|${s.queue[s.order[s.pos] ?? -1] ?? ''}|${s.shuffle}|${s.repeat}`
  if (key !== lastKey) {
    lastKey = key
    publishToShell()
    updateMediaSession()
    reportToMain(true)
  } else {
    reportToMain(false)
  }
})

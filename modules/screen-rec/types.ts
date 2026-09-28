/**
 * ScreenRec — shared types (main + renderer). Type-only.
 */

export type AreaMode = 'workarea' | 'full' | 'custom'
export type Fps = 30 | 60
export type RecQuality = 'standard' | 'high'
export type FitMode = 'fit' | 'fill'
export type RenderQuality = 'standard' | 'high' | 'max'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A rectangle as fractions (0–1) of a screen / captured frame. */
export interface Frac {
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenInfo {
  /** Electron display id, as a string */
  id: string
  /** 1-based, left→right then top→bottom — the number shown on the overlays */
  number: number
  label: string
  /** DIP */
  bounds: Rect
  /** DIP — the screen minus the taskbar */
  workArea: Rect
  scaleFactor: number
  /** physical pixels */
  pixels: { width: number; height: number }
  primary: boolean
}

/** deviceId 'default' = the Windows default microphone */
export interface MicChoice {
  deviceId: string
  label: string
}

export interface RenderPrefs {
  fps: Fps
  fit: FitMode
  quality: RenderQuality
  /** '' = no music */
  musicPath: string
  /** music level in dB relative to the file (the "preset" you keep) */
  musicDb: number
  musicLoop: boolean
  musicFade: boolean
  /** lower the music automatically while you talk */
  musicDuck: boolean
  /** voice/computer-sound level change in dB */
  voiceDb: number
  deleteRawAfter: boolean
}

/** Settings that make sense on every PC (synced with WICKED module data). */
export interface Settings {
  /** Electron accelerator, e.g. CommandOrControl+R */
  hotkey: string
  hotkeyEnabled: boolean
  areaMode: AreaMode
  /** keep a custom area at 16:9 so the final video has no bars */
  lock169: boolean
  fps: Fps
  quality: RecQuality
  countdown: 0 | 3 | 5
  /** small REC pill at the top of the recorded screen (hidden from the video) */
  indicator: boolean
  systemAudio: boolean
  noiseSuppression: boolean
  micGainDb: number
  /** '' = <Videos>/ScreenRec/Raw clips */
  rawDir: string
  /** '' = <Videos>/ScreenRec */
  outputDir: string
  render: RenderPrefs
}

/** Settings tied to this PC's hardware (monitor ids, mic ids). */
export interface MachineSettings {
  /** '' = ask every time (Ctrl+R shows the screen picker) */
  defaultScreenId: string
  /** null = record without a microphone */
  mic: MicChoice | null
  /** custom capture area per screen id */
  customAreas: Record<string, Frac>
}

export type ClipStatus = 'recording' | 'processing' | 'ready' | 'failed'

export interface Clip {
  id: string
  /** 1-based creation number within the session ("Clip 3") */
  n: number
  file: string
  thumb: string
  createdAt: number
  durationMs: number
  screen: { id: string; number: number; label: string }
  areaMode: AreaMode
  /** crop of the captured frame, as fractions */
  crop: Frac
  /** captured frame size in pixels */
  width: number
  height: number
  fps: Fps
  hasAudio: boolean
  /** e.g. "Shure MV7 + computer sound" */
  audioLabel: string
  mime: string
  status: ClipStatus
  include: boolean
  bytes: number
  warnings: string[]
  error: string
}

export interface Session {
  id: string
  createdAt: number
  /** folder holding this session's raw clips */
  dir: string
  clips: Clip[]
}

export type ClipView = Clip & { exists: boolean }
export interface SessionView extends Omit<Session, 'clips'> {
  clips: ClipView[]
  totalMs: number
  includedMs: number
}

export interface HistoryItem {
  id: string
  file: string
  createdAt: number
  durationSec: number
  clipCount: number
  bytes: number
  music: string
  rawDir: string
  rawDeleted: boolean
}

export type Phase = 'idle' | 'picking' | 'armed' | 'countdown' | 'starting' | 'recording' | 'stopping'

export interface HotkeyStatus {
  accelerator: string
  enabled: boolean
  registered: boolean
  error: string
}

export interface RecState {
  phase: Phase
  screen: ScreenInfo | null
  clipId: string | null
  /** epoch ms when the current clip started */
  startedAt: number | null
  warnings: string[]
  lastError: string
  hotkey: HotkeyStatus
}

export type RenderPhase = 'preparing' | 'clips' | 'mixing' | 'done' | 'failed' | 'cancelled'

export interface RenderJob {
  id: string
  startedAt: number
  phase: RenderPhase
  /** 0–1 */
  progress: number
  clipIndex: number
  clipCount: number
  etaSec: number | null
  output: string
  message: string
  error: string
}

export interface MusicInfo {
  path: string
  name: string
  durationSec: number | null
  exists: boolean
}

export interface Paths {
  rawDir: string
  outputDir: string
  dataDir: string
}

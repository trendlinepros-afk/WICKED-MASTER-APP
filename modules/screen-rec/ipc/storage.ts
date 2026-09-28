/**
 * ScreenRec persistence under userData/modules/screen-rec/:
 *   settings.json            — portable preferences (travel with Backup / Cloud Sync)
 *   machine-<pc>.json        — this PC's monitor + microphone choices (ids are PC-specific)
 *   session-<pc>.json        — the open session's clip list (clips live in the raw folder)
 *   history-<pc>.json        — videos rendered on this PC
 * Per-PC file names mean a sync from another computer never clobbers this
 * one's devices or session.
 */
import type { App } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import type { Clip, Frac, HistoryItem, MachineSettings, RenderPrefs, Session, Settings } from '../types'
import { DEFAULT_HOTKEY } from '../lib/hotkey'
import { DEFAULT_MACHINE, DEFAULT_SETTINGS } from '../lib/defaults'
import { normFrac } from '../lib/geometry'

export const ID = 'screen-rec'

export const DEFAULT_RENDER: RenderPrefs = DEFAULT_SETTINGS.render
export { DEFAULT_MACHINE, DEFAULT_SETTINGS }

const clampNum = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const oneOf = <T extends string | number>(v: unknown, list: readonly T[], dflt: T): T => (list.includes(v as T) ? (v as T) : dflt)
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
const str = (v: unknown, dflt: string, max = 1024): string => (typeof v === 'string' ? v.slice(0, max) : dflt)

export function sanitizeRender(raw: unknown, base: RenderPrefs = DEFAULT_RENDER): RenderPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    fps: oneOf(r.fps ?? base.fps, [30, 60] as const, base.fps),
    fit: oneOf(r.fit ?? base.fit, ['fit', 'fill'] as const, base.fit),
    quality: oneOf(r.quality ?? base.quality, ['standard', 'high', 'max'] as const, base.quality),
    musicPath: str(r.musicPath ?? base.musicPath, base.musicPath, 2048),
    musicDb: Math.round(clampNum(r.musicDb ?? base.musicDb, -60, 6, base.musicDb) * 2) / 2,
    musicLoop: bool(r.musicLoop, base.musicLoop),
    musicFade: bool(r.musicFade, base.musicFade),
    musicDuck: bool(r.musicDuck, base.musicDuck),
    voiceDb: Math.round(clampNum(r.voiceDb ?? base.voiceDb, -20, 20, base.voiceDb) * 2) / 2,
    deleteRawAfter: bool(r.deleteRawAfter, base.deleteRawAfter)
  }
}

export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    hotkey: str(r.hotkey ?? base.hotkey, base.hotkey, 64).trim() || DEFAULT_HOTKEY,
    hotkeyEnabled: bool(r.hotkeyEnabled, base.hotkeyEnabled),
    areaMode: oneOf(r.areaMode ?? base.areaMode, ['workarea', 'full', 'custom'] as const, base.areaMode),
    lock169: bool(r.lock169, base.lock169),
    fps: oneOf(r.fps ?? base.fps, [30, 60] as const, base.fps),
    quality: oneOf(r.quality ?? base.quality, ['standard', 'high'] as const, base.quality),
    countdown: oneOf(r.countdown ?? base.countdown, [0, 3, 5] as const, base.countdown),
    indicator: bool(r.indicator, base.indicator),
    systemAudio: bool(r.systemAudio, base.systemAudio),
    noiseSuppression: bool(r.noiseSuppression, base.noiseSuppression),
    micGainDb: Math.round(clampNum(r.micGainDb ?? base.micGainDb, -20, 20, base.micGainDb) * 2) / 2,
    rawDir: str(r.rawDir ?? base.rawDir, base.rawDir, 2048),
    outputDir: str(r.outputDir ?? base.outputDir, base.outputDir, 2048),
    render: sanitizeRender(r.render ?? base.render, base.render)
  }
}

export function sanitizeMachine(raw: unknown, base: MachineSettings = DEFAULT_MACHINE): MachineSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  let mic: MachineSettings['mic'] = base.mic
  if ('mic' in r) {
    const m = r.mic as { deviceId?: unknown; label?: unknown } | null
    mic = m && typeof m === 'object' ? { deviceId: str(m.deviceId, 'default', 512) || 'default', label: str(m.label, '', 256) } : null
  }
  const areas: Record<string, Frac> = {}
  const rawAreas = (r.customAreas ?? base.customAreas) as Record<string, Frac> | undefined
  if (rawAreas && typeof rawAreas === 'object') {
    for (const [k, v] of Object.entries(rawAreas).slice(0, 32)) {
      if (v && typeof v === 'object') areas[String(k).slice(0, 64)] = normFrac(v)
    }
  }
  return { defaultScreenId: str(r.defaultScreenId ?? base.defaultScreenId, base.defaultScreenId, 64), mic, customAreas: areas }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

const stamp = (d = new Date()): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export type Storage = ReturnType<typeof createStorage>

export function createStorage(app: App) {
  const dataDir = join(app.getPath('userData'), 'modules', ID)
  mkdirSync(dataDir, { recursive: true })
  const pc = hostname().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'pc'
  const files = {
    settings: join(dataDir, 'settings.json'),
    machine: join(dataDir, `machine-${pc}.json`),
    session: join(dataDir, `session-${pc}.json`),
    history: join(dataDir, `history-${pc}.json`)
  }
  const videos = ((): string => {
    try {
      return app.getPath('videos')
    } catch {
      return join(app.getPath('home'), 'Videos')
    }
  })()

  let settings = sanitizeSettings(readJson(files.settings, {}))
  let machine = sanitizeMachine(readJson(files.machine, {}))
  let session: Session | null = readJson<Session | null>(files.session, null)
  if (session && !Array.isArray(session.clips)) session = null
  let history = readJson<HistoryItem[]>(files.history, [])
  if (!Array.isArray(history)) history = []

  const rawDir = (): string => settings.rawDir || join(videos, 'ScreenRec', 'Raw clips')
  const outputDir = (): string => settings.outputDir || join(videos, 'ScreenRec')

  const saveSession = (): void => writeJson(files.session, session)

  return {
    dataDir,
    pc,
    rawDir,
    outputDir,
    getSettings: (): Settings => settings,
    setSettings: (patch: Partial<Settings>): Settings => {
      const merged = { ...settings, ...patch, render: patch.render ? { ...settings.render, ...patch.render } : settings.render }
      settings = sanitizeSettings(merged, settings)
      writeJson(files.settings, settings)
      return settings
    },
    getMachine: (): MachineSettings => machine,
    setMachine: (patch: Partial<MachineSettings>): MachineSettings => {
      machine = sanitizeMachine({ ...machine, ...patch }, machine)
      writeJson(files.machine, machine)
      return machine
    },
    /** the open session (null until the first clip) */
    getSession: (): Session | null => session,
    ensureSession: (): Session => {
      if (!session) {
        const id = stamp()
        session = { id, createdAt: Date.now(), dir: join(rawDir(), `Session ${id}`), clips: [] }
        saveSession()
      }
      return session
    },
    addClip: (clip: Clip): void => {
      if (!session) throw new Error('No session')
      session.clips.push(clip)
      saveSession()
    },
    /** read-modify-write one clip; returns the updated clip or null when it was removed meanwhile */
    updateClip: (id: string, patch: Partial<Clip>): Clip | null => {
      const c = session?.clips.find((x) => x.id === id)
      if (!c) return null
      Object.assign(c, patch)
      saveSession()
      return c
    },
    removeClip: (id: string): Clip | null => {
      if (!session) return null
      const i = session.clips.findIndex((x) => x.id === id)
      if (i < 0) return null
      const [c] = session.clips.splice(i, 1)
      saveSession()
      return c
    },
    moveClip: (id: string, delta: number): void => {
      if (!session) return
      const i = session.clips.findIndex((x) => x.id === id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= session.clips.length) return
      const [c] = session.clips.splice(i, 1)
      session.clips.splice(j, 0, c)
      saveSession()
    },
    /** close the session (after a render or a discard) — the next clip starts a new one */
    closeSession: (carry: Clip[] = []): void => {
      if (carry.length) {
        const id = stamp()
        session = { id, createdAt: Date.now(), dir: join(rawDir(), `Session ${id}`), clips: carry }
      } else session = null
      saveSession()
    },
    getHistory: (): HistoryItem[] => history,
    addHistory: (item: HistoryItem): void => {
      history = [item, ...history].slice(0, 500)
      writeJson(files.history, history)
    },
    removeHistory: (id: string): HistoryItem | null => {
      const it = history.find((h) => h.id === id) ?? null
      history = history.filter((h) => h.id !== id)
      writeJson(files.history, history)
      return it
    }
  }
}

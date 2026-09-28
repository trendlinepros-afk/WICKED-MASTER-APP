/**
 * Renderer-safe defaults (the main process owns the real values; these only
 * fill the store until the first status reply). Kept in sync with
 * ipc/storage.ts, which re-exports nothing Electron-specific from here.
 */
import type { MachineSettings, Settings } from '../types'
import { DEFAULT_HOTKEY } from './hotkey'

export const DEFAULT_SETTINGS: Settings = {
  hotkey: DEFAULT_HOTKEY,
  hotkeyEnabled: true,
  areaMode: 'workarea',
  lock169: true,
  fps: 30,
  quality: 'high',
  countdown: 0,
  indicator: true,
  systemAudio: false,
  noiseSuppression: false,
  micGainDb: 0,
  rawDir: '',
  outputDir: '',
  render: { fps: 30, fit: 'fit', quality: 'high', musicPath: '', musicDb: -20, musicLoop: true, musicFade: true, musicDuck: false, voiceDb: 0, deleteRawAfter: false }
}

export const DEFAULT_MACHINE: MachineSettings = {
  defaultScreenId: '',
  mic: { deviceId: 'default', label: 'Windows default microphone' },
  customAreas: {}
}

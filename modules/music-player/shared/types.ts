/** Shared types for the Music Player — used by main (ipc), the renderer and mcp. */

export interface Track {
  /** stable id = sha1 of the forward-slash relPath, first 16 hex chars */
  id: string
  /** top-level folder name under the library root */
  artist: string
  /** cleaned display title (filename minus extension/numbering/YouTube id) */
  title: string
  /** path relative to the library root, ALWAYS forward slashes */
  relPath: string
  /** cover image relative path (forward slashes) or null */
  art: string | null
}

export interface Library {
  root: string
  tracks: Track[]
  scannedUtc: string
  /** true when the scan hit the file/depth caps — the library is incomplete */
  truncated: boolean
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
}

export interface ScanProgress {
  dirs: number
  files: number
  done?: boolean
}

/** Snapshot the renderer engine reports to main so MCP can answer questions. */
export interface PlayerSnapshot {
  playing: boolean
  trackId: string | null
  title: string
  artist: string
  position: number
  duration: number
  shuffle: boolean
  repeat: 'off' | 'all' | 'one'
  queueLength: number
}

export type PlayerCommand = 'play' | 'pause' | 'toggle' | 'next' | 'prev'

export const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.opus', '.ogg', '.oga', '.webm', '.flac', '.wav'] as const
export const ART_EXTS = ['.jpg', '.jpeg', '.png', '.webp'] as const

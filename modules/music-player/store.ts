import { create } from 'zustand'
import { setLibrary } from './player'
import type { Library, Playlist, ScanProgress } from './shared/types'

/**
 * Library/UI state at module scope (survives route changes — the scan keeps
 * streaming progress and the loaded library stays warm while you're in other
 * tools). Playback state lives in player.ts; this store is everything else.
 */

const ID = 'music-player'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

interface MusicState {
  root: string
  library: Library | null
  playlists: Playlist[]
  scanning: boolean
  scanProgress: ScanProgress | null
  loaded: boolean
  error: string

  init: () => Promise<void>
  pickFolder: () => Promise<void>
  rescan: () => Promise<void>
  savePlaylists: (next: Playlist[]) => Promise<void>
  setError: (e: string) => void
}

export const useMusic = create<MusicState>((set, get) => ({
  root: '',
  library: null,
  playlists: [],
  scanning: false,
  scanProgress: null,
  loaded: false,
  error: '',

  init: async () => {
    const st = (await invoke('status')) as { ok?: boolean; root?: string; scanning?: boolean }
    const lib = (await invoke('library')) as { ok?: boolean; library?: Library | null }
    const pls = (await invoke('playlists-get')) as { ok?: boolean; playlists?: Playlist[] }
    const library = lib.library ?? null
    if (library) setLibrary(library.root, library.tracks)
    set({
      root: st.root ?? '',
      scanning: st.scanning === true,
      library,
      playlists: pls.playlists ?? [],
      loaded: true
    })
    // first run with a root picked but never scanned → scan automatically
    if ((st.root ?? '') && !library && !st.scanning) void get().rescan()
  },

  pickFolder: async () => {
    const res = (await invoke('pick-folder')) as { ok?: boolean; canceled?: boolean; root?: string }
    if (res.ok && res.root) {
      set({ root: res.root })
      void get().rescan()
    }
  },

  rescan: async () => {
    if (get().scanning) return
    set({ scanning: true, scanProgress: { dirs: 0, files: 0 }, error: '' })
    const res = (await invoke('scan')) as { ok?: boolean; library?: Library; error?: string }
    if (res.ok && res.library) {
      setLibrary(res.library.root, res.library.tracks)
      set({ library: res.library, scanning: false, scanProgress: null })
    } else {
      set({ scanning: false, scanProgress: null, error: res.error ?? 'Scan failed.' })
    }
  },

  savePlaylists: async (next) => {
    set({ playlists: next }) // optimistic — the save echoes the stored list back
    const res = (await invoke('playlists-save', next)) as { ok?: boolean; playlists?: Playlist[]; error?: string }
    if (res.ok && res.playlists) set({ playlists: res.playlists })
    else if (res.error) set({ error: res.error })
  },

  setError: (e) => set({ error: e })
}))

/* Module-scope event wiring (robocopy pattern): scan progress keeps flowing
 * into the store even while the component is unmounted. */
let eventsWired = false
export function wireMusicEvents(): void {
  if (eventsWired) return
  eventsWired = true
  window.wicked.on(`${ID}:scan-progress`, (raw) => {
    const p = raw as ScanProgress
    useMusic.setState({ scanProgress: p.done ? null : p })
  })
}

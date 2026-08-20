import { create } from 'zustand'

/**
 * Shell-owned "now playing" surface. Any module that plays media can publish
 * its current track + transport callbacks here; the sidebar renders a mini
 * transport (NowPlayingBar) whenever a track is set, visible from EVERY tool.
 * The shell knows nothing about the publisher — the contract is this state.
 * Position/seek deliberately stay OUT of this store so the sidebar doesn't
 * re-render on every timeupdate tick.
 */

export interface NowPlayingTrack {
  title: string
  artist: string
  /** already-loadable URL (custom scheme ok) or null for a generic icon */
  artUrl: string | null
  /** route to open when the bar is clicked, e.g. '/m/music-player' */
  route: string
}

export interface NowPlayingControls {
  toggle: () => void
  next: () => void
  prev: () => void
}

interface NowPlayingState {
  track: NowPlayingTrack | null
  playing: boolean
  controls: NowPlayingControls | null
  publish: (track: NowPlayingTrack, playing: boolean, controls: NowPlayingControls) => void
  setPlaying: (playing: boolean) => void
  clear: () => void
}

export const useNowPlaying = create<NowPlayingState>((set) => ({
  track: null,
  playing: false,
  controls: null,
  publish: (track, playing, controls) => set({ track, playing, controls }),
  setPlaying: (playing) => set({ playing }),
  clear: () => set({ track: null, playing: false, controls: null })
}))

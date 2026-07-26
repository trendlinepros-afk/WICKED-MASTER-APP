import { create } from 'zustand'

export const ID = 'yt-downloader'

export interface QualityPreset {
  id: string
  label: string
  note: string
}

export const QUALITIES: QualityPreset[] = [
  { id: 'best', label: 'Best available', note: 'Highest video + audio, merged to MP4' },
  { id: '2160', label: '2160p (4K)', note: 'Up to 4K, falls back if unavailable' },
  { id: '1440', label: '1440p (2K)', note: 'Up to 1440p' },
  { id: '1080', label: '1080p (Full HD)', note: 'Up to 1080p' },
  { id: '720', label: '720p (HD)', note: 'Up to 720p' },
  { id: '480', label: '480p', note: 'Up to 480p' },
  { id: '360', label: '360p', note: 'Smallest video' },
  { id: 'audio', label: 'Audio only (MP3)', note: 'Extract best audio to MP3' }
]

interface Status {
  binReady: boolean
  version: string | null
  stale: boolean
  ffmpegReady: boolean
  downloadDir: string
  busy: boolean
}

export interface Probe {
  kind: 'video' | 'playlist'
  title: string
  uploader: string
  count: number
  duration: number | null
  thumbnail: string | null
  id: string
}

export interface Progress {
  index: number
  total: number
  percent: number
  speed: string
  eta: string
  title: string
}

interface Ok {
  ok: true
  [k: string]: unknown
}
interface Err {
  ok: false
  error?: string
  canceled?: boolean
  cancelled?: boolean
}
type Res = Ok | Err

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

interface State {
  status: Status | null
  ensuring: boolean

  url: string
  probing: boolean
  probe: Probe | null
  quality: string

  downloading: boolean
  progress: Progress | null
  log: string[]
  statusMsg: string
  error: string
  lastResult: string | null

  setUrl: (v: string) => void
  setQuality: (v: string) => void
  dismissError: () => void

  loadStatus: () => Promise<void>
  ensureBin: () => Promise<void>
  updateBin: () => Promise<void>
  pickFolder: () => Promise<void>
  openFolder: () => Promise<void>
  doProbe: () => Promise<void>
  download: () => Promise<void>
  cancel: () => Promise<void>
  _onProgress: (p: unknown) => void
  _onStatusMsg: (m: unknown) => void
}

export const useYt = create<State>((set, get) => ({
  status: null,
  ensuring: false,

  url: '',
  probing: false,
  probe: null,
  quality: '1080',

  downloading: false,
  progress: null,
  log: [],
  statusMsg: 'Paste a YouTube video or playlist URL to begin.',
  error: '',
  lastResult: null,

  setUrl: (v) => set({ url: v, probe: null, lastResult: null }),
  setQuality: (v) => set({ quality: v }),
  dismissError: () => set({ error: '' }),

  loadStatus: async () => {
    const res = await invoke<Res & Status>('status')
    if (res.ok) set({ status: res as unknown as Status })
  },

  ensureBin: async () => {
    if (get().ensuring) return
    set({ ensuring: true, error: '' })
    try {
      const res = await invoke('ensure')
      if (res.ok !== true) set({ error: res.error ?? 'Could not install yt-dlp.' })
      await get().loadStatus()
    } finally {
      set({ ensuring: false })
    }
  },

  updateBin: async () => {
    if (get().ensuring) return
    set({ ensuring: true, error: '', statusMsg: 'Updating yt-dlp…' })
    try {
      const res = await invoke('update')
      set({ statusMsg: res.ok ? 'yt-dlp updated to the latest release.' : 'Update failed.' })
      if (res.ok !== true) set({ error: res.error ?? 'Update failed.' })
      await get().loadStatus()
    } finally {
      set({ ensuring: false })
    }
  },

  pickFolder: async () => {
    const res = await invoke<Res & { downloadDir?: string }>('pick-folder')
    if (res.ok) await get().loadStatus()
  },

  openFolder: async () => {
    await invoke('open-folder')
  },

  doProbe: async () => {
    const url = get().url.trim()
    if (!url || get().probing) return
    set({ probing: true, error: '', probe: null, statusMsg: 'Reading URL…' })
    try {
      const res = await invoke<Res & Probe>('probe', url)
      if (res.ok !== true) {
        set({ error: (res as Err).error ?? 'Could not read that URL.', statusMsg: 'Could not read URL.' })
        return
      }
      const p = res as unknown as Probe
      set({
        probe: p,
        statusMsg: p.kind === 'playlist' ? `Playlist: ${p.count} video(s).` : 'Video ready to download.'
      })
    } finally {
      set({ probing: false })
    }
  },

  download: async () => {
    const { url, probe, quality, downloading } = get()
    if (downloading || !url.trim()) return
    set({ downloading: true, error: '', progress: null, log: [], lastResult: null, statusMsg: 'Starting download…' })
    try {
      const res = (await invoke('download', {
        url: url.trim(),
        quality,
        isPlaylist: probe?.kind === 'playlist'
      })) as Res & { warning?: boolean; completed?: number; cancelled?: boolean }
      if (res.cancelled) {
        set({ statusMsg: 'Download cancelled.', lastResult: 'cancelled' })
      } else if (res.ok === true && !res.warning) {
        set({ statusMsg: `Done — downloaded ${Number(res.completed) || ''} item(s). Saved to your downloads folder.`, lastResult: 'done' })
      } else if (res.warning) {
        set({
          statusMsg: `Finished with some skips — ${Number(res.completed) || 0} downloaded. ${(res as Err).error ?? ''}`.trim(),
          lastResult: 'warning'
        })
      } else {
        set({ error: (res as Err).error ?? 'Download failed.', statusMsg: 'Download failed.', lastResult: 'error' })
      }
    } finally {
      set({ downloading: false, progress: null })
    }
  },

  cancel: async () => {
    await invoke('cancel')
  },

  _onProgress: (raw) => {
    const p = raw as { kind?: string; note?: string } & Progress
    if (p.kind === 'note' && p.note) {
      set((s) => ({ log: [...s.log.slice(-40), p.note as string], statusMsg: p.note as string }))
    } else if (p.kind === 'progress') {
      set({ progress: { index: p.index, total: p.total, percent: p.percent, speed: p.speed, eta: p.eta, title: p.title } })
    }
  },

  _onStatusMsg: (m) => {
    if (typeof m === 'string') set({ statusMsg: m })
  }
}))

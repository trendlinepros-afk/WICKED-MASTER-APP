import { create } from 'zustand'
import { parseYtUrl } from './lib/url'

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
  {
    id: 'audio',
    label: 'Music / MP3',
    note: 'Audio only → MP3 320k with artist/album tags + cover art embedded'
  },
  {
    id: 'audio-native',
    label: 'Music / original',
    note: "Audio only in YouTube's original format (opus/m4a) — no re-encode, tags + cover art embedded"
  }
]

export const isAudioPreset = (q: string): boolean => q === 'audio' || q === 'audio-native'

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
  /** the URL was a music.youtube.com link */
  isMusic: boolean
  /** album (OLAK5uy_) / mix-radio (RD…) / regular playlist */
  playlistKind: 'album' | 'mix' | 'playlist' | 'library' | null
  /** URL carries a track AND a list → user picks which to download */
  canChooseSingle: boolean
  /** title of just the track, when canChooseSingle */
  singleTitle: string | null
}

export interface Progress {
  index: number
  total: number
  percent: number
  speed: string
  eta: string
  title: string
}

export type JobState = 'running' | 'combining' | 'done' | 'warning' | 'error' | 'cancelled'

/** One download task, rendered as a status card. Up to MAX_JOBS run at once. */
export interface DownloadJob {
  id: string
  title: string
  /** what was requested: quality label, target, combine flag */
  detail: string
  state: JobState
  progress: Progress | null
  log: string[]
  /** latest activity note while running; final status line when finished */
  message: string
  combinedInfo: { path: string; used: number; total: number } | null
  startedAt: number
}

export const MAX_JOBS = 3

export const isJobActive = (j: DownloadJob): boolean =>
  j.state === 'running' || j.state === 'combining'

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
  /** for track+list URLs: true = whole album/playlist, false = just this track */
  wholePlaylist: boolean

  /** setting: force audio-only whenever the URL is a music.youtube.com link */
  musicAudioOnly: boolean
  /** setting: which audio preset the above forces ('audio' | 'audio-native') */
  musicFormat: string
  /** setting: after a playlist video download, stitch the clips into one movie */
  combineClips: boolean
  /** true when the current URL looks like a YouTube Music link (live, no probe) */
  urlIsMusic: boolean
  /** user explicitly picked a video quality for this music URL — respect it */
  musicOverride: boolean

  /** active + recently finished downloads, newest first (each is a card) */
  jobs: DownloadJob[]
  statusMsg: string
  error: string

  setUrl: (v: string) => void
  setQuality: (v: string) => void
  setWholePlaylist: (v: boolean) => void
  setMusicAudioOnly: (v: boolean) => Promise<void>
  setMusicFormat: (v: string) => Promise<void>
  setCombineClips: (v: boolean) => Promise<void>
  clearMusicOverride: () => void
  dismissError: () => void

  loadPrefs: () => Promise<void>
  loadStatus: () => Promise<void>
  ensureBin: () => Promise<void>
  updateBin: () => Promise<void>
  pickFolder: () => Promise<void>
  openFolder: () => Promise<void>
  doProbe: () => Promise<void>
  download: () => Promise<void>
  cancel: (jobId: string) => Promise<void>
  dismissJob: (jobId: string) => void
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
  wholePlaylist: true,

  musicAudioOnly: true,
  musicFormat: 'audio',
  combineClips: false,
  urlIsMusic: false,
  musicOverride: false,

  jobs: [],
  statusMsg: 'Paste a YouTube video or playlist URL to begin.',
  error: '',

  setUrl: (v) => {
    // Detect a music link as it's typed/pasted — no network call needed — so
    // the audio-only setting visibly applies before Check or Download.
    const isMusic = parseYtUrl(v).isMusic
    const { musicAudioOnly, musicFormat, quality } = get()
    set({
      url: v,
      probe: null,
      urlIsMusic: isMusic,
      musicOverride: false, // a new URL starts fresh
      quality: isMusic && musicAudioOnly ? musicFormat : quality
    })
  },

  setQuality: (v) => {
    // Choosing a video tier for a music URL is a deliberate one-off override.
    const { urlIsMusic, musicAudioOnly } = get()
    const override = urlIsMusic && musicAudioOnly && !isAudioPreset(v)
    set({ quality: v, musicOverride: override })
  },

  setWholePlaylist: (v) => set({ wholePlaylist: v }),

  setMusicAudioOnly: async (v) => {
    set({ musicAudioOnly: v })
    // applying the setting immediately is less surprising than waiting
    if (v && get().urlIsMusic) set({ quality: get().musicFormat, musicOverride: false })
    await invoke('prefs-set', { musicAudioOnly: v })
  },

  setMusicFormat: async (v) => {
    set({ musicFormat: v })
    const { urlIsMusic, musicAudioOnly, musicOverride } = get()
    if (urlIsMusic && musicAudioOnly && !musicOverride) set({ quality: v })
    await invoke('prefs-set', { musicFormat: v })
  },

  setCombineClips: async (v) => {
    set({ combineClips: v })
    await invoke('prefs-set', { combineClips: v })
  },

  clearMusicOverride: () => {
    const { musicFormat } = get()
    set({ musicOverride: false, quality: musicFormat })
  },

  dismissError: () => set({ error: '' }),

  loadPrefs: async () => {
    const res = await invoke<Res & { musicAudioOnly?: boolean; musicFormat?: string; combineClips?: boolean }>('prefs-get')
    if (res.ok)
      set({
        musicAudioOnly: res.musicAudioOnly !== false,
        musicFormat: res.musicFormat === 'audio-native' ? 'audio-native' : 'audio',
        combineClips: res.combineClips === true
      })
  },

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
      // A track+list URL defaults to the WHOLE thing for an album/playlist, but
      // to JUST THE TRACK for an auto-generated radio mix (those are endless —
      // grabbing the lot is almost never what you want).
      const wholePlaylist = p.canChooseSingle ? p.playlistKind !== 'mix' : p.kind === 'playlist'
      const what =
        p.playlistKind === 'album'
          ? `Album: ${p.count} track(s).`
          : p.playlistKind === 'mix'
            ? `Radio/mix detected (${p.count}+ tracks) — defaulting to just this track.`
            : p.kind === 'playlist'
              ? `Playlist: ${p.count} ${p.isMusic ? 'track' : 'video'}(s).`
              : `${p.isMusic ? 'Track' : 'Video'} ready to download.`
      set({ probe: p, wholePlaylist, statusMsg: what, urlIsMusic: p.isMusic })
      // The probe is authoritative about "is this music" (it also catches links
      // that don't look like music.youtube.com up front). Apply the setting
      // unless the user deliberately overrode it for this URL.
      const { musicAudioOnly, musicFormat, musicOverride } = get()
      if (p.isMusic && musicAudioOnly && !musicOverride) set({ quality: musicFormat })
    } finally {
      set({ probing: false })
    }
  },

  download: async () => {
    const { url, probe, quality, wholePlaylist, combineClips, jobs } = get()
    if (!url.trim()) return
    if (jobs.filter(isJobActive).length >= MAX_JOBS) {
      set({ error: `Up to ${MAX_JOBS} downloads can run at once — wait for one to finish or cancel one.` })
      return
    }
    // For a track+list URL the user's choice wins; otherwise follow the probe.
    // With no probe yet, fall back to the URL shape so a pasted playlist link
    // still downloads the playlist.
    const isPlaylist = probe
      ? probe.canChooseSingle
        ? wholePlaylist
        : probe.kind === 'playlist'
      : /[?&]list=/.test(url)
    const willCombine = combineClips && isPlaylist && !isAudioPreset(quality)
    const jobId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const qLabel = QUALITIES.find((q) => q.id === quality)?.label ?? quality
    const job: DownloadJob = {
      id: jobId,
      title: probe?.title ?? url.trim(),
      detail: `${qLabel}${isPlaylist ? ' · playlist' : ''}${willCombine ? ' · combine' : ''}`,
      state: 'running',
      progress: null,
      log: [],
      message: 'Starting download…',
      combinedInfo: null,
      startedAt: Date.now()
    }
    // new card on top; keep the finished-card history bounded. The form resets
    // so the next task can be set up while this one runs.
    set((s) => ({
      jobs: [job, ...s.jobs.filter(isJobActive), ...s.jobs.filter((j) => !isJobActive(j)).slice(0, 8)],
      error: '',
      url: '',
      probe: null,
      urlIsMusic: false,
      musicOverride: false,
      statusMsg: 'Download started — watch its card on the right. Paste another URL to queue the next one.'
    }))

    const res = (await invoke('download', {
      jobId,
      url: url.trim(),
      quality,
      isPlaylist,
      combine: combineClips,
      title: probe?.title ?? ''
    }).catch((e) => ({ ok: false, error: String(e) }))) as Res & { started?: boolean }

    // Once a job claims a slot (started), its lifecycle arrives as job-start /
    // job-end events — which also cover crash-resumed jobs the UI never
    // invoked. Only pre-claim rejections (slots full, bad URL) are handled here.
    if (res.started !== true && res.ok !== true) {
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === jobId ? { ...j, state: 'error' as JobState, message: (res as Err).error ?? 'Download failed.', progress: null } : j
        )
      }))
    }
  },

  cancel: async (jobId) => {
    await invoke('cancel', { jobId })
  },

  dismissJob: (jobId) => {
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== jobId || isJobActive(j)) }))
  },

  _onProgress: (raw) => {
    const p = raw as {
      jobId?: string
      kind?: string
      note?: string
      done?: number
      total?: number
      label?: string
      // job-start extras
      title?: string
      quality?: string
      isPlaylist?: boolean
      combine?: boolean
      resumed?: boolean
      // job-end extras
      ok?: boolean
      warning?: boolean
      cancelled?: boolean
      completed?: number
      error?: string
      combined?: { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean } | null
    } & Progress
    const jobId = p.jobId
    if (!jobId) return
    const patchJob = (fn: (j: DownloadJob) => Partial<DownloadJob>): void =>
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, ...fn(j) } : j)) }))
    if (p.kind === 'note' && p.note) {
      patchJob((j) => ({ log: [...j.log.slice(-60), p.note as string], message: p.note as string }))
    } else if (p.kind === 'combine') {
      const total = Number(p.total) || 1
      const done = Number(p.done) || 0
      const label = String(p.label ?? 'Combining…')
      patchJob(() => ({
        state: 'combining',
        message: label,
        progress: { index: done, total, percent: total ? Math.min(100, (done / total) * 100) : 0, speed: '', eta: '', title: label }
      }))
    } else if (p.kind === 'progress') {
      patchJob(() => ({
        progress: { index: p.index, total: p.total, percent: p.percent, speed: p.speed, eta: p.eta, title: p.title }
      }))
    } else if (p.kind === 'job-start') {
      // A job started in main that this UI doesn't have a card for yet — a
      // crash-resumed job restarting itself after launch. Give it a card.
      if (!get().jobs.some((j) => j.id === jobId)) {
        const qLabel = QUALITIES.find((q) => q.id === p.quality)?.label ?? String(p.quality ?? '')
        const job: DownloadJob = {
          id: jobId,
          title: String(p.title ?? 'Download'),
          detail: `${qLabel}${p.isPlaylist ? ' · playlist' : ''}${p.combine ? ' · combine' : ''}`,
          state: 'running',
          progress: null,
          log: [],
          message: p.resumed ? 'Resumed after restart — finished videos are skipped.' : 'Starting download…',
          combinedInfo: null,
          startedAt: Date.now()
        }
        set((s) => ({ jobs: [job, ...s.jobs] }))
      }
    } else if (p.kind === 'job-end') {
      const c = p.combined
      const combineMsg = c
        ? c.ok
          ? ` 🎬 Combined ${Number(c.used) || 0} clip(s) into one video.`
          : c.cancelled
            ? ' (Combine cancelled.)'
            : ` (Couldn’t combine: ${c.error ?? 'unknown error'})`
        : ''
      const combinedInfo =
        c?.ok && c.path ? { path: c.path, used: Number(c.used) || 0, total: Number(c.total) || 0 } : null
      if (p.cancelled) {
        patchJob(() => ({ state: 'cancelled', message: 'Download cancelled.', progress: null }))
      } else if (p.ok === true && !p.warning) {
        patchJob(() => ({
          state: c && !c.ok && !c.cancelled ? 'warning' : 'done',
          message: `Done — downloaded ${Number(p.completed) || ''} item(s).${combineMsg}`,
          combinedInfo,
          progress: null
        }))
      } else if (p.warning) {
        patchJob(() => ({
          state: 'warning',
          message: `Finished with some skips — ${Number(p.completed) || 0} downloaded.${combineMsg} ${p.error ?? ''}`.trim(),
          combinedInfo,
          progress: null
        }))
      } else {
        patchJob(() => ({ state: 'error', message: p.error ?? 'Download failed.', progress: null }))
      }
    }
  },

  _onStatusMsg: (m) => {
    if (typeof m === 'string') set({ statusMsg: m })
  }
}))

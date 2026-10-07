import { create } from 'zustand'
import { parseYtUrl } from './lib/url'
import type { ReviewItem, TagSummary } from './lib/songinfo'

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
  /** deno beside yt-dlp — required by YouTube extraction since 2026 */
  jsRuntimeReady: boolean
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
  /** how many of its videos are already in the downloaded-songs list (verified still there) */
  alreadyHave?: number
  alreadyItems?: AlreadyItem[]
  /** listed songs found missing (deleted / never uploaded) and taken off the list */
  missingRemoved?: number
}

/** A song that will be / was skipped because it's already downloaded. */
export interface AlreadyItem {
  videoId: string
  title: string
  artist: string
  /** e.g. "in Google Drive · Gym Mix" */
  where: string
}

/** What a download was started with (to run it again). */
export interface DownloadReq {
  url: string
  quality: string
  isPlaylist: boolean
  combine: boolean
  shuffle: boolean
  toDrive: boolean
  fixTags: boolean
  officialArt: boolean
  skipDuplicates: boolean
  title: string
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
  /** "Download to Google Drive" job: upload progress / result */
  toDrive?: boolean
  drive?: DriveJobInfo | null
  /** "Fix missing song info" totals (audio jobs) */
  fixTags?: boolean
  tags?: TagSummary | null
  /** songs skipped because they were downloaded before: by video id (before
   *  downloading) and as the same song under another video (after) */
  dupes?: { before: number; after: number } | null
  /** which songs it found already downloaded, and where */
  dupeItems?: AlreadyItem[]
  /** the request (absent for a job resumed after a restart) */
  req?: DownloadReq
}

export interface DriveJobInfo {
  uploaded: number
  failed: number
  pending: number
  current: string | null
  percent: number
  folderUrl: string | null
  /** set when the job ended */
  done?: boolean
  keptLocally?: number
  keptDir?: string
  error?: string
}

export interface DriveStatus {
  available: boolean
  connected: boolean
  email: string
  folder: string
}

export const MAX_JOBS = 2

/** Links in the paste box (one per line, or several pasted on one line). */
export const linksIn = (text: string): string[] => [...new Set((text.match(/https?:\/\/\S+/gi) ?? []).map((u) => u.replace(/[),.;]+$/, '')))]

export interface QueueItem {
  id: string
  url: string
  title: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  watchId?: string
  toDrive: boolean
  quality: string
  addedAt: number
  started?: boolean
  message?: string
}

export interface WatchItem {
  id: string
  url: string
  title: string
  quality: string
  toDrive: boolean
  addedAt: number
  lastCheckedAt: number
  lastResult: string
  enabled: boolean
}

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
  /** setting: stitch in RANDOM order (off = oldest → newest / playlist order) */
  combineShuffle: boolean
  /** true when the current URL looks like a YouTube Music link (live, no probe) */
  urlIsMusic: boolean
  /** user explicitly picked a video quality for this music URL — respect it */
  musicOverride: boolean
  /** setting: look songs up on MusicBrainz and fill missing info (audio downloads) */
  fixTags: boolean
  /** setting: with fixTags, swap in the official album cover */
  officialArt: boolean
  /** setting: music downloads skip songs already downloaded before */
  skipDuplicates: boolean
  /** how many songs are on the downloaded-songs list */
  libraryCount: number
  libraryOpen: boolean
  /** open the list showing only these songs (null = all) */
  libraryIds: string[] | null
  /** songs waiting for the user (MusicBrainz couldn't identify them) */
  reviewItems: ReviewItem[]
  /** the "Song info needed" window: null = closed; jobId narrows it to one download */
  reviewOpen: { jobId?: string } | null
  /** this link only: upload to Google Drive instead of saving here (resets per URL) */
  toDrive: boolean
  /** watch the pasted playlist link(s): re-check every 48 h for new songs */
  watchPlaylist: boolean
  /** the saved download queue (main) — waiting + recent */
  queue: QueueItem[]
  watches: WatchItem[]
  setWatchPlaylist: (v: boolean) => void
  loadQueue: () => Promise<void>
  removeQueued: (id: string) => Promise<void>
  removeWatch: (id: string) => Promise<void>
  setWatchEnabled: (id: string, v: boolean) => Promise<void>
  checkWatchNow: (id: string) => Promise<void>
  /** File Vault's Google Drive connection (null until loaded) */
  drive: DriveStatus | null

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
  setCombineShuffle: (v: boolean) => Promise<void>
  clearMusicOverride: () => void
  setSkipDuplicates: (v: boolean) => Promise<void>
  loadLibraryCount: () => Promise<void>
  setLibraryOpen: (v: boolean, ids?: string[]) => void
  /** take a job's skipped songs off the list and run the same download again */
  redownload: (jobId: string) => Promise<void>
  setFixTags: (v: boolean) => Promise<void>
  setOfficialArt: (v: boolean) => Promise<void>
  loadReview: () => Promise<void>
  openReview: (jobId?: string) => void
  closeReview: () => void
  setToDrive: (v: boolean) => void
  loadDrive: () => Promise<void>
  openDrive: (url?: string | null) => Promise<void>
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
  combineShuffle: false,
  urlIsMusic: false,
  musicOverride: false,
  toDrive: false,
  watchPlaylist: false,
  queue: [],
  watches: [],
  drive: null,
  fixTags: true,
  officialArt: true,
  skipDuplicates: true,
  libraryCount: 0,
  libraryOpen: false,
  libraryIds: null,
  reviewItems: [],
  reviewOpen: null,

  jobs: [],
  statusMsg: 'Paste a YouTube video or playlist URL to begin.',
  error: '',

  setUrl: (v) => {
    // Detect a music link as it's typed/pasted — no network call needed — so
    // the audio-only setting visibly applies before Check or Download.
    const links = linksIn(v)
    const isMusic = links.length > 0 && links.every((l) => parseYtUrl(l).isMusic)
    const { musicAudioOnly, musicFormat, quality, drive } = get()
    const hadPlaylist = linksIn(get().url).some((l) => !!parseYtUrl(l).listId)
    const hasPlaylist = links.some((l) => !!parseYtUrl(l).listId)
    const same = v.trim() === get().url.trim()
    set({
      url: v,
      probe: null,
      urlIsMusic: isMusic,
      musicOverride: false, // a new URL starts fresh
      // pasting a playlist ticks "Download to Google Drive" (when Drive is connected) — untick it if you like
      toDrive: same ? get().toDrive : hasPlaylist && !hadPlaylist && drive?.connected ? true : hasPlaylist ? get().toDrive : false,
      watchPlaylist: hasPlaylist ? get().watchPlaylist : false,
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

  setCombineShuffle: async (v) => {
    set({ combineShuffle: v })
    await invoke('prefs-set', { combineShuffle: v })
  },

  clearMusicOverride: () => {
    const { musicFormat } = get()
    set({ musicOverride: false, quality: musicFormat })
  },

  setSkipDuplicates: async (v) => {
    set({ skipDuplicates: v })
    await invoke('prefs-set', { skipDuplicates: v })
  },

  loadLibraryCount: async () => {
    const res = await invoke<Res & { total?: number }>('library-list', { limit: 1 }).catch(() => null)
    if (res?.ok) set({ libraryCount: Number((res as unknown as { total?: number }).total) || 0 })
  },

  setLibraryOpen: (v, ids) => set({ libraryOpen: v, libraryIds: v && ids?.length ? ids : null }),

  redownload: async (jobId) => {
    const old = get().jobs.find((j) => j.id === jobId)
    if (!old?.req || !old.dupeItems?.length) return
    await invoke('library-forget', { videoIds: old.dupeItems.map((d) => d.videoId) })
    // queue it (don't wait for it to finish — its card appears when it starts)
    const res = (await invoke('queue-add', { items: [{ url: old.req.url, isPlaylist: old.req.isPlaylist, title: old.req.title }], opts: old.req }).catch((e) => ({ ok: false, error: String(e) }))) as Res
    if (res.ok !== true) set({ error: (res as Err).error ?? 'Couldn’t queue it.' })
    void get().loadQueue()
  },

  setWatchPlaylist: (v) => set({ watchPlaylist: v }),

  loadQueue: async () => {
    const q = await invoke<Res & { items?: QueueItem[] }>('queue-list').catch(() => null)
    if (q?.ok) set({ queue: ((q as unknown as { items?: QueueItem[] }).items ?? []) as QueueItem[] })
    const w = await invoke<Res & { watches?: WatchItem[] }>('watch-list').catch(() => null)
    if (w?.ok) set({ watches: ((w as unknown as { watches?: WatchItem[] }).watches ?? []) as WatchItem[] })
  },
  removeQueued: async (id) => {
    await invoke('queue-remove', { id })
  },
  removeWatch: async (id) => {
    await invoke('watch-remove', { id })
    await get().loadQueue()
  },
  setWatchEnabled: async (id, v) => {
    await invoke('watch-set', { id, enabled: v })
    await get().loadQueue()
  },
  checkWatchNow: async (id) => {
    await invoke('watch-check-now', { id })
    await get().loadQueue()
  },

  setFixTags: async (v) => {
    set({ fixTags: v })
    await invoke('prefs-set', { fixTags: v })
  },

  setOfficialArt: async (v) => {
    set({ officialArt: v })
    await invoke('prefs-set', { officialArt: v })
  },

  loadReview: async () => {
    const res = await invoke<Res & { items?: ReviewItem[] }>('review-list').catch(() => null)
    if (res?.ok) set({ reviewItems: ((res as unknown as { items?: ReviewItem[] }).items ?? []) as ReviewItem[] })
  },

  openReview: (jobId) => set({ reviewOpen: jobId ? { jobId } : {} }),
  closeReview: () => set({ reviewOpen: null }),

  setToDrive: (v) => {
    set({ toDrive: v && get().drive?.connected === true })
    if (v) void get().loadDrive() // re-check: Drive may have been connected/disconnected meanwhile
  },

  loadDrive: async () => {
    const res = await invoke<Res & DriveStatus>('drive-status').catch(() => null)
    if (!res || res.ok !== true) return
    const d = res as unknown as DriveStatus
    set({ drive: { available: d.available, connected: d.connected, email: d.email, folder: d.folder } })
    if (!d.connected && get().toDrive) set({ toDrive: false })
  },

  openDrive: async (url) => {
    await invoke('open-drive', url ?? '')
  },

  dismissError: () => set({ error: '' }),

  loadPrefs: async () => {
    const res = await invoke<Res & { musicAudioOnly?: boolean; musicFormat?: string; combineClips?: boolean; combineShuffle?: boolean; fixTags?: boolean; officialArt?: boolean; skipDuplicates?: boolean }>('prefs-get')
    if (res.ok)
      set({
        musicAudioOnly: res.musicAudioOnly !== false,
        musicFormat: res.musicFormat === 'audio-native' ? 'audio-native' : 'audio',
        combineClips: res.combineClips === true,
        combineShuffle: res.combineShuffle === true,
        fixTags: res.fixTags !== false,
        officialArt: res.officialArt !== false,
        skipDuplicates: res.skipDuplicates !== false
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
    const url = linksIn(get().url)[0] ?? get().url.trim()
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
    const { url, probe, quality, wholePlaylist, combineClips, combineShuffle, toDrive, fixTags, officialArt, skipDuplicates, watchPlaylist } = get()
    const links = linksIn(url)
    if (!links.length) return
    // a single checked link keeps the track-vs-playlist choice; the rest follow the URL shape
    const items = links.map((u) => {
      if (links.length === 1 && probe) return { url: u, isPlaylist: probe.canChooseSingle ? wholePlaylist : probe.kind === 'playlist', title: probe.title }
      return { url: u }
    })
    const res = (await invoke('queue-add', {
      items,
      watch: watchPlaylist,
      opts: { quality, combine: combineClips, shuffle: combineShuffle, toDrive, fixTags, officialArt, skipDuplicates }
    }).catch((e) => ({ ok: false, error: String(e) }))) as Res & { added?: number; skipped?: { url: string; error: string }[]; watched?: number }
    if (res.ok !== true) return set({ error: (res as Err).error ?? 'Couldn’t add the links.' })
    const r = res as unknown as { added: number; skipped: { url: string; error: string }[]; watched: number }
    set({
      error: r.skipped.length ? `${r.skipped.length} link(s) not added: ${r.skipped.map((x) => `${x.url.slice(0, 60)} — ${x.error}`).join('; ')}` : '',
      url: '',
      probe: null,
      urlIsMusic: false,
      musicOverride: false,
      toDrive: false,
      watchPlaylist: false,
      statusMsg: `Added ${r.added} link${r.added === 1 ? '' : 's'} to the queue — ${MAX_JOBS} run at a time, the rest wait their turn.${r.watched ? ` Watching ${r.watched} playlist${r.watched === 1 ? '' : 's'} for new songs.` : ''}`
    })
    void get().loadQueue()
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
      toDrive?: boolean
      fixTags?: boolean
      resumed?: boolean
      // job-end extras
      ok?: boolean
      warning?: boolean
      cancelled?: boolean
      completed?: number
      error?: string
      combined?: { ok: boolean; path?: string; used?: number; total?: number; error?: string; cancelled?: boolean } | null
      drive?: DriveJobInfo | null
      tags?: TagSummary | null
      dupes?: { before: number; after: number } | null
      before?: number
      after?: number
      // tag extras (kind: 'tags')
      fixed?: number
      complete?: number
      needsInfo?: number
      skipped?: number
      // drive extras (kind: 'drive')
      uploaded?: number
      failed?: number
      pending?: number
      current?: string | null
      folderUrl?: string | null
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
    } else if (p.kind === 'title') {
      patchJob(() => ({ title: String(p.title ?? '') }))
    } else if (p.kind === 'dupe-items') {
      patchJob(() => ({ dupeItems: ((p as unknown as { items?: AlreadyItem[] }).items ?? []) as AlreadyItem[] }))
    } else if (p.kind === 'dupes') {
      patchJob(() => ({ dupes: { before: Number(p.before) || 0, after: Number(p.after) || 0 } }))
    } else if (p.kind === 'tags') {
      patchJob(() => ({
        tags: {
          fixed: Number(p.fixed) || 0,
          complete: Number(p.complete) || 0,
          needsInfo: Number(p.needsInfo) || 0,
          skipped: Number(p.skipped) || 0,
          pending: Number(p.pending) || 0,
          current: p.current ?? null,
          note: p.note
        }
      }))
    } else if (p.kind === 'drive') {
      patchJob((j) => ({
        drive: {
          ...(j.drive ?? {}),
          uploaded: Number(p.uploaded) || 0,
          failed: Number(p.failed) || 0,
          pending: Number(p.pending) || 0,
          current: p.current ?? null,
          percent: Number(p.percent) || 0,
          folderUrl: p.folderUrl ?? j.drive?.folderUrl ?? null
        }
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
          detail: `${qLabel}${p.isPlaylist ? ' · playlist' : ''}${p.combine ? ' · combine' : ''}${p.toDrive ? ' · → Google Drive' : ''}`,
          state: 'running',
          progress: null,
          log: [],
          message: p.resumed ? 'Resumed after restart — finished videos are skipped.' : 'Starting download…',
          combinedInfo: null,
          startedAt: Date.now(),
          toDrive: p.toDrive === true,
          drive: null,
          fixTags: p.fixTags === true,
          tags: null,
          req: (p as unknown as { req?: DownloadReq }).req
        }
        set((s) => ({ jobs: [job, ...s.jobs.filter(isJobActive), ...s.jobs.filter((j) => !isJobActive(j)).slice(0, 12)] }))
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
      // a Drive job's movie lives in Drive, not at the (deleted) staging path
      const combinedInfo =
        c?.ok && c.path && !p.drive ? { path: c.path, used: Number(c.used) || 0, total: Number(c.total) || 0 } : null
      const d = p.drive ?? null
      const driveMsg = d
        ? ` ${d.uploaded} uploaded to Google Drive.${d.failed ? ` ${d.failed} couldn’t be uploaded${d.keptLocally ? ` — saved to ${d.keptDir} instead` : ''}${d.error ? ` (${d.error})` : ''}.` : ''}`
        : ''
      const drivePatch = {
        ...(d ? { drive: { ...d, pending: 0, current: null, percent: 0, done: true } } : {}),
        ...(p.tags ? { tags: { ...p.tags, pending: 0, current: null } } : {}),
        ...(p.dupes ? { dupes: p.dupes } : {})
      }
      if (p.cancelled) {
        patchJob(() => ({ state: 'cancelled', message: 'Download cancelled.', progress: null }))
      } else if (p.ok === true && !p.warning) {
        patchJob(() => ({
          state: (c && !c.ok && !c.cancelled) || (d && d.failed > 0) ? 'warning' : 'done',
          message:
            p.dupes && p.dupes.before + p.dupes.after > 0 && !(Number(p.completed) || 0) && !(d?.uploaded ?? 0)
              ? `Nothing new — all ${p.dupes.before + p.dupes.after} song(s) were already downloaded.`
              : `${d ? `Done —${driveMsg}` : `Done — downloaded ${Number(p.completed) || ''} item(s).`}${p.dupes && p.dupes.before + p.dupes.after > 0 ? ` ${p.dupes.before + p.dupes.after} already downloaded before (skipped).` : ''}${combineMsg}`,
          combinedInfo,
          progress: null,
          ...drivePatch
        }))
      } else if (p.warning) {
        patchJob(() => ({
          state: 'warning',
          message: `Finished with some skips — ${Number(p.completed) || 0} downloaded.${driveMsg}${combineMsg} ${p.error ?? ''}`.trim(),
          combinedInfo,
          progress: null,
          ...drivePatch
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

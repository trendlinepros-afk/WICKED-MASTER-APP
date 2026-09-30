import { create } from 'zustand'
import type { Format, GenerateRequest, Generated, ImageRef, ImageWeight, Job, KeyCheckResult, LibraryItem, Model, ModuleSettings } from './types'
import { DEFAULT_SETTINGS } from './lib/models'

export const ID = 'thumbnail-generator'
export const inv = (action: string, ...args: unknown[]): Promise<unknown> => window.wicked.invoke(`${ID}:${action}`, ...args)

export type Tab = 'create' | 'library' | 'tools' | 'history' | 'settings'

interface Res {
  ok?: boolean
  error?: string
}

export interface CreateForm {
  mode: 'text' | 'image'
  prompt: string
  model: Model
  format: Format
  count: number
  image: ImageRef | null
  imageUrlText: string
  imageWeight: ImageWeight | ''
  support: ImageRef | null
  personaId: string
  styleId: string
}

export type HistoryItem = Generated & { exists?: boolean }

interface State {
  ready: boolean
  hasKey: boolean
  settings: ModuleSettings
  library: LibraryItem[]
  tab: Tab
  form: CreateForm
  job: Job | null
  history: HistoryItem[]
  toast: { kind: 'ok' | 'err' | 'warn'; text: string } | null

  init: () => Promise<() => void>
  refreshKey: () => Promise<void>
  /** last Re-check result (is a key set + does Pikzels accept it) */
  keyCheck: KeyCheckResult | null
  keyChecking: boolean
  checkKey: () => Promise<KeyCheckResult>
  setTab: (t: Tab) => void
  setForm: (patch: Partial<CreateForm>) => void
  generate: () => Promise<void>
  cancel: () => Promise<void>
  loadLibrary: () => Promise<void>
  loadHistory: () => Promise<void>
  saveSettings: (patch: Partial<ModuleSettings>) => Promise<void>
  useInCreate: (item: LibraryItem) => void
  recreateFrom: (ref: ImageRef) => void
  showToast: (kind: 'ok' | 'err' | 'warn', text: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const defaultForm: CreateForm = {
  mode: 'text',
  prompt: '',
  model: 'pkz_4_5',
  format: '16:9',
  count: 1,
  image: null,
  imageUrlText: '',
  imageWeight: '',
  support: null,
  personaId: '',
  styleId: ''
}

export const useThumbs = create<State>((set, get) => ({
  ready: false,
  hasKey: false,
  keyCheck: null,
  keyChecking: false,
  settings: DEFAULT_SETTINGS,
  library: [],
  tab: 'create',
  form: defaultForm,
  job: null,
  history: [],
  toast: null,

  init: async () => {
    const [key, settings, lib] = (await Promise.all([inv('key-status'), inv('settings'), inv('library')])) as [{ hasKey: boolean }, ModuleSettings, { items?: LibraryItem[] }]
    set({ ready: true, hasKey: key.hasKey, settings, library: lib.items ?? [] })
    const offJob = window.wicked.on(`${ID}:job`, (j) => {
      const job = j as Job
      if (get().job?.id === job.id) set({ job })
      if (job.done) void get().loadHistory()
    })
    const offLib = window.wicked.on(`${ID}:library`, (items) => set({ library: items as LibraryItem[] }))
    const offSettings = window.wicked.on(`${ID}:settings`, (s) => set({ settings: s as ModuleSettings }))
    return () => {
      offJob()
      offLib()
      offSettings()
    }
  },

  refreshKey: async () => {
    const key = (await inv('key-status')) as { hasKey: boolean }
    set({ hasKey: key.hasKey })
  },

  checkKey: async () => {
    set({ keyChecking: true })
    let r: KeyCheckResult
    try {
      r = (await inv('key-check')) as KeyCheckResult
    } catch (err) {
      r = { hasKey: get().hasKey, state: 'unreachable', message: `Check failed: ${err instanceof Error ? err.message : String(err)}`, at: Date.now() }
    }
    set({ keyChecking: false, keyCheck: r, hasKey: r.hasKey })
    get().showToast(r.state === 'ok' ? 'ok' : r.state === 'unreachable' ? 'warn' : 'err', r.message)
    return r
  },

  setTab: (tab) => {
    set({ tab })
    if (tab === 'history') void get().loadHistory()
    if (tab === 'library') void get().loadLibrary()
  },

  setForm: (patch) => set({ form: { ...get().form, ...patch } }),

  generate: async () => {
    const f = get().form
    const image: ImageRef | undefined = f.mode === 'image' ? (f.image ?? (f.imageUrlText.trim() ? { url: f.imageUrlText.trim(), label: f.imageUrlText.trim() } : undefined)) : undefined
    const req: GenerateRequest = {
      mode: f.mode,
      prompt: f.prompt,
      model: f.model,
      format: f.format,
      count: f.count,
      image,
      imageWeight: f.mode === 'image' && f.model === 'pkz_2' && f.imageWeight ? f.imageWeight : undefined,
      support: f.support ?? undefined,
      personaId: f.personaId || undefined,
      styleId: f.styleId || undefined
    }
    const r = (await inv('generate', req)) as Res & { job?: Job }
    if (!r.ok || !r.job) return get().showToast('err', r.error ?? 'Could not start')
    set({ job: r.job })
  },

  cancel: async () => {
    const j = get().job
    if (j) await inv('cancel', { jobId: j.id })
  },

  loadLibrary: async () => {
    const r = (await inv('library')) as { items?: LibraryItem[] }
    set({ library: r.items ?? [] })
  },

  loadHistory: async () => {
    const r = (await inv('history')) as { items?: HistoryItem[] }
    set({ history: r.items ?? [] })
  },

  saveSettings: async (patch) => {
    const s = (await inv('settings-set', patch)) as ModuleSettings
    set({ settings: s })
  },

  useInCreate: (item) => {
    const patch: Partial<CreateForm> = item.kind === 'persona' ? { personaId: item.id } : { styleId: item.id }
    const model = get().form.model
    if (model === 'pkz_2' || model === 'pkz_3') patch.model = 'pkz_4_5'
    set({ form: { ...get().form, ...patch }, tab: 'create' })
  },

  recreateFrom: (ref) => {
    set({ form: { ...get().form, mode: 'image', image: ref, imageUrlText: ref.url ?? '' }, tab: 'create' })
  },

  showToast: (kind, text) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { kind, text } })
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'ok' ? 4000 : 8000)
  }
}))

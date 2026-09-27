import { create } from 'zustand'
import type {
  Activity,
  AssetType,
  Attachment,
  Counts,
  DocRecord,
  DocSettings,
  Expiration,
  RecordSummary,
  RelatedItem,
  VaultStatus
} from './types'

export const ID = 'documentation'
const inv = (action: string, ...args: unknown[]): Promise<unknown> => window.wicked.invoke(`${ID}:${action}`, ...args)

interface Res {
  ok?: boolean
  error?: string
  locked?: boolean
  cancelled?: boolean
}

/** Where the main pane is. */
export type View =
  | { kind: 'dashboard' }
  | { kind: 'list'; type: string; folder?: string }
  | { kind: 'record'; id: string }
  | { kind: 'edit'; type: string; id?: string; folder?: string }
  | { kind: 'expirations' }
  | { kind: 'activity' }
  | { kind: 'favorites' }
  | { kind: 'archived' }
  | { kind: 'search'; q: string }
  | { kind: 'settings'; tab: 'types' | 'security' | 'sidebar' | 'data' }

export interface RecordDetail {
  record: DocRecord
  names: Record<string, { name: string; type: string }>
  related: RelatedItem[]
  referencedBy: RelatedItem[]
  attachments: Attachment[]
  activity: Activity[]
}

interface State {
  status: VaultStatus | null
  settings: DocSettings
  types: AssetType[]
  counts: Counts
  view: View
  history: View[]
  /** list/search cache keyed by view */
  list: RecordSummary[]
  listLoading: boolean
  listFilter: string
  detail: RecordDetail | null
  detailLoading: boolean
  expirations: Expiration[]
  activity: Activity[]
  toast: { kind: 'ok' | 'err' | 'warn'; text: string } | null
  error: string

  init: () => Promise<() => void>
  refreshStatus: () => Promise<VaultStatus>
  setup: (password: string) => Promise<string | null>
  unlock: (password: string) => Promise<{ error: string | null; retryAfter: number }>
  lock: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<string | null>
  saveSettings: (patch: Partial<DocSettings>) => Promise<void>
  touch: () => void

  loadTypes: () => Promise<void>
  go: (view: View) => void
  back: () => void
  openRecord: (id: string) => void
  loadList: () => Promise<void>
  setListFilter: (q: string) => void
  loadDetail: (id: string) => Promise<void>
  saveRecord: (draft: { id?: string; type: string; name: string; fields: Record<string, unknown>; tags: string[]; folder: string }) => Promise<DocRecord | null>
  deleteRecord: (id: string) => Promise<boolean>
  flag: (id: string, flag: 'favorite' | 'archived', value: boolean) => Promise<void>
  loadExpirations: (days?: number) => Promise<void>
  loadActivity: () => Promise<void>
  showToast: (kind: 'ok' | 'err' | 'warn', text: string) => void
  clearError: () => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
let lastTouch = 0

export const useDocs = create<State>((set, get) => ({
  status: null,
  settings: { autoLockMinutes: 15, hiddenTypes: [], clipboardClearSeconds: 45 },
  types: [],
  counts: { byType: {}, favorites: 0, archived: 0, expiringSoon: 0 },
  view: { kind: 'dashboard' },
  history: [],
  list: [],
  listLoading: false,
  listFilter: '',
  detail: null,
  detailLoading: false,
  expirations: [],
  activity: [],
  toast: null,
  error: '',

  init: async () => {
    const [status, settings] = (await Promise.all([inv('status'), inv('settings')])) as [VaultStatus, DocSettings]
    set({ status, settings })
    if (status.unlocked) void get().loadTypes()
    const off = window.wicked.on(`${ID}:locked`, () => {
      set({ status: { ...(get().status as VaultStatus), unlocked: false }, detail: null, list: [], view: { kind: 'dashboard' }, history: [] })
    })
    return off
  },

  refreshStatus: async () => {
    const status = (await inv('status')) as VaultStatus
    set({ status })
    return status
  },

  setup: async (password) => {
    const r = (await inv('setup', { password })) as Res & { status?: VaultStatus }
    if (!r.ok) return r.error ?? 'Could not set the password.'
    set({ status: r.status ?? null })
    await get().loadTypes()
    return null
  },

  unlock: async (password) => {
    const r = (await inv('unlock', { password })) as Res & { status?: VaultStatus; retryAfter?: number }
    if (r.status) set({ status: r.status })
    if (!r.ok) return { error: r.error ?? 'Wrong password.', retryAfter: r.retryAfter ?? 0 }
    await get().loadTypes()
    return { error: null, retryAfter: 0 }
  },

  lock: async () => {
    const r = (await inv('lock')) as Res & { status?: VaultStatus }
    set({ status: r.status ?? null, detail: null, list: [], view: { kind: 'dashboard' }, history: [] })
  },

  changePassword: async (current, next) => {
    const r = (await inv('change-password', { current, next })) as Res
    return r.ok ? null : (r.error ?? 'Could not change the password.')
  },

  saveSettings: async (patch) => {
    const settings = (await inv('settings-set', patch)) as DocSettings
    set({ settings, status: get().status ? { ...(get().status as VaultStatus), autoLockMinutes: settings.autoLockMinutes } : null })
  },

  touch: () => {
    const now = Date.now()
    if (now - lastTouch < 20_000) return
    lastTouch = now
    void inv('touch')
  },

  loadTypes: async () => {
    const r = (await inv('types')) as Res & { types?: AssetType[]; counts?: Record<string, number> }
    if (r.locked) return void get().refreshStatus()
    const c = (await inv('counts')) as Res & { counts?: Counts }
    set({ types: r.types ?? [], counts: c.counts ?? get().counts })
  },

  go: (view) => {
    const cur = get().view
    set({ view, history: [...get().history.slice(-30), cur], listFilter: view.kind === 'search' ? view.q : '', error: '' })
    if (view.kind === 'list' || view.kind === 'favorites' || view.kind === 'archived' || view.kind === 'search') void get().loadList()
    if (view.kind === 'record') void get().loadDetail(view.id)
    if (view.kind === 'expirations' || view.kind === 'dashboard') void get().loadExpirations(view.kind === 'dashboard' ? 30 : 365)
    if (view.kind === 'activity' || view.kind === 'dashboard') void get().loadActivity()
    if (view.kind === 'dashboard') void get().loadTypes()
  },

  back: () => {
    const h = get().history
    if (!h.length) return get().go({ kind: 'dashboard' })
    const prev = h[h.length - 1]
    set({ history: h.slice(0, -1) })
    const cur = get().view
    set({ view: prev })
    if (prev.kind === 'list' || prev.kind === 'favorites' || prev.kind === 'archived' || prev.kind === 'search') void get().loadList()
    if (prev.kind === 'record') void get().loadDetail(prev.id)
    if (prev.kind === 'dashboard') {
      void get().loadTypes()
      void get().loadExpirations(30)
      void get().loadActivity()
    }
    void cur
  },

  openRecord: (id) => get().go({ kind: 'record', id }),

  loadList: async () => {
    const v = get().view
    set({ listLoading: true })
    let r: Res & { records?: RecordSummary[] }
    if (v.kind === 'list') r = (await inv('records', { type: v.type, archived: false, folder: v.folder, q: get().listFilter })) as typeof r
    else if (v.kind === 'favorites') r = (await inv('records', { favorite: true, archived: false, q: get().listFilter })) as typeof r
    else if (v.kind === 'archived') r = (await inv('records', { archived: true, q: get().listFilter })) as typeof r
    else if (v.kind === 'search') r = (await inv('search', { q: v.q })) as typeof r
    else r = { ok: true, records: [] }
    if (r.locked) void get().refreshStatus()
    set({ list: r.records ?? [], listLoading: false })
  },

  setListFilter: (q) => {
    set({ listFilter: q })
    void get().loadList()
  },

  loadDetail: async (id) => {
    set({ detailLoading: true })
    const r = (await inv('record', { id })) as Res & RecordDetail
    if (r.locked) void get().refreshStatus()
    if (!r.ok) {
      set({ detailLoading: false, detail: null, error: r.error ?? 'Could not open that record.' })
      return
    }
    set({ detail: { record: r.record, names: r.names, related: r.related, referencedBy: r.referencedBy, attachments: r.attachments, activity: r.activity }, detailLoading: false })
  },

  saveRecord: async (draft) => {
    const r = (await inv('record-save', draft)) as Res & { record?: DocRecord }
    if (!r.ok || !r.record) {
      set({ error: r.error ?? 'Could not save.' })
      return null
    }
    void get().loadTypes()
    return r.record
  },

  deleteRecord: async (id) => {
    const r = (await inv('record-delete', { id })) as Res
    if (!r.ok) {
      get().showToast('err', r.error ?? 'Could not delete.')
      return false
    }
    void get().loadTypes()
    return true
  },

  flag: async (id, flag, value) => {
    await inv('record-flag', { id, flag, value })
    const d = get().detail
    if (d && d.record.id === id) set({ detail: { ...d, record: { ...d.record, [flag]: value } } })
    set({ list: get().list.map((s) => (s.id === id ? { ...s, [flag]: value } : s)) })
    void get().loadTypes()
  },

  loadExpirations: async (days = 90) => {
    const r = (await inv('expirations', { days })) as Res & { items?: Expiration[] }
    set({ expirations: r.items ?? [] })
  },

  loadActivity: async () => {
    const r = (await inv('activity', { limit: 200 })) as Res & { items?: Activity[] }
    set({ activity: r.items ?? [] })
  },

  showToast: (kind, text) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { kind, text } })
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'ok' ? 4000 : 8000)
  },

  clearError: () => set({ error: '' })
}))

export { inv }

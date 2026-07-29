import { create } from 'zustand'
import type { JournalEntry } from './types'

const ID = 'trade-log'
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

interface ListRes {
  ok: boolean
  entries?: JournalEntry[]
}
interface OneRes {
  ok: boolean
  entry?: JournalEntry
  entries?: JournalEntry[]
  error?: string
}

/** "YYYY-MM-DDTHH:mm" for the current local time (for <input type="datetime-local">). */
export function nowLocal(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

interface State {
  entries: JournalEntry[]
  selectedId: string | null
  draft: JournalEntry | null
  dirty: boolean
  loading: boolean
  saving: boolean
  error: string

  load: () => Promise<void>
  select: (id: string | null) => Promise<void>
  newEntry: () => Promise<void>
  edit: (patch: Partial<JournalEntry>) => void
  save: () => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useTradeLog = create<State>((set, get) => ({
  entries: [],
  selectedId: null,
  draft: null,
  dirty: false,
  loading: true,
  saving: false,
  error: '',

  load: async () => {
    set({ loading: true })
    const res = await invoke<ListRes>('list')
    const entries = res.entries ?? []
    set({ entries, loading: false })
    // keep the current selection valid; otherwise pick the newest
    const cur = get().selectedId
    if (!cur || !entries.some((e) => e.id === cur)) {
      const first = entries[0] ?? null
      set({ selectedId: first?.id ?? null, draft: first ? { ...first } : null, dirty: false })
    }
  },

  select: async (id) => {
    if (get().dirty) await get().save()
    if (id === null) {
      set({ selectedId: null, draft: null, dirty: false })
      return
    }
    const entry = get().entries.find((e) => e.id === id) ?? null
    set({ selectedId: id, draft: entry ? { ...entry } : null, dirty: false })
  },

  newEntry: async () => {
    if (get().dirty) await get().save()
    const res = await invoke<OneRes>('create', {
      name: '',
      nameAuto: true,
      symbol: '',
      buyAt: nowLocal(),
      shares: 0,
      buyPrice: null,
      entryNote: '',
      sellAt: '',
      sellPrice: null,
      exitNote: '',
      emotion: null,
      finalReview: ''
    })
    if (res.ok && res.entry) {
      set({
        entries: res.entries ?? get().entries,
        selectedId: res.entry.id,
        draft: { ...res.entry },
        dirty: false
      })
    } else {
      set({ error: res.error ?? 'Could not create entry.' })
    }
  },

  edit: (patch) => {
    const d = get().draft
    if (!d) return
    set({ draft: { ...d, ...patch }, dirty: true })
  },

  save: async () => {
    const d = get().draft
    if (!d) return
    set({ saving: true, error: '' })
    const { id, createdAt, updatedAt, ...patch } = d
    void createdAt
    void updatedAt
    const res = await invoke<OneRes>('update', id, patch)
    if (res.ok && res.entry) {
      set({ entries: res.entries ?? get().entries, draft: { ...res.entry }, dirty: false, saving: false })
    } else {
      set({ error: res.error ?? 'Could not save entry.', saving: false })
    }
  },

  remove: async (id) => {
    const res = await invoke<OneRes>('remove', id)
    const entries = res.entries ?? get().entries.filter((e) => e.id !== id)
    const wasSelected = get().selectedId === id
    set({
      entries,
      ...(wasSelected
        ? { selectedId: entries[0]?.id ?? null, draft: entries[0] ? { ...entries[0] } : null, dirty: false }
        : {})
    })
  }
}))

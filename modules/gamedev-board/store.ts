import { create } from 'zustand'
import { clearStore, del, get, getAll, openDB, put } from './db'

export interface Folder {
  id: string
  name: string
  createdAt: number
}

export interface ChecklistItem {
  text: string
  done: boolean
}

export interface Card {
  id: string
  folderId: string
  title: string
  body: string
  images: string[]
  checklist: ChecklistItem[]
  createdAt: number
}

export interface TimeEntry {
  id: string
  start: number
  end: number
  note: string
  createdAt: number
}

/** A freely-positioned item on a folder's freeform canvas (text or image). */
export interface CanvasItem {
  id: string
  folderId: string
  kind: 'text' | 'image'
  x: number
  y: number
  w: number
  h: number
  z: number
  text?: string
  /** image blob id in the shared `images` store (reused from cards) */
  imageId?: string
  createdAt: number
}

interface BoardSettings {
  view: 'board' | 'log'
  /** how the Board view renders: stacked cards, or a freeform canvas */
  boardMode: 'cards' | 'freeform'
  activeFolder: string | null
  timerStart: number | null
  /** width of the module's Views/Folders sidebar (px) */
  sidebarWidth: number
}

export function uid(p: string): string {
  return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

/* ---------- formatting (carried over from the standalone app) ---------- */
const pad = (n: number): string => String(n).padStart(2, '0')

export function fmtClock(sec: number): string {
  sec = Math.max(0, Math.floor(sec))
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`
}

export function fmtDur(sec: number): string {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

export function fmtHours(sec: number): string {
  return (sec / 3600).toFixed(1).replace(/\.0$/, '') + 'h'
}

export function dateInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function timeInput(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function entryDur(e: TimeEntry): number {
  let d = e.end - e.start
  if (d < 0) d += 86400000 // crossed midnight
  return d / 1000
}

export function isToday(ms: number): boolean {
  const d = new Date(ms)
  const n = new Date()
  return (
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  )
}

/* ---------- image object URLs ---------- */
const objUrls = new Map<string, string>()

export function imgUrl(id: string): string | null {
  return objUrls.get(id) ?? null
}

/* ---------- store ---------- */
interface BoardState {
  ready: boolean
  folders: Folder[]
  cards: Card[]
  canvasItems: CanvasItem[]
  entries: TimeEntry[]
  settings: BoardSettings
  activeCardId: string | null
  /** bumped on external data change (import) to remount views */
  dataEpoch: number

  init: () => Promise<void>
  saveSettings: (patch: Partial<BoardSettings>) => Promise<void>
  setActiveCard: (id: string | null) => void

  addCanvasText: (folderId: string, x: number, y: number) => Promise<CanvasItem>
  addCanvasImage: (folderId: string, blob: Blob, x: number, y: number) => Promise<void>
  patchCanvasItem: (id: string, patch: Partial<CanvasItem>) => void
  persistCanvasItem: (id: string) => Promise<void>
  bringCanvasItemFront: (id: string) => Promise<void>
  deleteCanvasItem: (id: string) => Promise<void>

  addFolder: (name: string) => Promise<Folder>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>

  addCard: (folderId: string) => Promise<Card>
  patchCard: (id: string, patch: Partial<Card>) => void
  persistCard: (id: string) => Promise<void>
  deleteCard: (id: string) => Promise<void>
  addImageToCard: (cardId: string, blob: Blob) => Promise<void>
  removeImage: (cardId: string, imageId: string) => Promise<void>

  startTimer: () => Promise<void>
  /** stops the timer; returns the pending entry span if it ran >= 1s */
  stopTimer: () => Promise<{ start: number; end: number } | null>
  logEntry: (start: number, end: number, note: string) => Promise<void>
  patchEntry: (id: string, patch: Partial<TimeEntry>) => Promise<void>
  deleteEntry: (id: string) => Promise<void>
  addManualEntry: () => Promise<void>

  exportData: () => Promise<void>
  importData: (dump: BackupDump) => Promise<void>
}

export interface BackupDump {
  app?: string
  version?: number
  folders?: Folder[]
  cards?: Card[]
  canvasItems?: CanvasItem[]
  entries?: TimeEntry[]
  images?: { id: string; data: string }[]
  settings?: Partial<BoardSettings>
}

const DEFAULT_SETTINGS: BoardSettings = {
  view: 'board',
  boardMode: 'cards',
  activeFolder: null,
  timerStart: null,
  sidebarWidth: 188
}

async function dataUrlToBlob(u: string): Promise<Blob> {
  return (await fetch(u)).blob()
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((r) => {
    const fr = new FileReader()
    fr.onload = () => r(fr.result as string)
    fr.readAsDataURL(blob)
  })
}

export const useBoard = create<BoardState>((set, getState) => ({
  ready: false,
  folders: [],
  cards: [],
  canvasItems: [],
  entries: [],
  settings: DEFAULT_SETTINGS,
  activeCardId: null,
  dataEpoch: 0,

  init: async () => {
    if (getState().ready) return
    await openDB()
    const folders = (await getAll<Folder>('folders')).sort((a, b) => a.createdAt - b.createdAt)
    const cards = (await getAll<Card>('cards')).map((c) => ({
      ...c,
      images: c.images ?? [],
      checklist: c.checklist ?? []
    }))
    const canvasItems = await getAll<CanvasItem>('canvasItems')
    const entries = await getAll<TimeEntry>('timeEntries')
    const saved = await get<{ key: string } & BoardSettings>('settings', 'app')
    let settings = DEFAULT_SETTINGS
    if (saved) {
      const { key: _key, ...rest } = saved
      settings = { ...DEFAULT_SETTINGS, ...rest }
    }
    for (const im of await getAll<{ id: string; blob: Blob }>('images')) {
      if (!objUrls.has(im.id)) objUrls.set(im.id, URL.createObjectURL(im.blob))
    }

    // seed on first run (same starter content as the standalone app)
    let seeded = folders
    let seededCards = cards
    if (!folders.length) {
      const f1: Folder = { id: uid('f'), name: 'Ideas', createdAt: Date.now() }
      const f2: Folder = { id: uid('f'), name: 'To-do', createdAt: Date.now() + 1 }
      const f3: Folder = { id: uid('f'), name: 'Art & assets', createdAt: Date.now() + 2 }
      seeded = [f1, f2, f3]
      for (const f of seeded) await put('folders', f)
      const welcome: Card = {
        id: uid('c'),
        folderId: f1.id,
        title: 'Welcome 👋',
        body: 'This is an idea card. Type anything here.\n\n• Paste a screenshot anytime with Ctrl+V (it lands on the card you last clicked).\n• Add tasks below and tick them off.\n• Use the timer up top — it logs every session. Forgot to start it? Add or edit entries in Time log.',
        images: [],
        checklist: [
          { text: 'Make my first folder', done: false },
          { text: 'Paste a screenshot of an idea', done: false },
          { text: 'Start the timer when I begin working', done: false }
        ],
        createdAt: Date.now()
      }
      seededCards = [welcome]
      await put('cards', welcome)
      settings = { ...settings, activeFolder: f1.id }
      await put('settings', { key: 'app', ...settings })
    }

    set({ ready: true, folders: seeded, cards: seededCards, canvasItems, entries, settings })
  },

  saveSettings: async (patch) => {
    const settings = { ...getState().settings, ...patch }
    set({ settings })
    await put('settings', { key: 'app', ...settings })
  },

  setActiveCard: (id) => set({ activeCardId: id }),

  /* --------------------------- freeform canvas --------------------------- */

  addCanvasText: async (folderId, x, y) => {
    const items = getState().canvasItems
    const z = items.reduce((m, i) => Math.max(m, i.z), 0) + 1
    const it: CanvasItem = {
      id: uid('cv'),
      folderId,
      kind: 'text',
      x,
      y,
      w: 220,
      h: 90,
      z,
      text: '',
      createdAt: Date.now()
    }
    set({ canvasItems: [...items, it] })
    await put('canvasItems', it)
    return it
  },

  addCanvasImage: async (folderId, blob, x, y) => {
    const imageId = uid('img')
    await put('images', { id: imageId, blob })
    objUrls.set(imageId, URL.createObjectURL(blob))
    const items = getState().canvasItems
    const z = items.reduce((m, i) => Math.max(m, i.z), 0) + 1
    const it: CanvasItem = {
      id: uid('cv'),
      folderId,
      kind: 'image',
      x,
      y,
      w: 280,
      h: 200,
      z,
      imageId,
      createdAt: Date.now()
    }
    set({ canvasItems: [...items, it] })
    await put('canvasItems', it)
  },

  patchCanvasItem: (id, patch) => {
    set({ canvasItems: getState().canvasItems.map((i) => (i.id === id ? { ...i, ...patch } : i)) })
  },

  persistCanvasItem: async (id) => {
    const it = getState().canvasItems.find((i) => i.id === id)
    if (it) await put('canvasItems', it)
  },

  bringCanvasItemFront: async (id) => {
    const items = getState().canvasItems
    const top = items.reduce((m, i) => Math.max(m, i.z), 0)
    const it = items.find((i) => i.id === id)
    if (!it || it.z === top) return
    getState().patchCanvasItem(id, { z: top + 1 })
    await getState().persistCanvasItem(id)
  },

  deleteCanvasItem: async (id) => {
    const it = getState().canvasItems.find((i) => i.id === id)
    if (!it) return
    if (it.kind === 'image' && it.imageId) {
      await del('images', it.imageId)
      const u = objUrls.get(it.imageId)
      if (u) {
        URL.revokeObjectURL(u)
        objUrls.delete(it.imageId)
      }
    }
    set({ canvasItems: getState().canvasItems.filter((i) => i.id !== id) })
    await del('canvasItems', id)
  },

  addFolder: async (name) => {
    const f: Folder = { id: uid('f'), name, createdAt: Date.now() }
    set({ folders: [...getState().folders, f] })
    await put('folders', f)
    await getState().saveSettings({ view: 'board', activeFolder: f.id })
    return f
  },

  renameFolder: async (id, name) => {
    const folders = getState().folders.map((f) => (f.id === id ? { ...f, name } : f))
    set({ folders })
    const f = folders.find((x) => x.id === id)
    if (f) await put('folders', f)
  },

  deleteFolder: async (id) => {
    const { cards, folders, settings } = getState()
    const doomed = cards.filter((c) => c.folderId === id)
    for (const c of doomed) {
      for (const im of c.images) {
        await del('images', im)
        const u = objUrls.get(im)
        if (u) {
          URL.revokeObjectURL(u)
          objUrls.delete(im)
        }
      }
      await del('cards', c.id)
    }
    const nextFolders = folders.filter((f) => f.id !== id)
    set({ cards: cards.filter((c) => c.folderId !== id), folders: nextFolders })
    await del('folders', id)
    if (settings.activeFolder === id) {
      await getState().saveSettings({ activeFolder: nextFolders[0]?.id ?? null })
    }
  },

  addCard: async (folderId) => {
    const c: Card = {
      id: uid('c'),
      folderId,
      title: '',
      body: '',
      images: [],
      checklist: [],
      createdAt: Date.now()
    }
    set({ cards: [...getState().cards, c], activeCardId: c.id })
    await put('cards', c)
    return c
  },

  patchCard: (id, patch) => {
    set({ cards: getState().cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
  },

  persistCard: async (id) => {
    const c = getState().cards.find((x) => x.id === id)
    if (c) await put('cards', c)
  },

  deleteCard: async (id) => {
    const c = getState().cards.find((x) => x.id === id)
    if (!c) return
    for (const im of c.images) {
      await del('images', im)
      const u = objUrls.get(im)
      if (u) {
        URL.revokeObjectURL(u)
        objUrls.delete(im)
      }
    }
    set({ cards: getState().cards.filter((x) => x.id !== id) })
    await del('cards', id)
  },

  addImageToCard: async (cardId, blob) => {
    const id = uid('img')
    await put('images', { id, blob })
    objUrls.set(id, URL.createObjectURL(blob))
    const c = getState().cards.find((x) => x.id === cardId)
    if (!c) return
    getState().patchCard(cardId, { images: [...c.images, id] })
    await getState().persistCard(cardId)
  },

  removeImage: async (cardId, imageId) => {
    const c = getState().cards.find((x) => x.id === cardId)
    if (!c) return
    getState().patchCard(cardId, { images: c.images.filter((i) => i !== imageId) })
    await getState().persistCard(cardId)
    await del('images', imageId)
    const u = objUrls.get(imageId)
    if (u) {
      URL.revokeObjectURL(u)
      objUrls.delete(imageId)
    }
  },

  startTimer: async () => {
    await getState().saveSettings({ timerStart: Date.now() })
  },

  stopTimer: async () => {
    const start = getState().settings.timerStart
    if (!start) return null
    const end = Date.now()
    await getState().saveSettings({ timerStart: null })
    return end - start >= 1000 ? { start, end } : null
  },

  logEntry: async (start, end, note) => {
    const e: TimeEntry = { id: uid('t'), start, end, note, createdAt: Date.now() }
    set({ entries: [...getState().entries, e] })
    await put('timeEntries', e)
  },

  patchEntry: async (id, patch) => {
    const entries = getState().entries.map((e) => (e.id === id ? { ...e, ...patch } : e))
    set({ entries })
    const e = entries.find((x) => x.id === id)
    if (e) await put('timeEntries', e)
  },

  deleteEntry: async (id) => {
    set({ entries: getState().entries.filter((e) => e.id !== id) })
    await del('timeEntries', id)
  },

  addManualEntry: async () => {
    const end = Date.now()
    await getState().logEntry(end - 3600000, end, '')
  },

  exportData: async () => {
    const { folders, cards, canvasItems, entries, settings } = getState()
    const images = await getAll<{ id: string; blob: Blob }>('images')
    const imgOut: { id: string; data: string }[] = []
    for (const im of images) imgOut.push({ id: im.id, data: await blobToDataUrl(im.blob) })
    const dump = {
      app: 'GameDevHelper',
      version: 2,
      exportedAt: new Date().toISOString(),
      folders,
      cards,
      canvasItems,
      entries,
      images: imgOut,
      settings
    }
    const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'gamedevhelper-backup-' + dateInput(Date.now()) + '.json'
    document.body.append(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
  },

  importData: async (dump) => {
    for (const n of ['folders', 'cards', 'canvasItems', 'images', 'timeEntries'] as const) await clearStore(n)
    for (const u of objUrls.values()) URL.revokeObjectURL(u)
    objUrls.clear()
    for (const f of dump.folders ?? []) await put('folders', f)
    for (const c of dump.cards ?? []) await put('cards', c)
    for (const it of dump.canvasItems ?? []) await put('canvasItems', it)
    for (const e of dump.entries ?? []) await put('timeEntries', e)
    for (const im of dump.images ?? []) {
      await put('images', { id: im.id, blob: await dataUrlToBlob(im.data) })
    }
    const settings = { ...DEFAULT_SETTINGS, ...(dump.settings ?? {}), timerStart: null }
    await put('settings', { key: 'app', ...settings })

    const folders = (await getAll<Folder>('folders')).sort((a, b) => a.createdAt - b.createdAt)
    const cards = (await getAll<Card>('cards')).map((c) => ({
      ...c,
      images: c.images ?? [],
      checklist: c.checklist ?? []
    }))
    const canvasItems = await getAll<CanvasItem>('canvasItems')
    const entries = await getAll<TimeEntry>('timeEntries')
    for (const im of await getAll<{ id: string; blob: Blob }>('images')) {
      objUrls.set(im.id, URL.createObjectURL(im.blob))
    }
    set((s) => ({
      folders,
      cards,
      canvasItems,
      entries,
      settings,
      activeCardId: null,
      dataEpoch: s.dataEpoch + 1
    }))
  }
}))

/* ---------- derived totals ---------- */
export function liveSec(timerStart: number | null): number {
  return timerStart ? (Date.now() - timerStart) / 1000 : 0
}

export function totalSec(entries: TimeEntry[], timerStart: number | null): number {
  return entries.reduce((s, e) => s + entryDur(e), 0) + liveSec(timerStart)
}

export function todaySec(entries: TimeEntry[], timerStart: number | null): number {
  return (
    entries.filter((e) => isToday(e.start)).reduce((s, e) => s + entryDur(e), 0) +
    (timerStart && isToday(timerStart) ? liveSec(timerStart) : 0)
  )
}

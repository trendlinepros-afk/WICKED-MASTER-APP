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

/**
 * Legacy record: the old stacked-card view. The card UI is gone — the freeform
 * canvas is the only board — but the type stays so old backups still import/export
 * losslessly and folder deletion can clean up any legacy card rows in the DB.
 */
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
  canvasItems: CanvasItem[]
  entries: TimeEntry[]
  settings: BoardSettings
  /** bumped on external data change (import) to remount views */
  dataEpoch: number

  init: () => Promise<void>
  saveSettings: (patch: Partial<BoardSettings>) => Promise<void>

  addCanvasText: (folderId: string, x: number, y: number) => Promise<CanvasItem>
  addCanvasImage: (folderId: string, blob: Blob, x: number, y: number) => Promise<void>
  patchCanvasItem: (id: string, patch: Partial<CanvasItem>) => void
  persistCanvasItem: (id: string) => Promise<void>
  bringCanvasItemFront: (id: string) => Promise<void>
  deleteCanvasItem: (id: string) => Promise<void>

  addFolder: (name: string) => Promise<Folder>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>

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
  canvasItems: [],
  entries: [],
  settings: DEFAULT_SETTINGS,
  dataEpoch: 0,

  init: async () => {
    if (getState().ready) return
    await openDB()
    const folders = (await getAll<Folder>('folders')).sort((a, b) => a.createdAt - b.createdAt)
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

    // seed on first run
    let seeded = folders
    let seededCanvas = canvasItems
    if (!folders.length) {
      const f1: Folder = { id: uid('f'), name: 'Ideas', createdAt: Date.now() }
      const f2: Folder = { id: uid('f'), name: 'To-do', createdAt: Date.now() + 1 }
      const f3: Folder = { id: uid('f'), name: 'Art & assets', createdAt: Date.now() + 2 }
      seeded = [f1, f2, f3]
      for (const f of seeded) await put('folders', f)
      const welcomeNote: CanvasItem = {
        id: uid('cv'),
        folderId: f1.id,
        kind: 'text',
        x: 40,
        y: 40,
        w: 300,
        h: 128,
        z: 1,
        text: 'Welcome 👋\n\nClick anywhere on this canvas to start typing. Paste a screenshot with Ctrl+V to drop it right where you click. Drag the grip to move things, resize from the corner.',
        createdAt: Date.now()
      }
      seededCanvas = [welcomeNote]
      await put('canvasItems', welcomeNote)
      settings = { ...settings, activeFolder: f1.id }
      await put('settings', { key: 'app', ...settings })
    }

    set({ ready: true, folders: seeded, canvasItems: seededCanvas, entries, settings })
  },

  saveSettings: async (patch) => {
    const settings = { ...getState().settings, ...patch }
    set({ settings })
    await put('settings', { key: 'app', ...settings })
  },

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
    const { canvasItems, folders, settings } = getState()
    const dropImage = async (imageId: string): Promise<void> => {
      await del('images', imageId)
      const u = objUrls.get(imageId)
      if (u) {
        URL.revokeObjectURL(u)
        objUrls.delete(imageId)
      }
    }
    // canvas items in this folder (and their images)
    for (const it of canvasItems.filter((i) => i.folderId === id)) {
      if (it.kind === 'image' && it.imageId) await dropImage(it.imageId)
      await del('canvasItems', it.id)
    }
    // legacy card rows from the retired card view, straight from the DB
    for (const c of (await getAll<Card>('cards')).filter((x) => x.folderId === id)) {
      for (const im of c.images ?? []) await dropImage(im)
      await del('cards', c.id)
    }
    const nextFolders = folders.filter((f) => f.id !== id)
    set({ canvasItems: canvasItems.filter((i) => i.folderId !== id), folders: nextFolders })
    await del('folders', id)
    if (settings.activeFolder === id) {
      await getState().saveSettings({ activeFolder: nextFolders[0]?.id ?? null })
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
    const { folders, canvasItems, entries, settings } = getState()
    // legacy card rows (if any) come straight from the DB so backups stay lossless
    const cards = await getAll<Card>('cards')
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
    const canvasItems = await getAll<CanvasItem>('canvasItems')
    const entries = await getAll<TimeEntry>('timeEntries')
    for (const im of await getAll<{ id: string; blob: Blob }>('images')) {
      objUrls.set(im.id, URL.createObjectURL(im.blob))
    }
    set((s) => ({
      folders,
      canvasItems,
      entries,
      settings,
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

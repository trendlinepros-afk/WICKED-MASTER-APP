import { create } from 'zustand'

export interface BrowserTab {
  id: string
  /**
   * URL the <webview> was mounted with. Stays fixed after mount (in-page
   * navigation goes through loadURL / history so React never remounts the
   * guest); null = start page, no webview yet.
   */
  src: string | null
  /** current URL as reported by navigation events */
  url: string | null
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export interface Bookmark {
  title: string
  url: string
  addedAt?: string
}

const newId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Address-bar input → URL: keep schemes, https:// bare domains, search the rest. */
export function normalizeInput(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s) || (!s.includes(' ') && /^\S+\.\S{2,}/.test(s)))
    return 'https://' + s
  return 'https://www.google.com/search?q=' + encodeURIComponent(s)
}

function makeTab(url: string | null): BrowserTab {
  return {
    id: newId(),
    src: url,
    url,
    title: url ? hostOf(url) : 'New Tab',
    loading: url !== null,
    canGoBack: false,
    canGoForward: false
  }
}

interface WebBrowserState {
  tabs: BrowserTab[]
  activeId: string | null
  bookmarks: Bookmark[]
  /** true once the saved session has been restored (gates session saving) */
  restored: boolean
  addTab: (url?: string | null) => string
  closeTab: (id: string) => void
  setActive: (id: string) => void
  updateTab: (id: string, patch: Partial<BrowserTab>) => void
  setBookmarks: (bookmarks: Bookmark[]) => void
  restoreSession: (urls: string[], activeUrl: string | null) => void
}

export const useWebBrowser = create<WebBrowserState>((set, get) => ({
  tabs: [],
  activeId: null,
  bookmarks: [],
  restored: false,

  addTab: (url = null) => {
    const tab = makeTab(url)
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }))
    return tab.id
  },

  closeTab: (id) => {
    const { tabs, activeId } = get()
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== id)
    if (next.length === 0) {
      const fresh = makeTab(null) // the strip always keeps one tab
      set({ tabs: [fresh], activeId: fresh.id })
      return
    }
    const nextActive =
      activeId === id ? next[Math.min(idx, next.length - 1)].id : activeId
    set({ tabs: next, activeId: nextActive })
  },

  setActive: (id) => {
    if (get().tabs.some((t) => t.id === id)) set({ activeId: id })
  },

  updateTab: (id, patch) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
  },

  setBookmarks: (bookmarks) => set({ bookmarks }),

  restoreSession: (urls, activeUrl) => {
    const tabs = urls.length > 0 ? urls.map((u) => makeTab(u)) : [makeTab(null)]
    const active = tabs.find((t) => t.url === activeUrl) ?? tabs[tabs.length - 1]
    set({ tabs, activeId: active.id, restored: true })
  }
}))

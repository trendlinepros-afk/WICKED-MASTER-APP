import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Chrome,
  ExternalLink,
  Globe,
  Home,
  Loader2,
  Plus,
  RotateCw,
  Star,
  X
} from 'lucide-react'
import { hostOf, normalizeInput, useWebBrowser, type Bookmark, type BrowserTab } from './store'

const ID = 'web-browser'
/** must match the partition ipc.ts scopes its popup handler to */
const PARTITION = 'persist:web-browser'
// Google sign-in (and others) refuse "embedded framework" user agents; present
// the plain Chrome UA this shell really is underneath.
const USER_AGENT = navigator.userAgent.replace(/\s(wicked\S*|electron)\/\S+/gi, '')

/** The <webview> methods this module uses (React's types only cover the tag). */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

interface ChromeStatus {
  chromeFound: boolean
  chromePath: string | null
  running: boolean
  browser: string | null
  port: number
  profileDir: string
  tabCount: number
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(channel, ...args)

export default function WebBrowser(): React.JSX.Element {
  const tabs = useWebBrowser((s) => s.tabs)
  const activeId = useWebBrowser((s) => s.activeId)
  const bookmarks = useWebBrowser((s) => s.bookmarks)
  const restored = useWebBrowser((s) => s.restored)
  const active = tabs.find((t) => t.id === activeId) ?? null

  const webviews = useRef(new Map<string, WebviewElement>())

  /* ------------------------- boot: session + bookmarks ------------------- */

  useEffect(() => {
    const st = useWebBrowser.getState()
    if (!st.restored) {
      void (async () => {
        const [bm, sess] = await Promise.all([
          invoke(`${ID}:bookmarks-get`) as Promise<{ bookmarks?: Bookmark[] }>,
          invoke(`${ID}:session-get`) as Promise<{ urls?: string[]; activeUrl?: string | null }>
        ])
        const cur = useWebBrowser.getState()
        if (bm.bookmarks) cur.setBookmarks(bm.bookmarks)
        if (!cur.restored) cur.restoreSession(sess.urls ?? [], sess.activeUrl ?? null)
      })()
    }
    // popups from page JS / target=_blank / MCP open-in-app arrive here
    const off = window.wicked.on(`${ID}:open-tab`, (url) => {
      if (typeof url === 'string') useWebBrowser.getState().addTab(url)
    })
    return off
  }, [])

  // persist the open-tab set (debounced) so the module reopens where it left off
  useEffect(() => {
    if (!restored) return
    const timer = setTimeout(() => {
      const urls = tabs
        .map((t) => t.url)
        .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u))
      void invoke(`${ID}:session-set`, { urls, activeUrl: active?.url ?? null })
    }, 600)
    return () => clearTimeout(timer)
  }, [tabs, active?.url, restored])

  /* ------------------------------ navigation ----------------------------- */

  const navigate = (tabId: string, rawInput: string): void => {
    const url = normalizeInput(rawInput)
    if (!url) return
    const st = useWebBrowser.getState()
    const tab = st.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const wv = webviews.current.get(tabId)
    if (wv && tab.src) {
      void wv.loadURL(url).catch(() => undefined)
      st.updateTab(tabId, { url, loading: true })
    } else {
      // start page → mount the webview at this URL
      st.updateTab(tabId, { src: url, url, loading: true, title: hostOf(url) })
    }
  }

  const wire = (el: WebviewElement, tabId: string): void => {
    const upd = (patch: Partial<BrowserTab>): void =>
      useWebBrowser.getState().updateTab(tabId, patch)
    el.addEventListener('did-start-loading', () => upd({ loading: true }))
    el.addEventListener('did-stop-loading', () =>
      upd({ loading: false, canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
    )
    const onNav = (e: Event): void => {
      const ev = e as Event & { url?: string }
      if (ev.url) upd({ url: ev.url, canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
    }
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('page-title-updated', (e: Event) => {
      const ev = e as Event & { title?: string }
      if (ev.title) upd({ title: ev.title })
    })
    el.addEventListener('did-fail-load', (e: Event) => {
      const ev = e as Event & { errorCode?: number; isMainFrame?: boolean }
      // -3 = navigation aborted (normal on redirects/stop)
      if (ev.isMainFrame && ev.errorCode !== -3) upd({ loading: false, title: 'Could not load page' })
    })
  }

  const attachRef =
    (tabId: string) =>
    (el: HTMLWebViewElement | null): void => {
      if (!el) {
        webviews.current.delete(tabId)
        return
      }
      const wv = el as unknown as WebviewElement
      webviews.current.set(tabId, wv)
      // ref callbacks re-fire every render; wire each guest exactly once
      if (wv.dataset.wbWired !== '1') {
        wv.dataset.wbWired = '1'
        wire(wv, tabId)
      }
    }

  /* -------------------------------- render ------------------------------- */

  if (!restored) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 className="animate-spin" size={22} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <TabStrip tabs={tabs} activeId={activeId} webviews={webviews} />
      <NavBar active={active} webviews={webviews} navigate={navigate} bookmarks={bookmarks} />
      {bookmarks.length > 0 && <BookmarksBar activeTab={active} navigate={navigate} />}
      <div className="relative min-h-0 flex-1 border-t border-edge bg-surface">
        {tabs.map((tab) =>
          tab.src ? (
            <webview
              key={tab.id}
              ref={attachRef(tab.id)}
              src={tab.src}
              partition={PARTITION}
              useragent={USER_AGENT}
              // popups are denied in main and re-routed to a new in-app tab
              allowpopups={true}
              className="absolute inset-0 h-full w-full"
              style={{ visibility: tab.id === activeId ? 'visible' : 'hidden' }}
            />
          ) : tab.id === activeId ? (
            <StartPage key={tab.id} tab={tab} navigate={navigate} />
          ) : null
        )}
      </div>
    </div>
  )
}

/* -------------------------------- tab strip ------------------------------- */

function TabStrip({
  tabs,
  activeId,
  webviews
}: {
  tabs: BrowserTab[]
  activeId: string | null
  webviews: React.MutableRefObject<Map<string, WebviewElement>>
}): React.JSX.Element {
  const setActive = useWebBrowser((s) => s.setActive)
  const closeTab = useWebBrowser((s) => s.closeTab)
  const addTab = useWebBrowser((s) => s.addTab)

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-2 pt-2">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          onClick={() => setActive(tab.id)}
          className={`group flex h-8 min-w-0 max-w-[220px] flex-1 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 border-edge px-3 text-xs ${
            tab.id === activeId ? 'bg-surface text-ink' : 'bg-raised/50 text-muted hover:text-ink'
          }`}
          title={tab.url ?? 'New Tab'}
        >
          {tab.loading ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
          ) : (
            <Globe size={12} className="shrink-0 opacity-60" />
          )}
          <span className="min-w-0 flex-1 truncate">{tab.title || 'New Tab'}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              webviews.current.delete(tab.id)
              closeTab(tab.id)
            }}
            className="shrink-0 rounded p-0.5 opacity-0 hover:bg-raised hover:text-danger group-hover:opacity-100"
            title="Close tab"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        onClick={() => addTab(null)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink"
        title="New tab"
      >
        <Plus size={15} />
      </button>
    </div>
  )
}

/* --------------------------------- nav bar -------------------------------- */

function NavBar({
  active,
  webviews,
  navigate,
  bookmarks
}: {
  active: BrowserTab | null
  webviews: React.MutableRefObject<Map<string, WebviewElement>>
  navigate: (tabId: string, rawInput: string) => void
  bookmarks: Bookmark[]
}): React.JSX.Element {
  const setBookmarks = useWebBrowser((s) => s.setBookmarks)
  const updateTab = useWebBrowser((s) => s.updateTab)
  const [addr, setAddr] = useState('')
  const addrRef = useRef<HTMLInputElement>(null)

  // follow the active tab unless the user is mid-edit in the address bar
  useEffect(() => {
    if (document.activeElement !== addrRef.current) setAddr(active?.url ?? '')
  }, [active?.id, active?.url])

  const wv = active ? webviews.current.get(active.id) : undefined
  const bookmarked = !!active?.url && bookmarks.some((b) => b.url === active.url)

  const toggleBookmark = async (): Promise<void> => {
    if (!active?.url || !/^https?:\/\//i.test(active.url)) return
    const res = (await invoke(
      bookmarked ? `${ID}:bookmark-remove` : `${ID}:bookmark-add`,
      bookmarked ? { url: active.url } : { url: active.url, title: active.title }
    )) as { ok?: boolean; bookmarks?: Bookmark[] }
    if (res.ok && res.bookmarks) setBookmarks(res.bookmarks)
  }

  const iconBtn =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted enabled:hover:bg-raised enabled:hover:text-ink disabled:opacity-30'

  return (
    <div className="flex items-center gap-1 border-t border-edge bg-surface px-2 py-1.5">
      <button className={iconBtn} disabled={!active?.canGoBack} onClick={() => wv?.goBack()} title="Back">
        <ArrowLeft size={15} />
      </button>
      <button
        className={iconBtn}
        disabled={!active?.canGoForward}
        onClick={() => wv?.goForward()}
        title="Forward"
      >
        <ArrowRight size={15} />
      </button>
      <button
        className={iconBtn}
        disabled={!active?.src}
        onClick={() => (active?.loading ? wv?.stop() : wv?.reload())}
        title={active?.loading ? 'Stop' : 'Reload'}
      >
        {active?.loading ? <X size={15} /> : <RotateCw size={14} />}
      </button>
      <button
        className={iconBtn}
        disabled={!active}
        onClick={() => {
          if (!active) return
          webviews.current.delete(active.id)
          updateTab(active.id, {
            src: null,
            url: null,
            title: 'New Tab',
            loading: false,
            canGoBack: false,
            canGoForward: false
          })
        }}
        title="Start page"
      >
        <Home size={14} />
      </button>

      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (active) navigate(active.id, addr)
          addrRef.current?.blur()
        }}
      >
        <input
          ref={addrRef}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder="Search Google or enter a URL"
          spellCheck={false}
          className="w-full rounded-full border border-edge bg-raised px-4 py-1.5 text-sm outline-none focus:border-accent"
        />
      </form>

      <button
        className={`${iconBtn} ${bookmarked ? 'text-warn' : ''}`}
        disabled={!active?.url}
        onClick={() => void toggleBookmark()}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
      >
        <Star size={15} fill={bookmarked ? 'currentColor' : 'none'} />
      </button>
      <button
        className={iconBtn}
        disabled={!active?.url}
        onClick={() => {
          if (active?.url) void invoke('shell:open-external', active.url)
        }}
        title="Open in system browser"
      >
        <ExternalLink size={14} />
      </button>

      <ChromePanel currentUrl={active?.url ?? null} />
    </div>
  )
}

/* ----------------------- Full Chrome control panel ------------------------ */

function ChromePanel({ currentUrl }: { currentUrl: string | null }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<ChromeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const res = (await invoke(`${ID}:status`)) as Partial<ChromeStatus> & { ok?: boolean }
    if (res.ok)
      setStatus({
        chromeFound: !!res.chromeFound,
        chromePath: res.chromePath ?? null,
        running: !!res.running,
        browser: res.browser ?? null,
        port: res.port ?? 0,
        profileDir: res.profileDir ?? '',
        tabCount: res.tabCount ?? 0
      })
  }

  useEffect(() => {
    void refresh()
  }, [])
  useEffect(() => {
    if (open) void refresh()
  }, [open])

  const launch = async (url?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = (await invoke(`${ID}:launch`, { url })) as { ok?: boolean; error?: string }
    if (!res.ok) setError(res.error ?? 'Launch failed.')
    await refresh()
    setBusy(false)
  }

  const locate = async (): Promise<void> => {
    setError(null)
    const res = (await invoke(`${ID}:set-chrome-path`)) as { ok?: boolean; error?: string }
    if (res.error) setError(res.error)
    await refresh()
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-2 rounded-lg border border-edge px-2.5 text-xs ${
          open ? 'bg-raised text-ink' : 'text-muted hover:bg-raised hover:text-ink'
        }`}
        title="Full Chrome — your extensions (incl. Claude) + automation"
      >
        <Chrome size={14} />
        <span
          className={`h-1.5 w-1.5 rounded-full ${status?.running ? 'bg-ok' : 'bg-muted/40'}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-20 w-96 rounded-xl border border-edge bg-surface p-4 shadow-xl">
          <div className="flex items-center gap-2">
            <Chrome size={16} className="text-accent" />
            <span className="text-sm font-semibold">Full Chrome</span>
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${
                status?.running ? 'bg-ok/15 text-ok' : 'bg-raised text-muted'
              }`}
            >
              {status?.running ? `Running · ${status.tabCount} tab(s)` : 'Not running'}
            </span>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-muted">
            Launches your real Google Chrome with a dedicated WICKED profile and a local
            automation port. Chrome extensions — including <b>Claude in Chrome</b> — and Chrome
            sync work there: sign into your Google account on first launch and your bookmarks and
            extensions follow. WICKED&apos;s MCP tools can then read, screenshot and drive those
            tabs. (Extensions can&apos;t run in the embedded browser — that&apos;s an Electron
            platform limit.)
          </p>

          {status && !status.chromeFound && (
            <p className="mt-3 rounded-lg bg-warn/10 p-2 text-xs text-warn">
              Google Chrome was not found on this machine.
            </p>
          )}
          {error && <p className="mt-3 rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => void launch()}
              disabled={busy || !status?.chromeFound}
              className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Chrome size={13} />}
              {status?.running ? 'Open Chrome window' : 'Launch Full Chrome'}
            </button>
            {currentUrl && (
              <button
                onClick={() => void launch(currentUrl)}
                disabled={busy || !status?.chromeFound}
                className="rounded-lg border border-edge px-3 py-1.5 text-xs text-ink hover:bg-raised disabled:opacity-40"
              >
                Open current page there
              </button>
            )}
            <button
              onClick={() => void locate()}
              className="rounded-lg border border-edge px-3 py-1.5 text-xs text-muted hover:bg-raised hover:text-ink"
            >
              Locate Chrome…
            </button>
          </div>

          {status && (
            <div className="mt-3 space-y-1 border-t border-edge pt-2 text-[11px] text-muted">
              <p className="truncate" title={status.chromePath ?? undefined}>
                Chrome: {status.chromePath ?? 'not found'}
              </p>
              <p className="truncate" title={status.profileDir}>
                Profile: {status.profileDir}
              </p>
              <p>Automation port: 127.0.0.1:{status.port}</p>
              {status.browser && <p>{status.browser}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------ bookmarks bar ----------------------------- */

function BookmarksBar({
  activeTab,
  navigate
}: {
  activeTab: BrowserTab | null
  navigate: (tabId: string, rawInput: string) => void
}): React.JSX.Element {
  const bookmarks = useWebBrowser((s) => s.bookmarks)
  const setBookmarks = useWebBrowser((s) => s.setBookmarks)
  const addTab = useWebBrowser((s) => s.addTab)

  const openBookmark = (url: string): void => {
    if (activeTab) navigate(activeTab.id, url)
    else addTab(url)
  }

  const remove = async (url: string): Promise<void> => {
    const res = (await invoke(`${ID}:bookmark-remove`, { url })) as {
      ok?: boolean
      bookmarks?: Bookmark[]
    }
    if (res.ok && res.bookmarks) setBookmarks(res.bookmarks)
  }

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-t border-edge bg-surface px-2 py-1">
      {bookmarks.map((b) => (
        <span
          key={b.url}
          className="group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-edge bg-raised/60 py-0.5 pl-2.5 pr-1.5 text-[11px] text-muted hover:text-ink"
          onClick={() => openBookmark(b.url)}
          title={b.url}
        >
          <Star size={10} className="text-warn" fill="currentColor" />
          <span className="max-w-[140px] truncate">{b.title}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void remove(b.url)
            }}
            className="rounded p-0.5 opacity-0 hover:text-danger group-hover:opacity-100"
            title="Remove bookmark"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

/* -------------------------------- start page ------------------------------ */

function StartPage({
  tab,
  navigate
}: {
  tab: BrowserTab
  navigate: (tabId: string, rawInput: string) => void
}): React.JSX.Element {
  const bookmarks = useWebBrowser((s) => s.bookmarks)

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-2xl">
        <div className="mt-8 flex items-center justify-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-raised text-accent">
            <Globe size={24} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Web Browser</h1>
        </div>
        <p className="mt-2 text-center text-sm text-muted">
          Type a URL or search above — or jump back into a bookmark.
        </p>

        {bookmarks.length > 0 && (
          <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {bookmarks.slice(0, 12).map((b) => (
              <button
                key={b.url}
                onClick={() => navigate(tab.id, b.url)}
                className="flex items-center gap-2 rounded-xl border border-edge bg-raised/50 px-3 py-2.5 text-left text-xs hover:border-accent"
                title={b.url}
              >
                <Star size={12} className="shrink-0 text-warn" fill="currentColor" />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{b.title}</span>
                  <span className="block truncate text-muted">{hostOf(b.url)}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-8 rounded-2xl border border-edge bg-raised/40 p-5">
          <div className="flex items-center gap-2">
            <Chrome size={16} className="text-accent" />
            <span className="text-sm font-semibold">Need your extensions? Use Full Chrome.</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Chrome extensions (like Claude in Chrome) and Chrome-sync bookmarks can&apos;t run
            inside this embedded view — open the <Chrome size={11} className="inline" /> panel in
            the toolbar to launch your real Chrome with the WICKED profile. AI agents connected to
            WICKED&apos;s MCP server can list, read, screenshot and drive those Chrome tabs.
          </p>
        </div>
      </div>
    </div>
  )
}

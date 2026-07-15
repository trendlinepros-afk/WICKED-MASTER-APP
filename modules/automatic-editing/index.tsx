/**
 * Automatic Editing — module entry (ported from the standalone Zirtola app's
 * App.tsx). Renders inside the WICKED shell viewport; the shell owns the
 * window, theme, menus, and updates. Internal navigation (Library / Media /
 * Editor / Shorts / Settings) stays module-local.
 */
import { useEffect } from 'react'
import { SHELL_IPC } from '@shared/types'
import { useStore } from './store'
import LibraryView from './views/LibraryView'
import MediaView from './views/MediaView'
import EditorView from './views/EditorView'
import SettingsView from './views/SettingsView'
import FirstRunView from './views/FirstRunView'
import RenderQueuePanel from './components/RenderQueuePanel'
import { api } from './lib/api'

export default function AutomaticEditing(): React.JSX.Element {
  const { view, setView, project, settings, closeProject, refreshProjects, refreshSettings, refreshJobs, upsertJob, applyProjectPush } =
    useStore()

  useEffect(() => {
    refreshProjects()
    refreshSettings()
    refreshJobs()
    const offQueue = api.onQueueEvent(upsertJob)
    const offProject = api.onProjectEvent(applyProjectPush)
    // Key presence (keysPresent / hosting.configured) derives from the shell
    // vault — refresh whenever keys change in Settings → API Keys.
    const offKeys = window.wicked.on(SHELL_IPC.apiKeysChanged, () => {
      refreshSettings()
    })
    return () => {
      offQueue()
      offProject()
      offKeys()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Undo/redo shortcuts while the module is mounted — but never hijack native
  // text-undo while the user is typing in an input/textarea/contenteditable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) useStore.getState().redo()
        else useStore.getState().undo()
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        useStore.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Wait for settings before deciding; then gate on first-run onboarding.
  if (!settings)
    return (
      <div className="h-full bg-bg flex items-center justify-center text-muted text-sm">
        Loading Automatic Editing…
      </div>
    )
  if (!settings.onboarded) return <FirstRunView />

  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      {/* Top bar (module-internal navigation) */}
      <header className="flex items-center gap-4 px-4 h-12 bg-surface border-b border-edge shrink-0">
        <button
          className="flex items-baseline gap-2 hover:opacity-90 transition-opacity"
          onClick={() => {
            closeProject()
            refreshProjects()
          }}
          title="Automatic Editing — AI Video Editor"
        >
          <span className="font-bold tracking-tight">
            Automatic <span className="text-accent">Editing</span>
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted hidden sm:inline">
            AI Video Editor
          </span>
        </button>
        {project && (
          <span className="text-sm text-muted truncate max-w-md">
            {project.name}
            {project.approved && <span className="ml-2 text-ok">✓ approved</span>}
          </span>
        )}
        <div className="flex-1" />
        <nav className="flex gap-1">
          {project && (
            <button className={navCls(view === 'media')} onClick={() => setView('media')}>
              Media
            </button>
          )}
          {project && (
            <button className={navCls(view === 'editor')} onClick={() => setView('editor')}>
              Editor
            </button>
          )}
          {project?.approved && (
            <button className={navCls(view === 'shorts')} onClick={() => setView('shorts')}>
              Shorts
            </button>
          )}
          <button className={navCls(view === 'settings')} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
      </header>

      <main className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          {view === 'library' && <LibraryView />}
          {view === 'media' && <MediaView />}
          {view === 'editor' && <EditorView />}
          {view === 'settings' && <SettingsView />}
          {view === 'shorts' && <EditorView shortsMode />}
        </div>
        <RenderQueuePanel />
      </main>
    </div>
  )
}

function navCls(active: boolean): string {
  return `px-3 py-1 rounded text-sm ${active ? 'bg-raised text-accent' : 'text-muted hover:text-ink'}`
}

import { Suspense, useEffect } from 'react'
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from 'react-router-dom'
import { ChevronLeft, Home as HomeIcon, Loader2 } from 'lucide-react'
import ActivityBar from './shell/ActivityBar'
import AddNewApp from './shell/AddNewApp'
import EditFolderModal from './shell/EditFolderModal'
import EditModuleModal from './shell/EditModuleModal'
import GroupView from './shell/GroupView'
import Home from './shell/Home'
import ModuleBoundary from './shell/ModuleBoundary'
import LockGate from './shell/LockGate'
import ModuleMenu from './shell/ModuleMenu'
import SettingsScreen from './shell/SettingsScreen'
import UpdateDialog from './shell/UpdateDialog'
import UpdateToast from './shell/UpdateToast'
import { moduleById } from './shell/registry'
import { effectiveName } from './shell/moduleView'
import { useSettings } from './stores/settings'
import { useUpdates } from './stores/updates'

function Spinner(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-muted">
      <Loader2 size={28} className="animate-spin" />
    </div>
  )
}

function ModuleHost(): React.JSX.Element {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const mod = moduleById(id)
  if (!mod) return <Navigate to="/" replace />
  const { Component } = mod
  // Back = wherever you came from (a folder, home); fresh deep links go home.
  const goBack = (): void => {
    if (location.key && location.key !== 'default') navigate(-1)
    else navigate('/')
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge bg-surface/70 px-1.5">
        <button
          onClick={goBack}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-muted hover:bg-raised hover:text-ink"
          title="Back"
        >
          <ChevronLeft size={14} /> Back
        </button>
        <button
          onClick={() => navigate('/')}
          className="flex items-center rounded-md p-1 text-muted hover:bg-raised hover:text-ink"
          title="Home"
        >
          <HomeIcon size={13} />
        </button>
        <span className="ml-1 truncate text-xs text-muted">{effectiveName(mod, overrides)}</span>
      </div>
      <div className="min-h-0 flex-1">
        <ModuleBoundary moduleId={id}>
          <Suspense fallback={<Spinner />}>
            <Component />
          </Suspense>
        </ModuleBoundary>
      </div>
    </div>
  )
}

/** A module rendered alone in its own window (no shell chrome). */
function StandaloneModule(): React.JSX.Element {
  const { id = '' } = useParams()
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const mod = moduleById(id)

  useEffect(() => {
    if (mod) document.title = `${effectiveName(mod, overrides)} — WICKED`
  }, [mod, overrides])

  if (!mod) {
    return <div className="flex h-full items-center justify-center text-muted">Module not found.</div>
  }
  const { Component } = mod
  return (
    <div className="h-full">
      <ModuleBoundary moduleId={id}>
        <Suspense fallback={<Spinner />}>
          <Component />
        </Suspense>
      </ModuleBoundary>
    </div>
  )
}

function AppRoutes(): React.JSX.Element {
  const location = useLocation()

  // Standalone module windows render just the module — no sidebar/dialogs.
  if (location.pathname.startsWith('/w/')) {
    return (
      <Routes>
        <Route path="/w/:id" element={<StandaloneModule />} />
      </Routes>
    )
  }

  return (
    <>
      <div className="flex h-full">
        <ActivityBar />
        <main className="min-w-0 flex-1 bg-bg">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/g/:groupId" element={<GroupView />} />
            <Route path="/m/:id" element={<ModuleHost />} />
            <Route path="/add-app" element={<AddNewApp />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <UpdateDialog />
      <UpdateToast />
      <ModuleMenu />
      <EditModuleModal />
      <EditFolderModal />
    </>
  )
}

export default function App(): React.JSX.Element {
  const load = useSettings((s) => s.load)
  const loaded = useSettings((s) => s.loaded)
  const initUpdates = useUpdates((s) => s.init)

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    return initUpdates()
  }, [initUpdates])

  if (!loaded) return <Spinner />

  // Standalone module windows are spawned by the already-unlocked shell, so they
  // don't re-prompt; the main window goes through the launch lock (if set).
  const isStandalone = window.location.hash.startsWith('#/w/')

  return (
    <HashRouter>
      {isStandalone ? (
        <AppRoutes />
      ) : (
        <LockGate>
          <AppRoutes />
        </LockGate>
      )}
    </HashRouter>
  )
}

import { Suspense, useEffect } from 'react'
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams
} from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import ActivityBar from './shell/ActivityBar'
import AddNewApp from './shell/AddNewApp'
import EditModuleModal from './shell/EditModuleModal'
import Home from './shell/Home'
import ModuleBoundary from './shell/ModuleBoundary'
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
  const mod = moduleById(id)
  if (!mod) return <Navigate to="/" replace />
  const { Component } = mod
  return (
    <ModuleBoundary moduleId={id}>
      <Suspense fallback={<Spinner />}>
        <Component />
      </Suspense>
    </ModuleBoundary>
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

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  )
}

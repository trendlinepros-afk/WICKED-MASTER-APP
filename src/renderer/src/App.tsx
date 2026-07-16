import { Suspense, useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import ActivityBar from './shell/ActivityBar'
import AddNewApp from './shell/AddNewApp'
import Home from './shell/Home'
import ModuleBoundary from './shell/ModuleBoundary'
import SettingsScreen from './shell/SettingsScreen'
import UpdateDialog from './shell/UpdateDialog'
import { moduleById } from './shell/registry'
import { useSettings } from './stores/settings'

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

export default function App(): React.JSX.Element {
  const load = useSettings((s) => s.load)
  const loaded = useSettings((s) => s.loaded)

  useEffect(() => {
    load()
  }, [load])

  if (!loaded) return <Spinner />

  return (
    <HashRouter>
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
    </HashRouter>
  )
}

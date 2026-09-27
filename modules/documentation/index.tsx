import { useEffect } from 'react'
import { CircleCheck, CircleX, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { useDocs } from './store'
import LockScreen from './components/LockScreen'
import Sidebar from './components/Sidebar'
import RecordList from './components/RecordList'
import RecordDetail from './components/RecordDetail'
import RecordEditor from './components/RecordEditor'
import SettingsView from './components/SettingsView'
import { ActivityView, Dashboard, Expirations } from './components/Views'

function Main(): React.JSX.Element {
  const view = useDocs((s) => s.view)
  switch (view.kind) {
    case 'dashboard':
      return <Dashboard />
    case 'list':
    case 'favorites':
    case 'archived':
    case 'search':
      return <RecordList />
    case 'record':
      return <RecordDetail />
    case 'edit':
      return <RecordEditor />
    case 'expirations':
      return <Expirations />
    case 'activity':
      return <ActivityView />
    case 'settings':
      return <SettingsView />
  }
}

export default function Documentation(): React.JSX.Element {
  const s = useDocs()

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void s.init().then((f) => {
      if (dead) f()
      else off = f
    })
    return () => {
      dead = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep the auto-lock timer honest: real user activity, not just IPC traffic
  useEffect(() => {
    const touch = (): void => s.touch()
    window.addEventListener('pointerdown', touch)
    window.addEventListener('keydown', touch)
    return () => {
      window.removeEventListener('pointerdown', touch)
      window.removeEventListener('keydown', touch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // first paint after unlock: load the overview
  useEffect(() => {
    if (s.status?.unlocked) s.go({ kind: 'dashboard' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.status?.unlocked])

  if (!s.status)
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    )
  if (!s.status.unlocked) return <LockScreen />

  return (
    <div className="flex h-full bg-bg">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {s.error && s.view.kind !== 'record' && s.view.kind !== 'edit' && (
          <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            <TriangleAlert size={14} /> <span className="flex-1">{s.error}</span>
            <button onClick={s.clearError}>
              <X size={14} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Main />
        </div>
      </main>

      {s.toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2 rounded-xl border bg-surface px-4 py-3 text-sm text-ink shadow-xl ${
            s.toast.kind === 'ok' ? 'border-ok/40' : s.toast.kind === 'warn' ? 'border-warn/40' : 'border-danger/40'
          }`}
        >
          {s.toast.kind === 'ok' ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" /> : s.toast.kind === 'warn' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-danger" />}
          <span className="flex-1">{s.toast.text}</span>
          <button className="text-muted hover:text-ink" onClick={() => useDocs.setState({ toast: null })}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

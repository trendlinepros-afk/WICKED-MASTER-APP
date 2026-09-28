import { useEffect } from 'react'
import { CircleCheck, CircleX, Clapperboard, Film, LoaderCircle, MonitorPlay, Settings, TriangleAlert, X } from 'lucide-react'
import { useRec, type Tab } from './store'
import SessionView from './components/SessionView'
import RenderView from './components/RenderView'
import HistoryView from './components/HistoryView'
import SettingsView from './components/SettingsView'
import { Keys } from './components/ui'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'session', label: 'Session', icon: <MonitorPlay size={15} /> },
  { id: 'render', label: 'Complete & render', icon: <Clapperboard size={15} /> },
  { id: 'videos', label: 'Finished videos', icon: <Film size={15} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={15} /> }
]

export default function ScreenRec(): React.JSX.Element {
  const s = useRec()
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

  if (!s.ready)
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    )

  const phase = s.rec?.phase ?? 'idle'
  const recording = phase === 'recording' || phase === 'stopping'
  const clips = s.session?.clips.length ?? 0
  const rendering = !!s.job && (s.job.phase === 'preparing' || s.job.phase === 'clips' || s.job.phase === 'mixing')

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface">
        <div className="flex items-center gap-2 px-4 pb-3 pt-5">
          <MonitorPlay size={20} className="text-accent" />
          <span className="text-base font-bold text-ink">ScreenRec</span>
        </div>
        <nav className="space-y-0.5 px-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => s.setTab(t.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${s.tab === t.id ? 'bg-accent/15 font-medium text-accent' : 'text-ink/85 hover:bg-raised hover:text-ink'}`}
            >
              <span className={s.tab === t.id ? 'text-accent' : 'text-muted'}>{t.icon}</span>
              <span className="flex-1">{t.label}</span>
              {t.id === 'session' && recording && <span className="h-2 w-2 animate-pulse rounded-full bg-danger" />}
              {t.id === 'session' && !recording && clips > 0 && <span className="rounded-md bg-raised px-1.5 text-[11px] text-muted">{clips}</span>}
              {t.id === 'render' && rendering && <LoaderCircle size={12} className="animate-spin text-accent" />}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1.5 p-3 text-[11px] text-muted">
          <div className="flex items-center gap-1.5">
            <Keys accel={s.hotkey.accelerator} /> {recording ? 'stops' : 'records'}
          </div>
          <div className={s.hotkey.registered ? 'text-ok' : 'text-warn'}>{s.hotkey.registered ? '● hotkey active' : s.hotkey.enabled ? '● hotkey not active' : '● hotkey off'}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {s.tab === 'session' && <SessionView />}
        {s.tab === 'render' && <RenderView />}
        {s.tab === 'videos' && <HistoryView />}
        {s.tab === 'settings' && <SettingsView />}
      </main>
      {s.toast && (
        <div className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2 rounded-xl border bg-surface px-4 py-3 text-sm text-ink shadow-xl ${s.toast.kind === 'ok' ? 'border-ok/40' : s.toast.kind === 'warn' ? 'border-warn/40' : 'border-danger/40'}`}>
          {s.toast.kind === 'ok' ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" /> : s.toast.kind === 'warn' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-danger" />}
          <span className="flex-1">{s.toast.text}</span>
          <button className="text-muted hover:text-ink" onClick={() => useRec.setState({ toast: null })}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

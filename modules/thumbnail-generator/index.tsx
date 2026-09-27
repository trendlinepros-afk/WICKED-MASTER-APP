import { useEffect } from 'react'
import { CircleCheck, CircleX, History, ImagePlus, LoaderCircle, Settings, Sparkles, TriangleAlert, UserRound, Wrench, X } from 'lucide-react'
import { useThumbs, type Tab } from './store'
import Create from './components/Create'
import Library from './components/Library'
import Tools from './components/Tools'
import HistoryView from './components/HistoryView'
import SettingsView from './components/SettingsView'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'create', label: 'Create', icon: <Sparkles size={15} /> },
  { id: 'library', label: 'Personas & themes', icon: <UserRound size={15} /> },
  { id: 'tools', label: 'Score · Titles · Edit', icon: <Wrench size={15} /> },
  { id: 'history', label: 'History', icon: <History size={15} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={15} /> }
]

export default function ThumbnailGenerator(): React.JSX.Element {
  const s = useThumbs()
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

  const training = s.library.filter((i) => i.status === 'processing').length
  const running = s.job && !s.job.done

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-56 shrink-0 flex-col border-r border-edge bg-surface">
        <div className="flex items-center gap-2 px-4 pb-3 pt-5">
          <ImagePlus size={20} className="text-accent" />
          <span className="text-base font-bold text-ink">Thumbnails</span>
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
              {t.id === 'library' && training > 0 && <LoaderCircle size={12} className="animate-spin text-warn" />}
              {t.id === 'create' && running && <LoaderCircle size={12} className="animate-spin text-accent" />}
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-1 p-3 text-[11px] text-muted">
          <div>Powered by Pikzels</div>
          <div>{s.hasKey ? 'API key: set' : 'API key: missing'}</div>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {s.tab === 'create' && <Create />}
        {s.tab === 'library' && <Library />}
        {s.tab === 'tools' && <Tools />}
        {s.tab === 'history' && <HistoryView />}
        {s.tab === 'settings' && <SettingsView />}
      </main>
      {s.toast && (
        <div className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2 rounded-xl border bg-surface px-4 py-3 text-sm text-ink shadow-xl ${s.toast.kind === 'ok' ? 'border-ok/40' : s.toast.kind === 'warn' ? 'border-warn/40' : 'border-danger/40'}`}>
          {s.toast.kind === 'ok' ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-ok" /> : s.toast.kind === 'warn' ? <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" /> : <CircleX size={16} className="mt-0.5 shrink-0 text-danger" />}
          <span className="flex-1">{s.toast.text}</span>
          <button className="text-muted hover:text-ink" onClick={() => useThumbs.setState({ toast: null })}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

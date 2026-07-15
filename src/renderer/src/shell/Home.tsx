import { Link } from 'react-router-dom'
import { modules } from './registry'
import { useSettings } from '@/stores/settings'
import ModuleIcon from './ModuleIcon'

export default function Home(): React.JSX.Element {
  const disabled = useSettings((s) => s.settings.disabledModules)
  const visible = modules.filter((m) => !disabled.includes(m.manifest.id))

  return (
    <div className="h-full overflow-y-auto p-10">
      <h1 className="text-2xl font-bold tracking-tight">WICKED</h1>
      <p className="mt-1 text-sm text-muted">
        {visible.length === 0
          ? 'No modules installed yet. Drop a module folder into /modules and rebuild.'
          : `${visible.length} module${visible.length === 1 ? '' : 's'} available`}
      </p>

      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {visible.map(({ manifest }) => (
          <Link
            key={manifest.id}
            to={`/m/${manifest.id}`}
            className="group rounded-xl border border-edge bg-surface p-5 transition-colors hover:border-accent/60"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
                <ModuleIcon name={manifest.icon} size={20} strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 truncate font-semibold">
                  {manifest.name}
                  {manifest.status === 'beta' && (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                      Beta
                    </span>
                  )}
                  {manifest.status === 'external' && (
                    <span className="rounded bg-muted/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">
                      External
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted">v{manifest.version}</div>
              </div>
            </div>
            <p className="mt-3 line-clamp-2 text-sm text-muted">{manifest.description}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}

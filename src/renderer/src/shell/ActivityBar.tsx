import { NavLink } from 'react-router-dom'
import { Settings } from 'lucide-react'
import { modules } from './registry'
import { useSettings } from '@/stores/settings'
import ModuleIcon from './ModuleIcon'

export default function ActivityBar(): React.JSX.Element {
  const disabled = useSettings((s) => s.settings.disabledModules)
  const visible = modules.filter((m) => !disabled.includes(m.manifest.id))

  return (
    <nav className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface py-2">
      <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-sm font-black tracking-tighter text-accent-ink">
        W
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {visible.map(({ manifest }) => (
          <NavLink
            key={manifest.id}
            to={`/m/${manifest.id}`}
            title={`${manifest.name}${manifest.status === 'beta' ? ' (Beta)' : ''}`}
            className={({ isActive }) =>
              `relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                isActive
                  ? 'bg-raised text-accent'
                  : 'text-muted hover:bg-raised/70 hover:text-ink'
              }`
            }
          >
            <ModuleIcon name={manifest.icon} size={21} strokeWidth={1.8} />
            {manifest.status === 'beta' && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
            )}
          </NavLink>
        ))}
      </div>

      <NavLink
        to="/settings"
        title="Settings"
        className={({ isActive }) =>
          `flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
            isActive ? 'bg-raised text-accent' : 'text-muted hover:bg-raised/70 hover:text-ink'
          }`
        }
      >
        <Settings size={21} strokeWidth={1.8} />
      </NavLink>
    </nav>
  )
}

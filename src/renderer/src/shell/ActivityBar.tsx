import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  DownloadCloud,
  Loader2,
  PackagePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Settings
} from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import { useUpdates } from '@/stores/updates'
import ModuleIcon from './ModuleIcon'
import { effectiveName, orderedModules, reorderIds } from './moduleView'

/** Shared row styling for collapsed (icon-only) vs expanded (icon + label). */
function rowClass(isActive: boolean, expanded: boolean): string {
  const state = isActive
    ? 'bg-raised text-accent'
    : 'text-muted hover:bg-raised/70 hover:text-ink'
  const shape = expanded ? 'h-10 w-full gap-3 px-3' : 'h-10 w-10 justify-center'
  return `relative flex items-center rounded-lg transition-colors ${state} ${shape}`
}

export default function ActivityBar(): React.JSX.Element {
  const disabled = useSettings((s) => s.settings.disabledModules)
  const expanded = useSettings((s) => s.settings.navExpanded)
  const order = useSettings((s) => s.settings.moduleOrder)
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const update = useSettings((s) => s.update)
  const checkForUpdates = useUpdates((s) => s.check)
  const updatePhase = useUpdates((s) => s.phase)
  const checking = updatePhase === 'checking' || updatePhase === 'available'
  const { openMenu, dragId, setDragId } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const all = orderedModules(order, overrides)
  const visible = all.filter((m) => !disabled.includes(m.manifest.id))

  const commitReorder = (targetId: string): void => {
    if (dragId && dragId !== targetId) {
      update({ moduleOrder: reorderIds(all.map((m) => m.manifest.id), dragId, targetId) })
    }
    setDragId(null)
    setDropTarget(null)
  }

  return (
    <nav
      className={`flex h-full shrink-0 flex-col border-r border-edge bg-surface px-2 py-2 transition-[width] duration-200 ${
        expanded ? 'w-56' : 'w-14'
      }`}
    >
      {/* Home / brand button */}
      <NavLink
        to="/"
        end
        title="Home"
        className={({ isActive }) => `${rowClass(isActive, expanded)} mb-1`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-black tracking-tighter text-accent-ink">
          W
        </span>
        {expanded && <span className="truncate text-[15px] font-bold tracking-tight text-ink">WICKED</span>}
      </NavLink>

      {/* Expand / collapse toggle */}
      <button
        onClick={() => update({ navExpanded: !expanded })}
        title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        className={`${rowClass(false, expanded)} mb-1 shrink-0`}
      >
        {expanded ? <PanelLeftClose size={20} strokeWidth={1.8} /> : <PanelLeftOpen size={20} strokeWidth={1.8} />}
        {expanded && <span className="truncate text-sm">Collapse</span>}
      </button>

      <div className="my-1 h-px shrink-0 bg-edge" />

      {/* Modules — drag to reorder, right-click for options */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden">
        {visible.map((m) => {
          const { manifest } = m
          const id = manifest.id
          const name = effectiveName(m, overrides)
          return (
            <NavLink
              key={id}
              to={`/m/${id}`}
              draggable
              onDragStart={(e) => {
                setDragId(id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragId && dragId !== id) setDropTarget(id)
              }}
              onDragLeave={() => setDropTarget((t) => (t === id ? null : t))}
              onDrop={(e) => {
                e.preventDefault()
                commitReorder(id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setDropTarget(null)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(id, e.clientX, e.clientY)
              }}
              title={expanded ? undefined : `${name}${manifest.status === 'beta' ? ' (Beta)' : ''}`}
              className={({ isActive }) =>
                `${rowClass(isActive, expanded)} ${dropTarget === id ? 'ring-1 ring-accent' : ''} ${
                  dragId === id ? 'opacity-40' : ''
                }`
              }
            >
              <ModuleIcon name={manifest.icon} size={20} strokeWidth={1.8} className="shrink-0" />
              {expanded && <span className="min-w-0 flex-1 truncate text-sm">{name}</span>}
              {manifest.status === 'beta' &&
                (expanded ? (
                  <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                    Beta
                  </span>
                ) : (
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn" />
                ))}
            </NavLink>
          )
        })}
      </div>

      <div className="my-1 h-px shrink-0 bg-edge" />

      {/* Check for Updates */}
      <button
        onClick={() => checkForUpdates()}
        disabled={checking}
        title={expanded ? undefined : 'Check for Updates'}
        className={`${rowClass(false, expanded)} shrink-0 disabled:opacity-60`}
      >
        {checking ? (
          <Loader2 size={20} strokeWidth={1.8} className="shrink-0 animate-spin" />
        ) : (
          <DownloadCloud size={20} strokeWidth={1.8} className="shrink-0" />
        )}
        {expanded && (
          <span className="truncate text-sm">
            {checking ? 'Checking…' : 'Check for Updates'}
          </span>
        )}
      </button>

      {/* Add New App */}
      <NavLink
        to="/add-app"
        title={expanded ? undefined : 'Add New App'}
        className={({ isActive }) => `${rowClass(isActive, expanded)} shrink-0`}
      >
        <PackagePlus size={20} strokeWidth={1.8} className="shrink-0" />
        {expanded && <span className="truncate text-sm">Add New App</span>}
      </NavLink>

      {/* Settings */}
      <NavLink
        to="/settings"
        title={expanded ? undefined : 'Settings'}
        className={({ isActive }) => `${rowClass(isActive, expanded)} shrink-0`}
      >
        <Settings size={20} strokeWidth={1.8} className="shrink-0" />
        {expanded && <span className="truncate text-sm">Settings</span>}
      </NavLink>
    </nav>
  )
}

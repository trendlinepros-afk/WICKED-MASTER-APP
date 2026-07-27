import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
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
import { BrandLogo, BrandMark } from './BrandLogo'
import ModuleIcon from './ModuleIcon'
import { effectiveName, groupDragToken, navEntries, orderedModules, reorderNav } from './moduleView'

/** Shared row styling for collapsed (icon-only) vs expanded (icon + label). */
function rowClass(isActive: boolean, expanded: boolean): string {
  const state = isActive
    ? 'bg-raised text-accent'
    : 'text-muted hover:bg-raised/70 hover:text-ink'
  const shape = expanded ? 'h-10 w-full gap-3 px-3' : 'h-10 w-10 justify-center'
  return `relative flex items-center rounded-lg transition-colors ${state} ${shape}`
}

export default function ActivityBar(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const { disabledModules: disabled, navExpanded: expanded, moduleOrder: order, moduleOverrides: overrides } = settings
  const update = useSettings((s) => s.update)
  const checkForUpdates = useUpdates((s) => s.check)
  const updatePhase = useUpdates((s) => s.phase)
  const checking = updatePhase === 'checking' || updatePhase === 'available'
  const { openMenu, dragId, setDragId } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const location = useLocation()
  // folders the user has manually expanded (the active one auto-expands)
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({})

  const all = orderedModules(order, overrides)
  const entries = navEntries(settings, { sidebar: true })
  const activeModuleId = location.pathname.startsWith('/m/')
    ? decodeURIComponent(location.pathname.slice(4))
    : ''
  const activeGroupId = location.pathname.startsWith('/g/')
    ? decodeURIComponent(location.pathname.slice(4))
    : ''

  const commitReorder = (targetToken: string): void => {
    if (dragId && dragId !== targetToken) {
      const next = reorderNav(settings, dragId, targetToken)
      if (next) update({ moduleOrder: next })
    }
    setDragId(null)
    setDropTarget(null)
  }

  /** One module row (used at top level and nested inside a folder). */
  const moduleRow = (
    m: (typeof all)[number],
    opts: { nested?: boolean } = {}
  ): React.JSX.Element => {
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
          } ${opts.nested && expanded ? 'ml-3 w-[calc(100%-0.75rem)]' : ''}`
        }
      >
        <ModuleIcon name={manifest.icon} size={opts.nested ? 18 : 20} strokeWidth={1.8} className="shrink-0" />
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
        {expanded ? <BrandLogo markSize={30} /> : <BrandMark size={30} />}
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

      {/* Modules & folders — drag to reorder, right-click for options */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden">
        {entries.map((e) => {
          if (e.kind === 'module') return moduleRow(e.module)

          // A folder: opens its own screen, and reveals its tools inline while
          // you're working inside it (or when manually expanded).
          const g = e.group
          const token = groupDragToken(g.id)
          const holdsActive = e.modules.some((m) => m.manifest.id === activeModuleId)
          const isActive = activeGroupId === g.id
          const showChildren = openFolders[g.id] ?? (isActive || holdsActive)
          return (
            <div key={`g:${g.id}`} className="flex flex-col gap-1">
              <div className="relative flex items-center">
                <NavLink
                  to={`/g/${g.id}`}
                  draggable
                  onDragStart={(e2) => {
                    setDragId(token)
                    e2.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e2) => {
                    e2.preventDefault()
                    if (dragId && dragId !== token) setDropTarget(token)
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === token ? null : t))}
                  onDrop={(e2) => {
                    e2.preventDefault()
                    commitReorder(token)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setDropTarget(null)
                  }}
                  title={expanded ? undefined : `${g.name} (folder)`}
                  className={`${rowClass(isActive || holdsActive, expanded)} min-w-0 flex-1 ${
                    dropTarget === token ? 'ring-1 ring-accent' : ''
                  } ${dragId === token ? 'opacity-40' : ''}`}
                >
                  <ModuleIcon name={g.icon} size={20} strokeWidth={1.8} className="shrink-0 text-warn" />
                  {expanded && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted">
                        {e.modules.length}
                      </span>
                    </>
                  )}
                  {!expanded && (
                    <span className="absolute bottom-0.5 right-1 text-[9px] font-bold tabular-nums text-muted">
                      {e.modules.length}
                    </span>
                  )}
                </NavLink>
                {expanded && (
                  <button
                    onClick={() => setOpenFolders((f) => ({ ...f, [g.id]: !showChildren }))}
                    title={showChildren ? 'Collapse folder' : 'Expand folder'}
                    className="ml-0.5 flex h-10 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
                  >
                    {showChildren ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                )}
              </div>
              {showChildren && e.modules.map((m) => moduleRow(m, { nested: true }))}
            </div>
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

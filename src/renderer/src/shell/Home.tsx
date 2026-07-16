import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import { effectiveDescription, effectiveName, orderedModules, reorderIds } from './moduleView'

export default function Home(): React.JSX.Element {
  const disabled = useSettings((s) => s.settings.disabledModules)
  const order = useSettings((s) => s.settings.moduleOrder)
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { openMenu, openEdit, dragId, setDragId } = useShellUi()
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
    <div className="h-full overflow-y-auto p-10">
      <h1 className="text-2xl font-bold tracking-tight">WICKED</h1>
      <p className="mt-1 text-sm text-muted">
        {visible.length === 0
          ? 'No modules installed yet. Drop a module folder into /modules and rebuild.'
          : `${visible.length} module${visible.length === 1 ? '' : 's'} available · drag to reorder · right-click for options`}
      </p>

      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {visible.map((m) => {
          const { manifest } = m
          const id = manifest.id
          return (
            <div
              key={id}
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
              onClick={() => navigate(`/m/${id}`)}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(id, e.clientX, e.clientY)
              }}
              className={`group relative cursor-pointer rounded-xl border bg-surface p-5 transition-colors hover:border-accent/60 ${
                dropTarget === id ? 'border-accent' : 'border-edge'
              } ${dragId === id ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
                  <ModuleIcon name={manifest.icon} size={20} strokeWidth={1.8} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 truncate font-semibold">
                    {effectiveName(m, overrides)}
                    {manifest.status === 'beta' && (
                      <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                        Beta
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted">v{manifest.version}</div>
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-muted">
                {effectiveDescription(m, overrides)}
              </p>

              {/* pencil — edit name & description */}
              <button
                title="Edit name & description"
                onClick={(e) => {
                  e.stopPropagation()
                  openEdit(id)
                }}
                className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:opacity-100"
              >
                <Pencil size={14} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Pencil } from 'lucide-react'
import type { ShellSettings } from '@shared/types'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import type { RegisteredModule } from './registry'
import { effectiveDescription, effectiveName, groupDragToken, isGroupDrag } from './moduleView'

/**
 * One module tile — used by both the Home grid and a group ("folder") view, so
 * the two can never drift apart. Drag-to-reorder, right-click menu and the
 * inline edit pencil all live here.
 */
export function ModuleCard({
  m,
  overrides,
  dropTarget,
  setDropTarget,
  commitReorder
}: {
  m: RegisteredModule
  overrides: ShellSettings['moduleOverrides']
  dropTarget: string | null
  setDropTarget: (fn: (t: string | null) => string | null) => void
  commitReorder: (targetId: string) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const { openMenu, openEdit, dragId, setDragId } = useShellUi()
  const { manifest } = m
  const id = manifest.id

  return (
    <div
      draggable
      onDragStart={(e) => {
        setDragId(id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (dragId && dragId !== id) setDropTarget(() => id)
      }}
      onDragLeave={() => setDropTarget((t) => (t === id ? null : t))}
      onDrop={(e) => {
        e.preventDefault()
        commitReorder(id)
      }}
      onDragEnd={() => {
        setDragId(null)
        setDropTarget(() => null)
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
      <p className="mt-3 line-clamp-2 text-sm text-muted">{effectiveDescription(m, overrides)}</p>

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
}

/**
 * A folder tile: opens /g/<id>, renames via the pencil, drags to reorder (its
 * members move as one block), and accepts a dragged module card as "file this
 * tool into the folder" — or a dragged folder as "drop the folder here".
 */
export function GroupCard({
  group,
  count,
  onOpen,
  onRename,
  onDropModule,
  commitReorder
}: {
  group: { id: string; name: string; icon: string; description?: string }
  count: number
  onOpen: () => void
  onRename: () => void
  onDropModule?: (moduleId: string) => void
  commitReorder?: (targetToken: string) => void
}): React.JSX.Element {
  const { dragId, setDragId } = useShellUi()
  const [over, setOver] = useState(false)
  const token = groupDragToken(group.id)
  const groupDrag = isGroupDrag(dragId)
  const canAccept = Boolean(dragId && dragId !== token && (groupDrag ? commitReorder : onDropModule))

  return (
    <div
      draggable
      onDragStart={(e) => {
        setDragId(token)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => {
        setDragId(null)
        setOver(false)
      }}
      onClick={onOpen}
      onDragOver={(e) => {
        if (!canAccept) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!canAccept || !dragId) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        if (isGroupDrag(dragId)) commitReorder?.(token)
        else onDropModule?.(dragId)
        setDragId(null)
      }}
      className={`group relative cursor-pointer rounded-xl border bg-surface p-5 transition-colors ${
        over ? 'border-warn ring-2 ring-warn/40' : 'border-edge hover:border-warn/60'
      } ${dragId === token ? 'opacity-40' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-warn/15 text-warn">
          <ModuleIcon name={group.icon} size={20} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className="truncate font-semibold">{group.name}</div>
          <div className="truncate text-xs font-medium text-warn">
            Folder · {count} tool{count === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-sm text-muted">
        {over
          ? groupDrag
            ? 'Drop to move the folder here'
            : 'Drop to move it into this folder'
          : (group.description ?? `Open the ${group.name} folder`)}
      </p>

      <button
        title="Rename folder"
        onClick={(e) => {
          e.stopPropagation()
          onRename()
        }}
        className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-raised hover:text-ink group-hover:opacity-100"
      >
        <Pencil size={14} />
      </button>
    </div>
  )
}

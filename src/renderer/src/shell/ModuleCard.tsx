import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Folder, Pencil } from 'lucide-react'
import type { CardSize, ShellSettings } from '@shared/types'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import type { RegisteredModule } from './registry'
import {
  cardSpec,
  effectiveDescription,
  effectiveName,
  GROUP_DRAG_PREFIX,
  groupDragToken,
  isGroupDrag,
  moduleColor
} from './moduleView'

/**
 * One module tile — used by both the Home grid and a group ("folder") view, so
 * the two can never drift apart. Drag-to-reorder, right-click menu, the inline
 * edit pencil, per-app color and the chosen tile size all live here.
 */
export function ModuleCard({
  m,
  overrides,
  dropTarget,
  setDropTarget,
  commitReorder,
  size
}: {
  m: RegisteredModule
  overrides: ShellSettings['moduleOverrides']
  dropTarget: string | null
  setDropTarget: (fn: (t: string | null) => string | null) => void
  commitReorder: (targetId: string) => void
  size?: CardSize
}): React.JSX.Element {
  const navigate = useNavigate()
  const { openMenu, openEdit, dragId, setDragId } = useShellUi()
  const { manifest } = m
  const id = manifest.id
  const spec = cardSpec(size)
  const color = moduleColor(id, overrides)
  const isDrop = dropTarget === id

  // A chosen color tints the tile; the drop-target highlight (accent) always
  // wins so filing/reordering stays legible.
  const tileStyle: React.CSSProperties = {}
  if (color && !isDrop) {
    tileStyle.borderColor = color
    tileStyle.backgroundColor = `${color}14`
  }

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
      style={tileStyle}
      className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-surface ${spec.pad} transition-colors hover:border-accent/60 ${
        isDrop ? 'border-accent' : 'border-edge'
      } ${dragId === id ? 'opacity-40' : ''}`}
    >
      {color && <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />}
      <div className={`flex items-center ${spec.inner}`}>
        <span
          className={`flex ${spec.chip} items-center justify-center rounded-lg ${color ? '' : 'bg-raised text-accent'}`}
          style={color ? { backgroundColor: `${color}26`, color } : undefined}
        >
          <ModuleIcon name={manifest.icon} size={spec.icon} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className={`flex items-center gap-2 truncate font-semibold ${spec.name}`}>
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

      {/* pencil — edit name, description & color */}
      <button
        title="Edit name, description & color"
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
 * A folder tile: opens /g/<id>, renames via the pencil, and accepts a dragged
 * module card as "file this tool into the folder" — or a dragged folder as
 * "nest that folder inside this one". Folders always stay yellow (the `warn`
 * token) so they never look like a colored app tile.
 */
export function GroupCard({
  group,
  count,
  folderCount = 0,
  onOpen,
  onRename,
  onDropModule,
  onNestFolder,
  size
}: {
  group: { id: string; name: string; icon: string; description?: string }
  count: number
  folderCount?: number
  onOpen: () => void
  onRename: () => void
  onDropModule?: (moduleId: string) => void
  onNestFolder?: (draggedGroupId: string) => void
  size?: CardSize
}): React.JSX.Element {
  const { dragId, setDragId } = useShellUi()
  const [over, setOver] = useState(false)
  const spec = cardSpec(size)
  const token = groupDragToken(group.id)
  const groupDrag = isGroupDrag(dragId)
  const canAccept = Boolean(dragId && dragId !== token && (groupDrag ? onNestFolder : onDropModule))

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
        if (isGroupDrag(dragId)) onNestFolder?.(dragId.slice(GROUP_DRAG_PREFIX.length))
        else onDropModule?.(dragId)
        setDragId(null)
      }}
      className={`group relative cursor-pointer overflow-hidden rounded-xl border bg-surface ${spec.pad} transition-colors ${
        over ? 'border-warn ring-2 ring-warn/40' : 'border-edge hover:border-warn/60'
      } ${dragId === token ? 'opacity-40' : ''}`}
    >
      <div className={`flex items-center ${spec.inner}`}>
        <span className={`flex ${spec.chip} items-center justify-center rounded-lg bg-warn/15 text-warn`}>
          <ModuleIcon name={group.icon} size={spec.icon} strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className={`truncate font-semibold ${spec.name}`}>{group.name}</div>
          <div className="flex items-center gap-1.5 truncate text-xs font-medium text-warn">
            <Folder size={11} className="shrink-0" />
            {count} tool{count === 1 ? '' : 's'}
            {folderCount > 0 && ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 text-sm text-muted">
        {over
          ? groupDrag
            ? 'Drop to nest this folder inside'
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

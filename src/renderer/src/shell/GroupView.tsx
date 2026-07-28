import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, FolderPlus, Home as HomeIcon, Pencil } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import { GroupCard, ModuleCard } from './ModuleCard'
import {
  cardGridStyle,
  cardSpec,
  descendantGroupIds,
  groupById,
  groupPath,
  orderedModules,
  reorderIds,
  scopeSections
} from './moduleView'

/**
 * A folder screen. Same layout as Home, applied recursively: sub-folders on top
 * under "Folders", the folder's own tools below under "Misc Tools". Reached from
 * the nav or a folder card at /g/<groupId>.
 */
export default function GroupView(): React.JSX.Element {
  const { groupId = '' } = useParams()
  const settings = useSettings((s) => s.settings)
  const { moduleOverrides: overrides, cardSize } = settings
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { dragId, setDragId, openFolderRename, openFolderCreate } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const group = groupById(groupId, settings)
  if (!group) return <Navigate to="/" replace />

  const { folders, modules } = scopeSections(groupId, settings)
  const trail = groupPath(groupId, settings).slice(0, -1) // ancestors above this folder
  const spec = cardSpec(cardSize)

  // Reordering uses the global module order (group membership comes from the
  // manifest / overrides, not the order), so dropping a card only moves it.
  const commitReorder = (targetId: string): void => {
    if (dragId && dragId !== targetId) {
      update({
        moduleOrder: reorderIds(
          orderedModules(settings.moduleOrder, overrides).map((m) => m.manifest.id),
          dragId,
          targetId
        )
      })
    }
    setDragId(null)
    setDropTarget(null)
  }

  const moveToFolder = (moduleId: string, gid: string): void => {
    update({ moduleGroupOverrides: { ...settings.moduleGroupOverrides, [moduleId]: gid } })
  }

  const nestFolder = (draggedId: string, newParent: string): void => {
    if (draggedId === newParent) return
    if (!settings.customGroups.some((g) => g.id === draggedId)) return
    if (descendantGroupIds(draggedId, settings).has(newParent)) return
    update({
      customGroups: settings.customGroups.map((g) =>
        g.id === draggedId ? { ...g, parent: newParent } : g
      )
    })
    setDragId(null)
  }

  return (
    <div className="h-full overflow-y-auto p-10">
      {/* breadcrumb */}
      <div className="mb-5 flex flex-wrap items-center gap-1.5 text-sm text-muted">
        <button onClick={() => navigate('/')} className="flex items-center gap-1.5 hover:text-ink">
          <HomeIcon size={14} /> All apps
        </button>
        {trail.map((g) => (
          <span key={g.id} className="flex items-center gap-1.5">
            <ChevronRight size={13} className="opacity-60" />
            <button onClick={() => navigate(`/g/${g.id}`)} className="truncate hover:text-ink">
              {g.name}
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-warn/15 text-warn">
            <ModuleIcon name={group.icon} size={24} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-bold tracking-tight">{group.name}</h1>
              <button
                onClick={() => openFolderRename(group.id)}
                title="Rename folder"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
              >
                <Pencil size={14} />
              </button>
            </div>
            <p className="text-sm text-muted">
              {modules.length === 0 && folders.length === 0
                ? 'Empty folder — drag a tool onto it from the home screen, add a sub-folder, or use a tool’s right-click menu.'
                : `${modules.length} tool${modules.length === 1 ? '' : 's'}${folders.length > 0 ? ` · ${folders.length} sub-folder${folders.length === 1 ? '' : 's'}` : ''} · drag to reorder · right-click to move or edit`}
            </p>
          </div>
        </div>
        <button
          onClick={() => openFolderCreate({ parentId: group.id })}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-accent/60"
        >
          <FolderPlus size={15} className="text-warn" />
          New folder
        </button>
      </div>

      {group.description && <p className="mt-3 max-w-2xl text-sm text-muted">{group.description}</p>}

      {modules.length === 0 && folders.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-edge p-8 text-center text-sm text-muted">
          Nothing here yet — drag a tool onto this folder from the home screen, or click{' '}
          <span className="font-medium text-ink">New folder</span> to add a sub-folder.
        </div>
      ) : (
        <>
          {/* Sub-folders */}
          {folders.length > 0 && (
            <section className="mt-8">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Folders</h2>
              <div className={`mt-3 grid ${spec.gap}`} style={cardGridStyle(cardSize)}>
                {folders.map((f) => (
                  <GroupCard
                    key={`g:${f.group.id}`}
                    group={f.group}
                    count={f.toolCount}
                    folderCount={f.folderCount}
                    size={cardSize}
                    onOpen={() => navigate(`/g/${f.group.id}`)}
                    onRename={() => openFolderRename(f.group.id)}
                    onDropModule={(moduleId) => moveToFolder(moduleId, f.group.id)}
                    onNestFolder={(draggedId) => nestFolder(draggedId, f.group.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Misc Tools */}
          {modules.length > 0 && (
            <section className="mt-8">
              {folders.length > 0 && (
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Misc Tools</h2>
              )}
              <div className={`${folders.length > 0 ? 'mt-3' : 'mt-8'} grid ${spec.gap}`} style={cardGridStyle(cardSize)}>
                {modules.map((m) => (
                  <ModuleCard
                    key={m.manifest.id}
                    m={m}
                    overrides={overrides}
                    dropTarget={dropTarget}
                    setDropTarget={setDropTarget}
                    commitReorder={commitReorder}
                    size={cardSize}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

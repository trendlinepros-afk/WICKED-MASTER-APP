import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Pencil } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import { ModuleCard } from './ModuleCard'
import { groupById, groupModules, orderedModules, reorderIds } from './moduleView'

/**
 * A group ("folder") screen: the tools filed under one group, shown as the same
 * cards as Home. Reached from the nav or a Home folder card at /g/<groupId>.
 */
export default function GroupView(): React.JSX.Element {
  const { groupId = '' } = useParams()
  const settings = useSettings((s) => s.settings)
  const { moduleOrder: order, moduleOverrides: overrides } = settings
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { dragId, setDragId, openFolderRename } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const group = groupById(groupId, settings)
  if (!group) return <Navigate to="/" replace />

  const members = groupModules(groupId, settings)

  // Reordering uses the global module order (group membership comes from the
  // manifest, not the order), so dropping a card only changes its position.
  const commitReorder = (targetId: string): void => {
    if (dragId && dragId !== targetId) {
      update({
        moduleOrder: reorderIds(
          orderedModules(order, overrides).map((m) => m.manifest.id),
          dragId,
          targetId
        )
      })
    }
    setDragId(null)
    setDropTarget(null)
  }

  return (
    <div className="h-full overflow-y-auto p-10">
      <button
        onClick={() => navigate('/')}
        className="mb-5 flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft size={15} /> All apps
      </button>

      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 text-accent">
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
            {members.length === 0
              ? 'No tools in this folder yet — drag one onto this folder on the home screen, or use a tool’s right-click menu.'
              : `${members.length} tool${members.length === 1 ? '' : 's'} · drag to reorder · right-click to move or edit`}
          </p>
        </div>
      </div>

      {group.description && <p className="mt-3 max-w-2xl text-sm text-muted">{group.description}</p>}

      {members.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-edge p-8 text-center text-sm text-muted">
          Nothing here yet — modules join this folder by declaring{' '}
          <code className="text-xs">
            &quot;group&quot;: {'{'} &quot;id&quot;: &quot;{group.id}&quot;, … {'}'}
          </code>{' '}
          in their <code className="text-xs">module.json</code>.
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {members.map((m) => (
            <ModuleCard
              key={m.manifest.id}
              m={m}
              overrides={overrides}
              dropTarget={dropTarget}
              setDropTarget={setDropTarget}
              commitReorder={commitReorder}
            />
          ))}
        </div>
      )}
    </div>
  )
}

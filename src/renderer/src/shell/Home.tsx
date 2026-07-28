import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderPlus } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import { GroupCard, ModuleCard } from './ModuleCard'
import {
  allGroups,
  cardGridStyle,
  cardSpec,
  descendantGroupIds,
  orderedModules,
  reorderNav,
  scopeSections
} from './moduleView'

export default function Home(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { dragId, setDragId, openFolderCreate, openFolderRename } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const { moduleOverrides: overrides, disabledModules: disabled, cardSize } = settings
  const all = orderedModules(settings.moduleOrder, overrides)
  // Top level = folders (top) + loose tools (below), same layout as inside a folder.
  const { folders, modules } = scopeSections('', settings)
  const toolCount = all.filter((m) => !disabled.includes(m.manifest.id)).length
  const folderCount = allGroups(settings).length
  const spec = cardSpec(cardSize)

  const commitReorder = (targetToken: string): void => {
    if (dragId && dragId !== targetToken) {
      const next = reorderNav(settings, dragId, targetToken)
      if (next) update({ moduleOrder: next })
    }
    setDragId(null)
    setDropTarget(null)
  }

  /** File a tool into a folder (or, with '', back out to the top level). */
  const moveToFolder = (moduleId: string, groupId: string): void => {
    update({
      moduleGroupOverrides: { ...settings.moduleGroupOverrides, [moduleId]: groupId }
    })
  }

  /** Nest one (user-created) folder inside another; guards against cycles. */
  const nestFolder = (draggedId: string, parentId: string): void => {
    if (draggedId === parentId) return
    if (!settings.customGroups.some((g) => g.id === draggedId)) return // shipped folders don't move
    if (descendantGroupIds(draggedId, settings).has(parentId)) return // no cycles
    update({
      customGroups: settings.customGroups.map((g) =>
        g.id === draggedId ? { ...g, parent: parentId } : g
      )
    })
    setDragId(null)
  }

  return (
    <div className="h-full overflow-y-auto p-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">WICKED</h1>
          <p className="mt-1 text-sm text-muted">
            {toolCount === 0
              ? 'No modules installed yet. Drop a module folder into /modules and rebuild.'
              : `${toolCount} app${toolCount === 1 ? '' : 's'}${folderCount > 0 ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''} · drag tiles or folders to arrange · drop a tool on a folder to file it · right-click for options`}
          </p>
        </div>
        <button
          onClick={() => openFolderCreate()}
          className="flex shrink-0 items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm font-medium text-ink hover:border-accent/60"
        >
          <FolderPlus size={15} className="text-warn" />
          New folder
        </button>
      </div>

      {/* Folders */}
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
    </div>
  )
}

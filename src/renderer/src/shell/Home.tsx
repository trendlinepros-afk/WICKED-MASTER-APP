import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FolderPlus } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import { GroupCard, ModuleCard } from './ModuleCard'
import { navEntries, orderedModules, reorderIds } from './moduleView'

export default function Home(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { dragId, setDragId, openFolderCreate, openFolderRename } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const { moduleOrder: order, moduleOverrides: overrides, disabledModules: disabled } = settings
  const all = orderedModules(order, overrides)
  // Modules in a folder collapse into one folder tile (opens /g/<groupId>).
  const entries = navEntries(settings)
  const toolCount = all.filter((m) => !disabled.includes(m.manifest.id)).length
  const folderCount = entries.filter((e) => e.kind === 'group').length

  const commitReorder = (targetId: string): void => {
    if (dragId && dragId !== targetId) {
      update({ moduleOrder: reorderIds(all.map((m) => m.manifest.id), dragId, targetId) })
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

  return (
    <div className="h-full overflow-y-auto p-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">WICKED</h1>
          <p className="mt-1 text-sm text-muted">
            {toolCount === 0
              ? 'No modules installed yet. Drop a module folder into /modules and rebuild.'
              : `${toolCount} app${toolCount === 1 ? '' : 's'}${folderCount > 0 ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''} · drag onto a folder to file it · right-click for options`}
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

      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {entries.map((e) =>
          e.kind === 'group' ? (
            <GroupCard
              key={`g:${e.group.id}`}
              group={e.group}
              count={e.modules.length}
              onOpen={() => navigate(`/g/${e.group.id}`)}
              onRename={() => openFolderRename(e.group.id)}
              onDropModule={(moduleId) => moveToFolder(moduleId, e.group.id)}
            />
          ) : (
            <ModuleCard
              key={e.module.manifest.id}
              m={e.module}
              overrides={overrides}
              dropTarget={dropTarget}
              setDropTarget={setDropTarget}
              commitReorder={commitReorder}
            />
          )
        )}
      </div>
    </div>
  )
}

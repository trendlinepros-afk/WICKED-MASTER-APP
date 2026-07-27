import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import { GroupCard, ModuleCard } from './ModuleCard'
import { navEntries, orderedModules, reorderIds } from './moduleView'

export default function Home(): React.JSX.Element {
  const disabled = useSettings((s) => s.settings.disabledModules)
  const order = useSettings((s) => s.settings.moduleOrder)
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const { dragId, setDragId } = useShellUi()
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const all = orderedModules(order, overrides)
  // Grouped modules collapse into a single folder tile (opens /g/<groupId>).
  const entries = navEntries(order, overrides, disabled)
  const toolCount = all.filter((m) => !disabled.includes(m.manifest.id)).length
  const folderCount = entries.filter((e) => e.kind === 'group').length

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
        {toolCount === 0
          ? 'No modules installed yet. Drop a module folder into /modules and rebuild.'
          : `${toolCount} app${toolCount === 1 ? '' : 's'}${folderCount > 0 ? ` in ${entries.length} entries (${folderCount} folder${folderCount === 1 ? '' : 's'})` : ''} · drag to reorder · right-click for options`}
      </p>

      <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {entries.map((e) =>
          e.kind === 'group' ? (
            <GroupCard
              key={`g:${e.group.id}`}
              group={e.group}
              count={e.modules.length}
              onOpen={() => navigate(`/g/${e.group.id}`)}
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

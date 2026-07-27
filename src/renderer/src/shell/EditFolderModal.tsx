import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { ModuleGroup } from '@shared/types'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import { allGroups, groupById, groupModules, makeGroupId } from './moduleView'

/** A few sensible folder icons; any lucide name can still be typed. */
const ICON_CHOICES = [
  'Folder',
  'TrendingUp',
  'CandlestickChart',
  'Wrench',
  'Film',
  'Cpu',
  'Shield',
  'Database',
  'Sparkles',
  'Globe'
]

/**
 * Create a new folder or rename an existing one. Shipped folders (declared by a
 * module's manifest) can be renamed/re-iconed but not deleted; user-created
 * folders can also be deleted, which returns their tools to the top level.
 */
export default function EditFolderModal(): React.JSX.Element | null {
  const folderEdit = useShellUi((s) => s.folderEdit)
  const close = useShellUi((s) => s.closeFolderEdit)
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)

  const existing: ModuleGroup | undefined =
    folderEdit?.mode === 'rename' ? groupById(folderEdit.groupId, settings) : undefined

  const [name, setName] = useState('')
  const [icon, setIcon] = useState('Folder')

  useEffect(() => {
    if (!folderEdit) return
    setName(existing?.name ?? '')
    setIcon(existing?.icon ?? 'Folder')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderEdit])

  if (!folderEdit) return null
  const isRename = folderEdit.mode === 'rename'
  const isCustom = isRename && settings.customGroups.some((g) => g.id === folderEdit.groupId)
  const trimmed = name.trim()

  const save = (): void => {
    if (!trimmed) return
    if (isRename) {
      const id = folderEdit.groupId
      // A user-made folder is edited in place; a shipped one gets an override
      // so the manifest stays the source of truth for its default.
      if (isCustom) {
        update({
          customGroups: settings.customGroups.map((g) =>
            g.id === id ? { ...g, name: trimmed, icon } : g
          )
        })
      } else {
        update({
          groupOverrides: { ...settings.groupOverrides, [id]: { name: trimmed, icon } }
        })
      }
    } else {
      const id = makeGroupId(
        trimmed,
        allGroups(settings).map((g) => g.id)
      )
      const next: Record<string, string> = { ...settings.moduleGroupOverrides }
      // "New folder…" invoked from a module's menu files that module straight in
      if (folderEdit.moduleId) next[folderEdit.moduleId] = id
      update({
        customGroups: [...settings.customGroups, { id, name: trimmed, icon }],
        moduleGroupOverrides: next
      })
    }
    close()
  }

  const remove = (): void => {
    if (!isRename || !isCustom) return
    const id = folderEdit.groupId
    const members = groupModules(id, settings)
    if (
      members.length > 0 &&
      !window.confirm(
        `Delete the folder “${existing?.name}”? Its ${members.length} tool(s) move back to the top level — nothing is uninstalled.`
      )
    )
      return
    // Drop every assignment pointing at this folder, plus any override entry.
    const nextAssign = { ...settings.moduleGroupOverrides }
    for (const [moduleId, gid] of Object.entries(nextAssign))
      if (gid === id) delete nextAssign[moduleId]
    const nextOverrides = { ...settings.groupOverrides }
    delete nextOverrides[id]
    update({
      customGroups: settings.customGroups.filter((g) => g.id !== id),
      moduleGroupOverrides: nextAssign,
      groupOverrides: nextOverrides
    })
    close()
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-[440px] max-w-full rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <h3 className="text-base font-semibold">{isRename ? 'Rename folder' : 'New folder'}</h3>
        <p className="mt-1 text-xs text-muted">
          {isRename
            ? 'Change what this folder is called and its icon. The tools inside are untouched.'
            : 'Folders group related tools on the home screen and in the sidebar. You can drag tools onto a folder, or use a tool’s right-click menu.'}
        </p>

        <label className="mt-4 block text-xs font-medium text-muted">Folder name</label>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          placeholder="e.g. Stocks"
          className="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs font-medium text-muted">Icon</label>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ICON_CHOICES.map((n) => (
            <button
              key={n}
              onClick={() => setIcon(n)}
              title={n}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border ${
                icon === n ? 'border-accent bg-accent/10 text-accent' : 'border-edge bg-raised text-muted hover:text-ink'
              }`}
            >
              <ModuleIcon name={n} size={17} strokeWidth={1.8} />
            </button>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            onClick={remove}
            disabled={!isCustom}
            title={
              isCustom
                ? 'Delete this folder (tools move back to the top level)'
                : 'This folder comes from an installed app, so it can be renamed but not deleted'
            }
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Trash2 size={14} />
            Delete folder
          </button>
          <div className="flex gap-2">
            <button onClick={close} className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!trimmed}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              {isRename ? 'Save' : 'Create folder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

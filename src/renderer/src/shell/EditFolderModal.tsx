import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { ModuleGroup } from '@shared/types'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import {
  allGroups,
  descendantGroupIds,
  groupById,
  groupModules,
  groupParentId,
  groupPath,
  makeGroupId
} from './moduleView'

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
 * Create a new folder or rename an existing one. Folders can nest — a new folder
 * inherits the parent it was created from, and user-made folders can be moved
 * (nested / un-nested) via the Location dropdown. Shipped folders (declared by a
 * module's manifest) can be renamed/re-iconed but not deleted or nested.
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
  const [parent, setParent] = useState('')

  useEffect(() => {
    if (!folderEdit) return
    setName(existing?.name ?? '')
    setIcon(existing?.icon ?? 'Folder')
    setParent(
      folderEdit.mode === 'rename'
        ? groupParentId(folderEdit.groupId, settings)
        : (folderEdit.parentId ?? '')
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderEdit])

  if (!folderEdit) return null
  const isRename = folderEdit.mode === 'rename'
  const isCustom = isRename && settings.customGroups.some((g) => g.id === folderEdit.groupId)
  const trimmed = name.trim()
  // A folder can't be its own parent or nest inside its own descendants.
  const invalid =
    folderEdit.mode === 'rename'
      ? new Set<string>([folderEdit.groupId, ...descendantGroupIds(folderEdit.groupId, settings)])
      : new Set<string>()
  const parentOptions = allGroups(settings).filter((g) => !invalid.has(g.id))
  // Location can be chosen when creating, or when editing a user-made folder.
  const canChooseParent = !isRename || isCustom

  const save = (): void => {
    if (!trimmed) return
    if (isRename) {
      const id = folderEdit.groupId
      // A user-made folder is edited in place (incl. its parent); a shipped one
      // only gets a name/icon override so the manifest stays its default source.
      if (isCustom) {
        update({
          customGroups: settings.customGroups.map((g) =>
            g.id === id ? { ...g, name: trimmed, icon, parent: parent || undefined } : g
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
        customGroups: [
          ...settings.customGroups,
          { id, name: trimmed, icon, ...(parent ? { parent } : {}) }
        ],
        moduleGroupOverrides: next
      })
    }
    close()
  }

  const remove = (): void => {
    if (!isRename || !isCustom) return
    const id = folderEdit.groupId
    const members = groupModules(id, settings)
    const subfolders = settings.customGroups.filter((g) => g.parent === id)
    const grandparent = groupParentId(id, settings)
    const destName = grandparent ? (groupById(grandparent, settings)?.name ?? 'its parent') : 'the top level'
    if (
      (members.length > 0 || subfolders.length > 0) &&
      !window.confirm(
        `Delete the folder “${existing?.name}”? Its ${members.length} tool(s)${
          subfolders.length ? ` and ${subfolders.length} sub-folder(s)` : ''
        } move to ${destName} — nothing is uninstalled.`
      )
    )
      return
    // Reparent this folder's sub-folders up to its parent, drop the folder, and
    // move its direct tools up to the same parent.
    const nextGroups = settings.customGroups
      .filter((g) => g.id !== id)
      .map((g) => (g.parent === id ? { ...g, parent: grandparent || undefined } : g))
    const nextAssign = { ...settings.moduleGroupOverrides }
    for (const [moduleId, gid] of Object.entries(nextAssign))
      if (gid === id) nextAssign[moduleId] = grandparent
    const nextOverrides = { ...settings.groupOverrides }
    delete nextOverrides[id]
    update({
      customGroups: nextGroups,
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
            ? 'Change what this folder is called, its icon and where it lives. The tools inside are untouched.'
            : 'Folders group related tools on the home screen and in the sidebar. You can drag tools onto a folder, nest folders inside folders, or use a tool’s right-click menu.'}
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

        {canChooseParent && (
          <>
            <label className="mt-3 block text-xs font-medium text-muted">Location</label>
            <select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              className="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
            >
              <option value="">Top level (home screen)</option>
              {parentOptions.map((g) => {
                const depth = Math.max(0, groupPath(g.id, settings).length - 1)
                return (
                  <option key={g.id} value={g.id}>
                    {`${'   '.repeat(depth)}${g.name}`}
                  </option>
                )
              })}
            </select>
          </>
        )}

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
                ? 'Delete this folder (tools & sub-folders move up one level)'
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

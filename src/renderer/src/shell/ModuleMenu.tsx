import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ExternalLink, Eye, EyeOff, FolderPlus, Pencil, Pin, PinOff, SquareArrowOutUpRight } from 'lucide-react'
import { SHELL_IPC } from '@shared/types'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import ModuleIcon from './ModuleIcon'
import { GROUP_DRAG_PREFIX, allGroups, effectiveGroupId, groupById, groupParentId, groupPath } from './moduleView'
import { moduleById } from './registry'

/**
 * Right-click menu for a module or a folder (shared by the sidebar and home
 * cards — folder targets arrive as `group:<id>` tokens). Rendered once at the
 * shell level; positioned at the click point.
 */
export default function ModuleMenu(): React.JSX.Element | null {
  const menu = useShellUi((s) => s.menu)
  const closeMenu = useShellUi((s) => s.closeMenu)
  const openEdit = useShellUi((s) => s.openEdit)
  const openFolderCreate = useShellUi((s) => s.openFolderCreate)
  const openFolderRename = useShellUi((s) => s.openFolderRename)
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  // keep the menu on-screen
  useEffect(() => {
    if (!menu) return
    const el = ref.current
    const w = el?.offsetWidth ?? 220
    const h = el?.offsetHeight ?? 120
    setPos({
      x: Math.min(menu.x, window.innerWidth - w - 8),
      y: Math.min(menu.y, window.innerHeight - h - 8)
    })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu, closeMenu])

  if (!menu) return null
  const id = menu.id

  const item =
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-ink hover:bg-raised'

  /* ------------------------------ folder menu ------------------------------ */
  if (id.startsWith(GROUP_DRAG_PREFIX)) {
    const gid = id.slice(GROUP_DRAG_PREFIX.length)
    const g = groupById(gid, settings)
    if (!g) return null
    const hiddenList = settings.navHiddenGroups ?? []
    const folderHidden = hiddenList.includes(gid)
    return (
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-[60] w-56 rounded-xl border border-edge bg-surface p-1 shadow-2xl"
      >
        <button
          className={item}
          onClick={() => {
            navigate(`/g/${gid}`)
            closeMenu()
          }}
        >
          <ExternalLink size={15} className="text-muted" />
          Open folder
        </button>
        <button className={item} onClick={() => openFolderRename(gid)}>
          <Pencil size={15} className="text-muted" />
          Rename &amp; edit folder
        </button>
        {/* only TOP-LEVEL folders appear in the left menu — for a nested
            folder the toggle would silently do nothing, so it's not shown */}
        {groupParentId(gid, settings) === '' && (
          <button
            className={item}
            title={
              folderHidden
                ? 'Show this folder in the left menu again'
                : 'Hide from the left menu — the folder and its tools stay on the home screen'
            }
            onClick={() => {
              update({
                navHiddenGroups: folderHidden ? hiddenList.filter((x) => x !== gid) : [...hiddenList, gid]
              })
              closeMenu()
            }}
          >
            {folderHidden ? <Eye size={15} className="text-muted" /> : <EyeOff size={15} className="text-muted" />}
            {folderHidden ? 'Un-Hide from left menu' : 'Hide from left menu'}
          </button>
        )}
      </div>
    )
  }

  /* ------------------------------ module menu ------------------------------ */
  const mod = moduleById(id)
  const folders = allGroups(settings)
  const currentGroup = mod ? effectiveGroupId(mod, settings) : ''

  const moveTo = (groupId: string): void => {
    update({ moduleGroupOverrides: { ...settings.moduleGroupOverrides, [id]: groupId } })
    closeMenu()
  }

  const navHidden = (settings.navHiddenModules ?? []).includes(id)
  const toggleNavHidden = (): void => {
    const list = settings.navHiddenModules ?? []
    update({ navHiddenModules: navHidden ? list.filter((x) => x !== id) : [...list, id] })
    closeMenu()
  }

  const pinned = (settings.navPinnedModules ?? []).includes(id)
  const togglePinned = (): void => {
    const list = settings.navPinnedModules ?? []
    update({ navPinnedModules: pinned ? list.filter((x) => x !== id) : [...list, id] })
    closeMenu()
  }

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] w-56 rounded-xl border border-edge bg-surface p-1 shadow-2xl"
    >
      <button
        className={item}
        onClick={() => {
          navigate(`/m/${id}`)
          closeMenu()
        }}
      >
        <ExternalLink size={15} className="text-muted" />
        Open
      </button>
      <button
        className={item}
        onClick={() => {
          window.wicked.invoke(SHELL_IPC.openModuleWindow, id)
          closeMenu()
        }}
      >
        <SquareArrowOutUpRight size={15} className="text-muted" />
        Launch in separate window
      </button>
      <button className={item} onClick={() => openEdit(id)}>
        <Pencil size={15} className="text-muted" />
        Edit name &amp; description
      </button>
      <button
        className={item}
        title={
          pinned
            ? 'Remove this tool’s pinned row from the top of the left menu'
            : 'Give this tool its own row at the top of the left menu — even while it stays in its folder'
        }
        onClick={togglePinned}
      >
        {pinned ? <PinOff size={15} className="text-muted" /> : <Pin size={15} className="text-muted" />}
        {pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
      </button>
      <button
        className={item}
        title={navHidden ? 'Show this tool in the left menu again' : 'Hide from the left menu — stays on the home screen'}
        onClick={toggleNavHidden}
      >
        {navHidden ? <Eye size={15} className="text-muted" /> : <EyeOff size={15} className="text-muted" />}
        {navHidden ? 'Un-Hide' : 'Hide'}
      </button>

      {/* Move to folder */}
      <div className="my-1 h-px bg-edge" />
      <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
        Move to folder
      </div>
      <div className="max-h-56 overflow-y-auto">
        <button className={item} onClick={() => moveTo('')}>
          <span className="w-[15px] shrink-0">
            {currentGroup === '' && <Check size={13} className="text-accent" />}
          </span>
          No folder (top level)
        </button>
        {folders.map((g) => {
          const depth = Math.max(0, groupPath(g.id, settings).length - 1)
          return (
            <button key={g.id} className={item} onClick={() => moveTo(g.id)}>
              <span className="w-[15px] shrink-0">
                {currentGroup === g.id && <Check size={13} className="text-accent" />}
              </span>
              <span style={{ width: depth * 12 }} className="shrink-0" />
              <ModuleIcon name={g.icon} size={14} strokeWidth={1.8} className="shrink-0 text-warn" />
              <span className="min-w-0 truncate">{g.name}</span>
            </button>
          )
        })}
      </div>
      <button className={item} onClick={() => openFolderCreate({ moduleId: id })}>
        <FolderPlus size={15} className="text-warn" />
        New folder…
      </button>
    </div>
  )
}

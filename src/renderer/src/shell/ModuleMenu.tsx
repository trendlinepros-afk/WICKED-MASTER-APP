import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Pencil, SquareArrowOutUpRight } from 'lucide-react'
import { SHELL_IPC } from '@shared/types'
import { useShellUi } from '@/stores/shellUi'

/**
 * Right-click menu for a module (shared by the sidebar and home cards).
 * Rendered once at the shell level; positioned at the click point.
 */
export default function ModuleMenu(): React.JSX.Element | null {
  const menu = useShellUi((s) => s.menu)
  const closeMenu = useShellUi((s) => s.closeMenu)
  const openEdit = useShellUi((s) => s.openEdit)
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
    </div>
  )
}

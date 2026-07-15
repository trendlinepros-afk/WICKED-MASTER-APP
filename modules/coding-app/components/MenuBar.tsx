import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import manifest from '../module.json'

/**
 * Top menu / toolbar. Hosts the classic File/Edit/Settings/Help menus plus a
 * sidebar toggle on the left, and the "Auto Fix Errors From Gemini" quick
 * toggle on the right.
 *
 * Port notes: the standalone app's "Check for Updates" menu item and the
 * theme cycle button were removed — the WICKED shell owns updates and theming.
 */

interface MenuBarProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
}

type MenuName = 'file' | 'edit' | 'settings' | 'help'

export function MenuBar({ sidebarOpen, onToggleSidebar }: MenuBarProps): JSX.Element {
  const config = useStore((s) => s.config)
  const updateConfig = useStore((s) => s.updateConfig)
  const newConversation = useStore((s) => s.newConversation)
  const project = useStore((s) => s.project)
  const setNewProjectOpen = useStore((s) => s.setNewProjectOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [openMenu, setOpenMenu] = useState<MenuName | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openMenu) return
    const onDocClick = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenu])

  const handleNewProject = (): void => setNewProjectOpen(true)

  const handleAbout = (): void => {
    window.alert(`${manifest.name}\nVersion ${manifest.version} (WICKED module)`)
  }

  const menus: Record<MenuName, MenuItem[]> = {
    file: [
      // New Conversation requires an active project (same rule as the sidebar).
      { label: 'New Conversation', onClick: () => newConversation(), disabled: !project },
      { label: 'New Project…', onClick: handleNewProject }
    ],
    edit: [
      { label: 'Undo', onClick: () => document.execCommand('undo') },
      { label: 'Redo', onClick: () => document.execCommand('redo') },
      { label: 'Cut', onClick: () => document.execCommand('cut') },
      { label: 'Copy', onClick: () => document.execCommand('copy') },
      { label: 'Paste', onClick: () => document.execCommand('paste') }
    ],
    settings: [{ label: 'Open Settings…', onClick: () => setSettingsOpen(true) }],
    help: [{ label: 'About', onClick: handleAbout }]
  }

  const runItem = (item: MenuItem): void => {
    if (item.disabled) return
    setOpenMenu(null)
    item.onClick()
  }

  const menuButton = (name: MenuName, label: string): JSX.Element => (
    <div className="relative">
      <button
        type="button"
        className={`rounded px-2 py-1 text-sm hover:bg-raised ${
          openMenu === name ? 'bg-raised' : ''
        }`}
        onClick={() => setOpenMenu((v) => (v === name ? null : name))}
      >
        {label}
      </button>
      {openMenu === name && (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-[180px] rounded-md border border-edge bg-raised py-1 shadow-xl">
          {menus[name].map((item) => (
            <button
              type="button"
              key={item.label}
              disabled={item.disabled}
              onClick={() => runItem(item)}
              className="block w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-edge/60 disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const geminiEnabled = config?.geminiAnalysisEnabled ?? false
  const autoFixOn = config?.autoFixFromGemini ?? false

  const toggleAutoFix = (): void => {
    if (!geminiEnabled) return
    void updateConfig({ autoFixFromGemini: !autoFixOn })
  }

  return (
    <div
      ref={barRef}
      className="flex items-center justify-between border-b border-edge bg-surface px-2 py-1"
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={`rounded px-2 py-1 text-sm hover:bg-raised ${
            sidebarOpen ? 'text-ink' : 'text-muted'
          }`}
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          ☰
        </button>
        <span className="mr-2 select-none px-1 text-sm font-semibold text-ink">
          {manifest.name}
        </span>
        {menuButton('file', 'File')}
        {menuButton('edit', 'Edit')}
        {menuButton('settings', 'Settings')}
        {menuButton('help', 'Help')}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!geminiEnabled}
          onClick={toggleAutoFix}
          title={
            geminiEnabled
              ? 'Automatically apply Gemini-suggested fixes'
              : 'Enable Gemini analysis in Settings first'
          }
          className={`rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            autoFixOn && geminiEnabled
              ? 'bg-accent text-accent-ink'
              : 'border border-edge bg-raised text-ink hover:bg-edge/60'
          }`}
        >
          Auto Fix Errors From Gemini: {autoFixOn && geminiEnabled ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  )
}

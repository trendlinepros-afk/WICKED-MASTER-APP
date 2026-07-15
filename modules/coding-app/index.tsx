import { useEffect, useRef, useState } from 'react'
import { SHELL_IPC } from '@shared/types'
import { useStore } from './store'
import { api } from './lib/bridge'
import { MenuBar } from './components/MenuBar'
import { ModelSwitcher } from './components/ModelSwitcher'
import { ChatPanel } from './components/ChatPanel'
import { RightPanel } from './components/RightPanel'
import { ConversationSidebar } from './components/ConversationSidebar'
import { SettingsModal } from './components/SettingsModal'
import { CostConfirmModal } from './components/CostConfirmModal'
import { NewProjectModal } from './components/NewProjectModal'
import { Banner } from './components/Banner'
import { PrereqNotice } from './components/PrereqNotice'
import './coding-app.css'

// Auto-start Ollama only once per shell session, not on every route visit.
let ollamaAutostartDone = false

/**
 * Module root: menu bar on top, a collapsible conversation sidebar on the left,
 * and a resizable 50/50 split between the chat panel and the right panel
 * (code editor / live preview / run console). Wires up the main->renderer
 * streaming and event subscriptions on mount.
 *
 * Port notes: the standalone app's UpdateBanner and theme handling are gone —
 * the WICKED shell owns updates and theming.
 */
export default function CodingApp(): React.JSX.Element {
  const {
    loadConfig,
    refreshApiKeys,
    setApiKeys,
    refreshModels,
    refreshOllama,
    refreshConversations,
    newConversation,
    handleStreamToken,
    handleStreamDone,
    handleStreamError,
    refreshFileTree,
    settingsOpen,
    pendingSend
  } = useStore()

  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [splitPct, setSplitPct] = useState(50)
  const draggingRef = useRef(false)

  // Bootstrap + subscriptions (re-run on every mount; unsubscribed on unmount).
  useEffect(() => {
    void (async () => {
      await loadConfig()
      // Keep the current conversation across route changes within a session.
      if (!useStore.getState().current) newConversation()
      await Promise.all([
        refreshApiKeys(),
        refreshModels(),
        refreshOllama(),
        refreshConversations()
      ])
      // The standalone app auto-started Ollama at launch; inside the suite we
      // do it lazily the first time this module is opened.
      const cfg = useStore.getState().config
      if (cfg?.autoStartOllama && !ollamaAutostartDone) {
        ollamaAutostartDone = true
        api
          .startOllama()
          .then(() => Promise.all([refreshOllama(), refreshModels()]))
          .catch(() => {})
      }
    })()

    const offChat = api.onChatStream((e) => {
      if (e.type === 'token') handleStreamToken(e.token)
      else if (e.type === 'done') void handleStreamDone(e.content)
      else if (e.type === 'error') handleStreamError(e.error)
    })
    const offFile = api.onFileChanged(() => void refreshFileTree())
    const offRunLog = api.onRunLog((line) => useStore.getState().handleRunLog(line))
    const offRunExit = api.onRunExit((code) => useStore.getState().handleRunExit(code))
    // Shell vault broadcasts key presence changes (booleans only) — refresh the
    // model list so cloud availability updates immediately.
    const offKeys = window.wicked.on(SHELL_IPC.apiKeysChanged, (status) => {
      setApiKeys(status as Record<string, boolean>)
      void refreshModels()
    })

    // Refresh model availability periodically (Ollama up/down, keys changed).
    const interval = setInterval(() => {
      void refreshOllama()
      void refreshModels()
    }, 15000)

    return () => {
      offChat()
      offFile()
      offRunLog()
      offRunExit()
      offKeys()
      clearInterval(interval)
    }
    // Intentionally run once on mount; store actions are stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Split-pane drag handling.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return
      const pct = (e.clientX / window.innerWidth) * 100
      setSplitPct(Math.min(75, Math.max(25, pct)))
    }
    const onUp = (): void => {
      draggingRef.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      <MenuBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
      <Banner />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && <ConversationSidebar />}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-edge px-3 py-2">
            <ModelSwitcher />
          </div>
          <div className="flex min-h-0 flex-1">
            <div style={{ width: `${splitPct}%` }} className="min-w-0">
              <ChatPanel />
            </div>
            <div
              className="w-1 cursor-col-resize bg-edge hover:bg-accent"
              onMouseDown={() => {
                draggingRef.current = true
                document.body.style.cursor = 'col-resize'
              }}
            />
            <div style={{ width: `${100 - splitPct}%` }} className="min-w-0">
              <RightPanel />
            </div>
          </div>
        </div>
      </div>
      {settingsOpen && <SettingsModal />}
      {pendingSend && <CostConfirmModal />}
      <NewProjectModal />
      <PrereqNotice />
    </div>
  )
}

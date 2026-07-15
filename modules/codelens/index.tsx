// CodeLens — visual code intelligence. Ported from the standalone
// codelens-desktop Electron app; this is its App.tsx adapted to the WICKED
// module contract (h-full root, shell theme tokens, bridge instead of preload).
import { useCallback, useEffect, useState } from 'react'
import { DetailDrawer } from './components/DetailDrawer'
import { FileTree } from './components/FileTree'
import { GraphView } from './components/GraphView'
import type { ColorMode } from './components/GraphView'
import { SettingsModal } from './components/SettingsModal'
import { Spinner } from './components/Spinner'
import { StatusBar } from './components/StatusBar'
import { SummaryModal } from './components/SummaryModal'
import { Toolbar } from './components/Toolbar'
import { WelcomeScreen } from './components/WelcomeScreen'
import { useProject } from './hooks/useProject'
import { codelensApi } from './lib/bridge'
import type { Settings } from './shared/types'
import './styles.css'

const FIRST_LAUNCH_FLAG = 'codelens.apiKeyPromptShown'

export default function CodeLens() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [colorMode, setColorMode] = useState<ColorMode>('type')
  const [hideIsolated, setHideIsolated] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [showSummary, setShowSummary] = useState(false)

  const project = useProject(useCallback(() => setSelected(null), []))

  // Load settings; on very first launch, surface the API key screen (dismissable —
  // every static feature works without it).
  useEffect(() => {
    void codelensApi.getSettings().then((s) => {
      setSettings(s)
      const anyKey = Object.values(s.ai.hasKey).some(Boolean)
      if (!anyKey && !localStorage.getItem(FIRST_LAUNCH_FLAG)) {
        localStorage.setItem(FIRST_LAUNCH_FLAG, '1')
        setShowSettings(true)
      }
    })
  }, [])

  const aiEnabled = settings ? settings.ai.hasKey[settings.ai.provider] : false
  const aiLabel = settings && aiEnabled ? settings.ai.model : null

  const modals = (
    <>
      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          hasProject={project.scan !== null}
          onClose={() => setShowSettings(false)}
          onSettingsChanged={setSettings}
          onRescan={() => {
            setShowSettings(false)
            void project.rescan()
          }}
        />
      )}
      {showSummary && project.scan && (
        <SummaryModal projectName={project.scan.projectName} onClose={() => setShowSummary(false)} />
      )}
    </>
  )

  if (!project.scan) {
    return (
      <div className="codelens-root h-full">
        <WelcomeScreen
          settings={settings}
          scanning={project.scanning}
          error={project.error}
          onOpenFolder={() => void project.openFolder()}
          onOpenRecent={(p) => void project.scanPath(p)}
          onOpenSettings={() => setShowSettings(true)}
        />
        {modals}
      </div>
    )
  }

  return (
    <div className="codelens-root flex h-full flex-col bg-bg">
      <Toolbar
        scan={project.scan}
        scanning={project.scanning}
        aiEnabled={aiEnabled}
        onOpenFolder={() => void project.openFolder()}
        onRescan={() => void project.rescan()}
        onSummarize={() => setShowSummary(true)}
        onOpenSettings={() => setShowSettings(true)}
      />

      {project.error && (
        <div className="flex items-center justify-between border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-danger">
          <span>{project.error}</span>
          <button className="hover:opacity-80" onClick={project.clearError}>
            dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <FileTree scan={project.scan} selected={selected} onSelect={setSelected} />
        <GraphView
          scan={project.scan}
          selected={selected}
          colorMode={colorMode}
          hideIsolated={hideIsolated}
          onSelect={setSelected}
          onColorMode={setColorMode}
          onHideIsolated={setHideIsolated}
        />
        {selected && (
          <DetailDrawer
            scan={project.scan}
            relPath={selected}
            aiEnabled={aiEnabled}
            onClose={() => setSelected(null)}
            onSelect={setSelected}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
      </div>

      <StatusBar scan={project.scan} aiLabel={aiLabel} />

      {project.scanning && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
          <div className="rounded-xl border border-edge bg-surface px-6 py-4">
            <Spinner label="Rescanning project…" />
          </div>
        </div>
      )}

      {modals}
    </div>
  )
}

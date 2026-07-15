import { useStore } from '../store'
import type { RightPanelMode } from '../store'
import { CodeEditor } from './CodeEditor'
import { LivePreview } from './LivePreview'
import { RunConsole } from './RunConsole'

/**
 * Wraps the right-hand workspace, toggling between the code editor, the live
 * preview (web output), and the Run console (runs the project and shows logs).
 */
export function RightPanel(): JSX.Element {
  const rightPanelMode = useStore((s) => s.rightPanelMode)
  const setRightPanelMode = useStore((s) => s.setRightPanelMode)
  const startRun = useStore((s) => s.startRun)
  const stopRun = useStore((s) => s.stopRun)
  const runStatus = useStore((s) => s.runStatus)
  const running = runStatus?.running ?? false

  const segClass = (mode: RightPanelMode): string =>
    `px-3 py-1 text-sm rounded transition-colors ${
      rightPanelMode === mode
        ? 'bg-accent text-accent-ink'
        : 'text-muted hover:bg-edge/60'
    }`

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge bg-surface p-2">
        <div className="flex gap-1 rounded bg-raised p-0.5">
          <button className={segClass('editor')} onClick={() => setRightPanelMode('editor')}>
            Code Editor
          </button>
          <button className={segClass('preview')} onClick={() => setRightPanelMode('preview')}>
            Live Preview
          </button>
          <button className={segClass('run')} onClick={() => setRightPanelMode('run')}>
            Run
          </button>
        </div>
        {/* Quick Play / Stop — runs the project (opens the Run console). */}
        {running ? (
          <button
            className="rounded border border-danger/40 bg-danger/15 px-3 py-1 text-sm font-medium text-danger hover:bg-danger/25"
            onClick={() => void stopRun()}
            title="Stop the running project"
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="rounded border border-ok/40 bg-ok/15 px-3 py-1 text-sm font-medium text-ok hover:bg-ok/25"
            onClick={() => void startRun()}
            title="Run this project (python / node / npm start) and show logs"
          >
            ▶ Play
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {rightPanelMode === 'editor' && <CodeEditor />}
        {rightPanelMode === 'preview' && <LivePreview />}
        {rightPanelMode === 'run' && <RunConsole />}
      </div>
    </div>
  )
}

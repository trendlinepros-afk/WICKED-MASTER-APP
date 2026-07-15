import { useEffect, useRef } from 'react'
import { useStore } from '../store'

/**
 * "Play" view: a Run/Stop control plus a diagnostics console that streams the
 * project process's stdout/stderr. Use this for apps Live Preview can't render
 * (desktop/script apps like a pygame game) — the app window opens separately and
 * its logs appear here.
 */
export function RunConsole(): JSX.Element {
  const project = useStore((s) => s.project)
  const runStatus = useStore((s) => s.runStatus)
  const runLogs = useStore((s) => s.runLogs)
  const startRun = useStore((s) => s.startRun)
  const stopRun = useStore((s) => s.stopRun)
  const clearRunLogs = useStore((s) => s.clearRunLogs)
  const config = useStore((s) => s.config)
  const updateConfig = useStore((s) => s.updateConfig)

  const running = runStatus?.running ?? false
  const autoDebug = config?.autoDebugRunErrors ?? true
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the console as new lines arrive.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [runLogs.length])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-surface p-8 text-center text-sm text-muted">
        Open a project to run it.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2">
        {running ? (
          <button
            className="rounded border border-danger/40 bg-danger/15 px-3 py-1 text-sm font-medium text-danger hover:bg-danger/25"
            onClick={() => void stopRun()}
          >
            ■ Stop
          </button>
        ) : (
          <button
            className="rounded border border-ok/40 bg-ok/15 px-3 py-1 text-sm font-medium text-ok hover:bg-ok/25"
            onClick={() => void startRun()}
          >
            ▶ Play
          </button>
        )}
        <button
          className="rounded border border-edge px-3 py-1 text-sm text-ink hover:bg-raised"
          onClick={clearRunLogs}
        >
          Clear
        </button>
        <label
          className="ml-auto flex items-center gap-1.5 text-xs text-muted"
          title="When a run fails, send its output to the chat so the AI can fix it"
        >
          <input
            type="checkbox"
            checked={autoDebug}
            onChange={(e) => void updateConfig({ autoDebugRunErrors: e.target.checked })}
          />
          Auto-fix errors in chat
        </label>
        <span className="text-xs text-muted">
          {running
            ? `Running…`
            : runStatus?.exitCode != null
              ? `Exited (code ${runStatus.exitCode})`
              : 'Idle'}
        </span>
      </div>

      {/* The console is intentionally always dark, like a terminal, in both shell themes. */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-[#0b0e14] p-3 font-mono text-xs leading-relaxed text-gray-200"
      >
        {runLogs.length === 0 ? (
          <div className="text-gray-500">
            Press ▶ Play to run this project. Output (and errors) will stream
            here. Desktop apps open in their own window.
          </div>
        ) : (
          runLogs.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/bridge'

/**
 * Live preview panel. Renders the running preview server in a <webview> (the
 * shell window enables webviewTag; a plain iframe would be blocked by the
 * shell's CSP for http origins), offers start/stop/reload controls, and a
 * Screenshot button that (when Gemini analysis is enabled) triggers an
 * automated visual review of the current view. The webview reloads (remounts)
 * whenever a project file changes. React 18's JSX types cover <webview>
 * natively, so no extra declarations are needed.
 */
export function LivePreview(): JSX.Element {
  const previewStatus = useStore((s) => s.previewStatus)
  const startPreview = useStore((s) => s.startPreview)
  const stopPreview = useStore((s) => s.stopPreview)
  const analyzeCurrentPreview = useStore((s) => s.analyzeCurrentPreview)
  const config = useStore((s) => s.config)
  const setBanner = useStore((s) => s.setBanner)

  const [reloadKey, setReloadKey] = useState<number>(0)
  const [starting, setStarting] = useState<boolean>(false)

  const running = previewStatus?.running ?? false
  const url = previewStatus?.url ?? null

  // Auto-reload the preview whenever a file on disk changes.
  useEffect(() => {
    const unsubscribe = api.onFileChanged(() => {
      setReloadKey((k) => k + 1)
    })
    return unsubscribe
  }, [])

  const handleStart = async (): Promise<void> => {
    setStarting(true)
    try {
      await startPreview()
    } finally {
      setStarting(false)
    }
  }

  const handleScreenshot = async (): Promise<void> => {
    if (!running) return
    if (config?.geminiAnalysisEnabled) {
      await analyzeCurrentPreview()
    } else {
      setBanner({
        kind: 'info',
        text: 'Enable "Have Gemini Analyze Screenshots" in Settings to analyze.'
      })
    }
  }

  const btnClass =
    'rounded border border-edge px-2.5 py-1 text-xs text-ink hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-edge bg-raised px-3 py-1.5">
        {running ? (
          <>
            <span className="truncate text-xs text-muted" title={url ?? undefined}>
              {url ?? 'Preview running'}
            </span>
            <button className={btnClass} onClick={() => setReloadKey((k) => k + 1)}>
              Reload
            </button>
            <button className={btnClass} onClick={() => void stopPreview()}>
              Stop
            </button>
          </>
        ) : (
          <button
            className="rounded bg-accent px-2.5 py-1 text-xs text-accent-ink hover:opacity-90 disabled:opacity-40"
            disabled={starting}
            onClick={() => void handleStart()}
          >
            {starting ? 'Starting…' : 'Start Preview'}
          </button>
        )}
        <button
          className={`ml-auto ${btnClass}`}
          disabled={!running}
          title={
            config?.geminiAnalysisEnabled
              ? 'Capture the preview and have Gemini analyze it'
              : 'Enable Gemini screenshot analysis in Settings to use this'
          }
          onClick={() => void handleScreenshot()}
        >
          Screenshot
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {running && url ? (
          <div className="h-full w-full border border-edge">
            <webview
              key={reloadKey}
              src={url}
              className="h-full w-full"
              style={{ display: 'flex' }}
              title="preview"
            />
          </div>
        ) : running ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Starting preview server…</p>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm text-muted">
              {starting ? 'Starting preview server…' : 'Preview is not running.'}
            </p>
            {previewStatus?.error && (
              <p className="text-sm text-danger">{previewStatus.error}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

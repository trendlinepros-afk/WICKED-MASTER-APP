import { useStore } from '../store'

/**
 * Top-of-module status banner. Shows transient errors/info pushed to the
 * store, plus a persistent warning when no models are available at all
 * (Ollama down and no valid cloud keys).
 */
export function Banner(): JSX.Element | null {
  const { banner, setBanner, models, ollamaStatus } = useStore()

  const anyAvailable = models.some((m) => m.available)
  const noModels = models.length > 0 && !anyAvailable

  if (!banner && !noModels) return null

  return (
    <div className="flex flex-col">
      {noModels && (
        <div className="flex items-center justify-between bg-warn/15 px-4 py-2 text-sm text-warn">
          <span>
            No models available.{' '}
            {ollamaStatus && !ollamaStatus.connected
              ? 'Ollama is not running. '
              : ''}
            Check Ollama and API keys in Settings.
          </span>
          <button
            className="rounded bg-accent px-2 py-1 text-xs text-accent-ink"
            onClick={() => useStore.getState().setSettingsOpen(true)}
          >
            Open Settings
          </button>
        </div>
      )}
      {banner && (
        <div
          className={`flex items-center justify-between px-4 py-2 text-sm ${
            banner.kind === 'error'
              ? 'bg-danger/15 text-danger'
              : 'bg-accent/15 text-accent'
          }`}
        >
          <span>{banner.text}</span>
          <button
            className="ml-4 text-xs opacity-70 hover:opacity-100"
            onClick={() => setBanner(null)}
          >
            Dismiss ✕
          </button>
        </div>
      )}
    </div>
  )
}

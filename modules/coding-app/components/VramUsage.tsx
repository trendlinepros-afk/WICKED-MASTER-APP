import { useStore } from '../store'

/**
 * Live GPU VRAM usage meter: "X GB in use of Y GB total", where in-use is the
 * sum of VRAM occupied by currently-loaded Ollama models (from /api/ps) and
 * total is the user's configured GPU VRAM. Lets the user see at a glance how
 * much headroom is left before loading another model.
 */
export function VramUsage({ className = '' }: { className?: string }): JSX.Element | null {
  const ollamaStatus = useStore((s) => s.ollamaStatus)
  const config = useStore((s) => s.config)
  if (!config) return null

  const total = config.gpuVramGb
  const inUse = ollamaStatus?.vramInUseGb ?? 0
  const loadedCount = ollamaStatus?.loadedModels.length ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((inUse / total) * 100)) : 0

  const barColor = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-accent'

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>GPU VRAM in use</span>
        <span className="font-medium text-ink">
          {inUse.toFixed(1)} GB / {total} GB
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-edge/60">
        <div
          className={`h-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-0.5 text-[11px] text-muted">
        {loadedCount === 0
          ? 'No models loaded'
          : `${loadedCount} model${loadedCount > 1 ? 's' : ''} loaded · ~${Math.max(0, total - inUse).toFixed(1)} GB free`}
      </div>
    </div>
  )
}

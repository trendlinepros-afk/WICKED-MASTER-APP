import { FolderOpen, KeyRound, Microscope, Settings } from 'lucide-react'
import type { Settings as AppSettings } from '../shared/types'
import { Spinner } from './Spinner'

interface Props {
  settings: AppSettings | null
  scanning: boolean
  error: string | null
  onOpenFolder(): void
  onOpenRecent(path: string): void
  onOpenSettings(): void
}

export function WelcomeScreen({
  settings,
  scanning,
  error,
  onOpenFolder,
  onOpenRecent,
  onOpenSettings
}: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-bg px-6">
      <Microscope size={64} className="text-accent" strokeWidth={1.5} />
      <h1 className="mt-4 text-2xl font-semibold text-ink">CodeLens</h1>
      <p className="mt-1 max-w-md text-center text-sm text-muted">
        Point it at any project folder and get a visual, plain-English breakdown of what the code
        does — and where the risks hide.
      </p>

      {scanning ? (
        <div className="mt-8">
          <Spinner label="Scanning project…" />
        </div>
      ) : (
        <button
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent/85"
          onClick={onOpenFolder}
        >
          <FolderOpen size={16} /> Open Project Folder
        </button>
      )}

      {error && (
        <p className="mt-4 max-w-md rounded-lg border border-danger/40 bg-danger/10 px-4 py-2 text-center text-xs text-danger">
          {error}
        </p>
      )}

      {settings && settings.recentProjects.length > 0 && !scanning && (
        <div className="mt-8 w-full max-w-md">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
            Recent projects
          </div>
          <div className="space-y-1">
            {settings.recentProjects.map((p) => (
              <button
                key={p}
                className="block w-full truncate rounded-md border border-edge bg-surface px-3 py-2 text-left text-xs text-ink/80 transition-colors hover:bg-raised hover:text-ink"
                onClick={() => onOpenRecent(p)}
                title={p}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-10 flex items-center gap-3 text-xs text-muted/70">
        {settings && (
          <span className="flex items-center gap-1.5">
            <KeyRound
              size={12}
              className={settings.ai.hasKey[settings.ai.provider] ? 'text-ok' : 'text-muted/50'}
            />
            {settings.ai.hasKey[settings.ai.provider]
              ? `AI on — ${settings.ai.model}`
              : 'AI features off — no API key'}
          </span>
        )}
        <button
          className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-accent hover:underline"
          onClick={onOpenSettings}
        >
          <Settings size={12} /> Settings
        </button>
      </div>
    </div>
  )
}

import { FolderOpen, Microscope, RefreshCw, ScrollText, Settings } from 'lucide-react'
import type { ScanResult } from '../shared/types'

interface Props {
  scan: ScanResult
  scanning: boolean
  aiEnabled: boolean
  onOpenFolder(): void
  onRescan(): void
  onSummarize(): void
  onOpenSettings(): void
}

const btn =
  'inline-flex items-center gap-1.5 rounded-md border border-edge bg-raised px-2.5 py-1.5 text-xs text-ink/80 hover:bg-edge/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 transition-colors'

export function Toolbar({
  scan,
  scanning,
  aiEnabled,
  onOpenFolder,
  onRescan,
  onSummarize,
  onOpenSettings
}: Props) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3">
      <div className="flex items-center gap-2">
        <Microscope size={20} className="text-accent" />
        <span className="text-sm font-semibold tracking-wide text-ink">CodeLens</span>
      </div>

      <div className="mx-2 h-5 w-px bg-edge" />

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{scan.projectName}</div>
        <div className="truncate text-[10px] text-muted">{scan.rootPath}</div>
      </div>

      <button className={btn} onClick={onOpenFolder} title="Open another project folder">
        <FolderOpen size={14} /> Open
      </button>
      <button className={btn} onClick={onRescan} disabled={scanning} title="Rescan this project">
        <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} /> Rescan
      </button>
      <button
        className={`${btn} ${aiEnabled ? 'border-accent/40 text-accent' : ''}`}
        onClick={onSummarize}
        disabled={!aiEnabled}
        title={
          aiEnabled
            ? 'Generate a plain-English project report'
            : 'Set an API key in Settings to enable AI features'
        }
      >
        <ScrollText size={14} /> Summarize This Project
      </button>
      <button className={btn} onClick={onOpenSettings} title="Settings">
        <Settings size={14} />
      </button>
    </div>
  )
}

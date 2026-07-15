import { AlertTriangle } from 'lucide-react'
import type { ScanResult } from '../shared/types'
import { SEVERITY_META } from '../utils/lang'

export function StatusBar({ scan, aiLabel }: { scan: ScanResult; aiLabel?: string | null }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const i of scan.issues) counts[i.severity]++

  return (
    <div className="flex h-7 shrink-0 items-center gap-4 border-t border-edge bg-surface px-3 text-[11px] text-muted">
      <span>{scan.fileCount} files</span>
      <span>{scan.edges.length} dependencies</span>
      <span className="flex items-center gap-2">
        {scan.issues.length} findings
        {(Object.keys(counts) as (keyof typeof counts)[]).map(
          (sev) =>
            counts[sev] > 0 && (
              <span key={sev} style={{ color: SEVERITY_META[sev].text }}>
                {counts[sev]} {sev}
              </span>
            )
        )}
      </span>
      <span className="ml-auto flex items-center gap-3">
        <span className={aiLabel ? 'text-ink/80' : ''}>{aiLabel ? `AI: ${aiLabel}` : 'AI off'}</span>
        {scan.truncated && (
          <span className="flex items-center gap-1 text-warn">
            <AlertTriangle size={11} /> large project — scan truncated
          </span>
        )}
        <span>scanned in {(scan.durationMs / 1000).toFixed(1)}s</span>
      </span>
    </div>
  )
}

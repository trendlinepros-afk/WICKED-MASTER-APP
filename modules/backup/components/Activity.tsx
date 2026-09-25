import { useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useBackup, inv } from '../store'
import type { HistoryEntry, PlanView } from '../types'
import { btn, card, fmtBytes, fmtCount, fmtDateTime, fmtDuration, StatusIcon, statusLabel } from './ui'

const KIND: Record<HistoryEntry['kind'], string> = {
  backup: 'Backup',
  restore: 'Restore',
  validate: 'Validation',
  cloud: 'Google Drive copy'
}

function Row({ h }: { h: HistoryEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = h.errors.length > 0
  return (
    <li className="py-2.5">
      <button className="flex w-full items-start gap-3 text-left" onClick={() => expandable && setOpen(!open)}>
        <div className="pt-0.5">
          <StatusIcon status={h.status} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-ink">
              {KIND[h.kind]}
              {h.mode ? ` (${h.mode})` : ''}
            </span>
            <span className="text-xs text-muted">{statusLabel(h.status)}</span>
            <span className="text-xs text-muted">· {fmtDateTime(h.startedAt)}</span>
            <span className="text-xs text-muted">· took {fmtDuration(h.endedAt - h.startedAt)}</span>
            {h.trigger !== 'manual' && (
              <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                {h.trigger === 'mcp' ? 'AI agent' : h.trigger === 'missed' ? 'missed run' : 'scheduled'}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-sm text-muted">{h.message}</div>
          {(h.kind === 'backup' || h.kind === 'restore') && h.status !== 'failed' && h.status !== 'cancelled' && (
            <div className="mt-0.5 text-xs text-muted">
              {h.kind === 'backup'
                ? `${fmtCount(h.files)} files (${fmtBytes(h.bytes)}) in this version · ${fmtCount(h.filesDone)} copied (${fmtBytes(h.bytesDone)})`
                : `${fmtCount(h.filesDone)} of ${fmtCount(h.files)} files restored (${fmtBytes(h.bytesDone)})`}
            </div>
          )}
        </div>
        {expandable && (
          <span className="flex items-center gap-1 pt-0.5 text-xs text-warn">
            {fmtCount(h.errorCount)} issue{h.errorCount === 1 ? '' : 's'} {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-7 mt-2 max-h-64 overflow-y-auto rounded-lg border border-edge bg-bg p-2">
          {h.errors.map((e, i) => (
            <div key={i} className="flex gap-3 py-0.5 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono text-ink" title={e.path}>
                {e.path}
              </span>
              <span className="shrink-0 text-muted">{e.error}</span>
            </div>
          ))}
          {h.errorCount > h.errors.length && <div className="pt-1 text-xs text-muted">…and {fmtCount(h.errorCount - h.errors.length)} more</div>}
        </div>
      )}
    </li>
  )
}

export default function Activity({ plan }: { plan: PlanView }): React.JSX.Element {
  const history = useBackup((s) => s.history).filter((h) => h.planId === plan.id)
  return (
    <div className={`${card} p-4`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">Activity</span>
        <button className={btn} disabled={!history.length} onClick={() => void inv('clear-history', { planId: plan.id })}>
          <Trash2 size={14} /> Clear
        </button>
      </div>
      {history.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No backups, restores or validations yet.</p>
      ) : (
        <ul className="divide-y divide-edge">
          {history.map((h) => (
            <Row key={h.id} h={h} />
          ))}
        </ul>
      )}
    </div>
  )
}

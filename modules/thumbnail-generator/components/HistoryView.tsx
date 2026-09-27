import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, Gauge, History, LoaderCircle, Sparkles, Trash2 } from 'lucide-react'
import { inv, useThumbs, type HistoryItem } from '../store'
import { modelInfo } from '../lib/models'
import { btn, btnSm, card, fmtAgo, Pill, Thumb } from './ui'

function Row({ g }: { g: HistoryItem }): React.JSX.Element {
  const s = useThumbs()
  const [busy, setBusy] = useState(false)
  const score = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('score', { generatedId: g.id, title: g.prompt })) as { ok: boolean; error?: string }
    setBusy(false)
    if (!r.ok) s.showToast('err', r.error ?? 'Could not score')
    await s.loadHistory()
  }
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="relative">
        <Thumb path={g.exists ? g.file : undefined} aspect={g.format === '9:16' ? '9/16' : g.format === '1:1' ? '1/1' : '16/9'} className="rounded-none" />
        {g.score && (
          <div className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-semibold text-white" title={g.score.suggestion}>
            {g.score.main}/10
          </div>
        )}
        {g.status === 'failed' && <div className="absolute inset-0 flex items-center justify-center bg-black/50 p-2 text-center text-xs text-white">{g.error}</div>}
        {!g.exists && g.status === 'done' && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">file moved or deleted</div>}
      </div>
      <div className="p-2.5">
        <div className="truncate text-xs text-ink" title={g.prompt}>
          {g.prompt || (g.kind === 'image' ? 'Recreate' : 'Edit')}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-muted">
          <Pill>{g.kind === 'edit' ? 'edit' : modelInfo(g.model).label}</Pill>
          <span>{g.format}</span>
          {g.personaId && <Pill tone="accent">persona</Pill>}
          {g.styleId && <Pill tone="accent">theme</Pill>}
          {g.creditsUsed != null && <span>{g.creditsUsed} cr</span>}
          <span className="ml-auto">{fmtAgo(g.at)}</span>
        </div>
        <div className="mt-2 flex items-center gap-1">
          {g.exists && (
            <>
              <button className={btnSm} onClick={() => void inv('open', { path: g.file })} title="Open">
                <ExternalLink size={12} />
              </button>
              <button className={btnSm} onClick={() => void inv('open', { path: g.file, reveal: true })} title="Show in folder">
                <FolderOpen size={12} />
              </button>
              <button className={btnSm} disabled={busy} onClick={() => void score()} title="Score">
                {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Gauge size={12} />}
              </button>
              <button className={btnSm} onClick={() => s.recreateFrom({ path: g.file, label: g.fileName })} title="Recreate from this">
                <Sparkles size={12} />
              </button>
            </>
          )}
          <button className={`${btnSm} ml-auto text-danger`} onClick={() => void inv('history-remove', { id: g.id, deleteFile: false }).then(() => s.loadHistory())} title="Remove from history (keeps the file)">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default function HistoryView(): React.JSX.Element {
  const s = useThumbs()
  useEffect(() => {
    void s.loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const done = s.history.filter((g) => g.status === 'done')
  const credits = done.reduce((a, g) => a + (g.creditsUsed ?? 0), 0)
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-ink">History</h1>
            <p className="text-sm text-muted">
              {done.length} thumbnail{done.length === 1 ? '' : 's'} generated on this PC{credits ? ` · ${credits} credits reported by Pikzels` : ''}
            </p>
          </div>
          <button className={btn} onClick={() => void inv('open', { folder: true })}>
            <FolderOpen size={14} /> Open folder
          </button>
          <button className={btn} disabled={!s.history.length} onClick={() => void inv('history-clear').then(() => s.loadHistory())}>
            <Trash2 size={14} /> Clear history
          </button>
        </div>
        {s.history.length === 0 ? (
          <div className={`${card} flex flex-col items-center gap-2 p-12 text-center text-sm text-muted`}>
            <History size={22} className="text-accent" />
            Nothing generated yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {s.history.map((g) => (
              <Row key={g.id} g={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

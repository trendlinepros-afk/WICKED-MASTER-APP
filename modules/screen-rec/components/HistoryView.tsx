import { useEffect } from 'react'
import { Clapperboard, ExternalLink, FolderOpen, Music, Trash2 } from 'lucide-react'
import { inv, useRec } from '../store'
import { fmtBytes, fmtDuration } from '../lib/geometry'
import { btn, btnIcon, card, fmtWhen } from './ui'

export default function HistoryView(): React.JSX.Element {
  const s = useRec()
  useEffect(() => {
    void s.loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const open = async (id: string, reveal: boolean): Promise<void> => {
    const r = (await inv('history-open', { id, reveal })) as { ok: boolean; error?: string }
    if (!r.ok) s.showToast('err', r.error ?? 'Could not open it')
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-ink">Finished videos</h1>
            <p className="text-sm text-muted">Everything you’ve rendered on this PC.</p>
          </div>
          <button className={btn} onClick={() => void inv('open-folder', 'output')}>
            <FolderOpen size={14} /> Open folder
          </button>
        </div>
        {s.history.length === 0 ? (
          <div className={`${card} flex flex-col items-center gap-2 p-12 text-center text-sm text-muted`}>
            <Clapperboard size={24} className="text-accent" />
            No videos yet — complete a session to render your first one.
          </div>
        ) : (
          <div className={`${card} divide-y divide-edge`}>
            {s.history.map((h) => (
              <div key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${h.exists ? 'bg-accent/15 text-accent' : 'bg-raised text-muted'}`}>
                  <Clapperboard size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink" title={h.file}>
                    {h.file.split(/[\\/]/).pop()}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <span>{fmtWhen(h.createdAt)}</span>
                    <span>· {fmtDuration(h.durationSec * 1000)}</span>
                    <span>
                      · {h.clipCount} clip{h.clipCount === 1 ? '' : 's'}
                    </span>
                    <span>· {fmtBytes(h.bytes)}</span>
                    {h.music && (
                      <span className="inline-flex items-center gap-1">
                        · <Music size={11} /> {h.music}
                      </span>
                    )}
                    {!h.exists && <span className="text-warn">· moved or deleted</span>}
                  </div>
                </div>
                <button className={btnIcon} disabled={!h.exists} onClick={() => void open(h.id, false)} title="Play">
                  <ExternalLink size={15} />
                </button>
                <button className={btnIcon} disabled={!h.exists} onClick={() => void open(h.id, true)} title="Show in folder">
                  <FolderOpen size={15} />
                </button>
                <button className={`${btnIcon} hover:text-danger`} onClick={() => void inv('history-remove', h.id).then(() => s.loadHistory())} title="Remove from this list (keeps the file)">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

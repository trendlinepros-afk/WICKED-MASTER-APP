/**
 * Stage 4 approval gate — the AI's graphic plan is presented BEFORE any
 * HyperFrames rendering. The user can edit slot text, toggle each graphic,
 * then approve; only approved graphics render (protects render time and
 * API budget). The modal closes as soon as approval is submitted — the main
 * process flips the stage out of 'awaiting-approval' immediately.
 */
import { useEffect, useState } from 'react'
import { useStore, formatTime } from '../store'
import { api } from '../lib/api'
import { btn, btnPrimary, input, panel } from '../lib/ui'
import type { GraphicEvent } from '../shared/types'

type Item = GraphicEvent & { approved: boolean }

export default function GraphicsApproval() {
  const project = useStore((s) => s.project)
  const planned = project?.edl.graphics.filter((g) => g.status === 'planned') ?? []
  // ONE local list: plan + approval flag together. Synced against the store
  // if a push changes the planned set while the modal is open.
  const [items, setItems] = useState<Item[]>(() => planned.map((g) => ({ ...g, approved: true })))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const plannedKey = planned.map((g) => g.id).join(',')
  useEffect(() => {
    setItems((cur) => {
      const curById = new Map(cur.map((i) => [i.id, i]))
      return planned.map((g) => curById.get(g.id) ?? { ...g, approved: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedKey])

  // Escape acts as "Skip all graphics" so the blocking modal is never a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) submit([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, items])

  if (!project) return null

  function updateSlot(id: string, slot: string, value: string) {
    setItems((cur) => cur.map((g) => (g.id === id ? { ...g, slots: { ...g.slots, [slot]: value } } : g)))
  }

  async function submit(approvedIds: string[]) {
    setSubmitting(true)
    setError(null)
    const edits = items.map(({ approved, ...g }) => g)
    try {
      await api.approveGraphics(project!.id, approvedIds, edits)
      // On success the main process flips the stage out of 'awaiting-approval'
      // and this modal unmounts; leave `submitting` true until then.
    } catch (err: any) {
      setSubmitting(false)
      setError(err?.message ?? 'Could not start the graphics render. Try again.')
    }
  }

  const approvedCount = items.filter((g) => g.approved).length

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-8">
      <div className={`${panel} max-w-2xl w-full max-h-[80vh] flex flex-col`} role="dialog" aria-modal="true" aria-label="Graphics plan approval">
        <div className="p-4 border-b border-edge">
          <h2 className="font-bold text-ink">Graphics plan — approve before rendering</h2>
          <p className="text-xs text-muted mt-1">
            Nothing renders until you approve. Uncheck what you don&apos;t want; edit any text. HyperFrames renders only
            the approved list.
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {items.length === 0 && <p className="text-sm text-muted">The AI planned no graphics for this video.</p>}
          {items.map((g) => (
            <div key={g.id} className={`${panel} bg-raised p-3 ${g.approved ? '' : 'opacity-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  checked={g.approved}
                  onChange={(e) =>
                    setItems((cur) => cur.map((x) => (x.id === g.id ? { ...x, approved: e.target.checked } : x)))
                  }
                  className="accent-accent"
                />
                <span className="text-sm font-medium text-accent">{g.templateId}</span>
                <span className="text-xs font-mono text-muted">
                  @ {formatTime(g.at)} · {g.durationSec}s
                </span>
              </div>
              {g.rationale && <p className="text-xs text-muted mb-2 ml-6">{g.rationale}</p>}
              <div className="ml-6 grid gap-1.5">
                {Object.entries(g.slots).map(([slot, value]) => (
                  <label key={slot} className="flex items-center gap-2 text-xs">
                    <span className="w-24 text-muted shrink-0">{slot}</span>
                    <input className={`${input} !py-1`} value={value} onChange={(e) => updateSlot(g.id, slot, e.target.value)} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 border-t border-edge flex justify-end items-center gap-2">
          {error && <span className="text-xs text-danger mr-auto">{error}</span>}
          <button className={btn} disabled={submitting} onClick={() => submit([])}>
            Skip all graphics
          </button>
          <button
            className={btnPrimary}
            disabled={submitting}
            onClick={() => submit(items.filter((g) => g.approved).map((g) => g.id))}
          >
            {submitting ? 'Starting render…' : `Approve ${approvedCount} & render`}
          </button>
        </div>
      </div>
    </div>
  )
}

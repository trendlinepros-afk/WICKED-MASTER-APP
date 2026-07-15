import { useEffect, useState } from 'react'
import type { Prereq } from '../shared/types'
import { api } from '../lib/bridge'

/**
 * On first mount, checks external prerequisites (Ollama, Node.js) and, if any
 * are missing, shows a one-time notification listing what's absent, what it
 * affects, and a button to open its download page. Nothing here blocks using
 * the module — it's purely informational so a user without a prerequisite
 * knows why a feature (e.g. local models) is unavailable.
 */
export function PrereqNotice(): JSX.Element | null {
  const [missing, setMissing] = useState<Prereq[] | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true
    void api
      .checkPrereqs()
      .then((prereqs) => {
        if (!alive) return
        const absent = prereqs.filter((p) => !p.installed)
        setMissing(absent)
      })
      .catch(() => setMissing([]))
    return () => {
      alive = false
    }
  }, [])

  if (dismissed || !missing || missing.length === 0) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[460px] rounded-lg border border-edge bg-raised p-5 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-ink">
          Some prerequisites are missing
        </h2>
        <p className="mb-4 text-sm text-muted">
          The app works without these, but the features below are unavailable
          until they're installed. You can install them any time and restart.
        </p>

        <div className="space-y-3">
          {missing.map((p) => (
            <div key={p.id} className="rounded border border-edge bg-surface p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-ink">{p.name}</span>
                <button
                  type="button"
                  className="rounded bg-accent px-3 py-1 text-xs text-accent-ink hover:opacity-90"
                  onClick={() => void api.openExternal(p.downloadUrl)}
                >
                  Download {p.name}
                </button>
              </div>
              <p className="text-xs text-muted">{p.impact}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="rounded border border-edge px-3 py-1.5 text-sm text-ink hover:bg-edge/60"
            onClick={() => setDismissed(true)}
          >
            Continue anyway
          </button>
        </div>
      </div>
    </div>
  )
}

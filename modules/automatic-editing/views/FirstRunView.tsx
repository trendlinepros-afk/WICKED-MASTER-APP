/**
 * First-run setup — shown once, before anything else, until the user chooses
 * a master folder where all projects and intermediate renders will live.
 */
import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { btn, btnPrimary, input, label, panel } from '../lib/ui'

export default function FirstRunView() {
  const completeOnboarding = useStore((s) => s.completeOnboarding)
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose() {
    setError(null)
    const picked = await api.pickDirectory()
    if (picked) setDir(picked)
  }

  async function finish(useDefault: boolean) {
    setBusy(true)
    setError(null)
    try {
      await completeOnboarding(useDefault ? null : dir)
    } catch (err: any) {
      setError(err?.message ?? 'Could not set that folder. Pick a different one.')
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-bg p-8">
      <div className={`${panel} max-w-xl w-full p-8`}>
        <h1 className="text-3xl font-bold text-ink mb-1">
          Welcome to Automatic <span className="text-accent">Editing</span>
        </h1>
        <p className="text-sm text-muted mb-6">
          First, choose a <b className="text-ink">master folder</b>. Every project you create — and all its
          intermediate renders and exports — will live inside it. Your source videos stay wherever they already are:
          they are linked in place and never copied, moved, or modified.
        </p>

        <div className={`${panel} bg-raised p-4 mb-4`}>
          <div className={label}>Projects folder</div>
          <div className="flex items-center gap-2">
            <span className={`${input} flex-1 truncate text-muted`}>
              {dir ?? 'No folder chosen — a default location will be used'}
            </span>
            <button className={`${btn} shrink-0`} onClick={choose} disabled={busy}>
              Choose folder…
            </button>
          </div>
          <p className="text-[11px] text-muted mt-2">
            Pick a drive with plenty of free space — video renders are large. <b>Projects</b> and <b>Assets</b>{' '}
            subfolders are created inside it. You can change this later.
          </p>
        </div>

        {error && <p className="text-xs text-danger mb-3">{error}</p>}

        <div className="flex items-center justify-between">
          <button className="text-xs text-muted hover:text-ink" onClick={() => finish(true)} disabled={busy}>
            Use default location instead
          </button>
          <button className={btnPrimary} onClick={() => finish(false)} disabled={busy || !dir}>
            {busy ? 'Setting up…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

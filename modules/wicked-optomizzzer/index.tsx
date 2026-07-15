import { useEffect, useState } from 'react'
import { ExternalLink, FolderSearch, Gauge, ShieldAlert } from 'lucide-react'

const ID = 'wicked-optomizzzer'

interface Status {
  path: string
  exists: boolean
}

export default function WickedOptomizzzer(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [message, setMessage] = useState('')

  const refresh = async (): Promise<void> => {
    setStatus((await window.wicked.invoke(`${ID}:status`)) as Status)
  }

  useEffect(() => {
    refresh()
  }, [])

  const launch = async (): Promise<void> => {
    setMessage('')
    const res = (await window.wicked.invoke(`${ID}:launch`)) as { ok: boolean; error?: string }
    setMessage(res.ok ? 'Launched — check for the UAC prompt.' : `Launch failed: ${res.error}`)
  }

  const browse = async (): Promise<void> => {
    const picked = (await window.wicked.invoke(`${ID}:pick-path`)) as string | null
    if (picked) refresh()
  }

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto p-10">
      <div className="w-full max-w-2xl">
        <div className="rounded-2xl border border-edge bg-surface p-8">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
              <Gauge size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Wicked Optomizzzer</h1>
              <p className="text-sm text-muted">
                System cleaner, services, startup, drivers, performance & updates
              </p>
            </div>
          </div>

          <div className="mt-6 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 p-4 text-sm">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-warn" />
            <p>
              This module wraps the native WPF app, which requires administrator rights for
              registry, services and driver work. WICKED stays unelevated — the UAC prompt
              appears only when you launch the optimizer here.
            </p>
          </div>

          <div className="mt-5 rounded-xl border border-edge bg-raised/50 p-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Program</div>
            <div className="mt-1 break-all font-mono text-sm">{status?.path ?? '…'}</div>
            <div className={`mt-1 text-xs ${status?.exists ? 'text-ok' : 'text-danger'}`}>
              {status ? (status.exists ? 'Found' : 'Not found — click Browse to locate it') : ''}
            </div>
          </div>

          <div className="mt-6 flex items-center gap-2">
            <button
              onClick={launch}
              disabled={!status?.exists}
              className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              <ExternalLink size={15} />
              Launch Optomizzzer
            </button>
            <button
              onClick={browse}
              className="flex items-center gap-2 rounded-lg bg-raised px-4 py-2.5 text-sm font-medium hover:bg-edge/60"
            >
              <FolderSearch size={15} />
              Browse…
            </button>
          </div>
          {message && <p className="mt-3 text-sm text-muted">{message}</p>}
        </div>

        <p className="mt-4 px-2 text-xs text-muted">
          Full port of the 34-view WPF app into WICKED is planned incrementally; this launcher
          keeps the tool one click away meanwhile.
        </p>
      </div>
    </div>
  )
}

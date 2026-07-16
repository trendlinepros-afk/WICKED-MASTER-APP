import { DownloadCloud } from 'lucide-react'
import { useUpdates } from '@/stores/updates'

/**
 * Shown when an update has been downloaded and is ready to install. Offers
 * exactly two actions: Install & Restart, or I'll do this later.
 */
export default function UpdateDialog(): React.JSX.Element | null {
  const phase = useUpdates((s) => s.phase)
  const version = useUpdates((s) => s.version)
  const install = useUpdates((s) => s.install)
  const later = useUpdates((s) => s.later)

  if (phase !== 'downloaded' || !version) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <DownloadCloud size={20} />
          </span>
          <div>
            <div className="font-semibold">Update available</div>
            <div className="text-sm text-muted">
              WICKED {version} is ready to install.
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={later}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
          >
            I’ll do this later
          </button>
          <button
            onClick={install}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Install &amp; Restart
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          If you pick “later,” the update installs automatically the next time you quit WICKED.
        </p>
      </div>
    </div>
  )
}

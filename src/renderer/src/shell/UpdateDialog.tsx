import { useEffect, useState } from 'react'
import { DownloadCloud } from 'lucide-react'
import { SHELL_IPC, type UpdateEvent } from '@shared/types'

/**
 * Listens for updater events from main. When an update has been downloaded,
 * offers exactly two actions: Install & Restart, or Postpone.
 */
export default function UpdateDialog(): React.JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return window.wicked.on(SHELL_IPC.updateEvent, (raw) => {
      const ev = raw as UpdateEvent
      if (ev.kind === 'downloaded') {
        setVersion(ev.version)
        setDismissed(false)
      }
    })
  }, [])

  if (!version || dismissed) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <DownloadCloud size={20} />
          </span>
          <div>
            <div className="font-semibold">Update ready</div>
            <div className="text-sm text-muted">WICKED {version} has been downloaded.</div>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={() => {
              setDismissed(true)
              window.wicked.invoke(SHELL_IPC.updatePostpone)
            }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
          >
            Postpone
          </button>
          <button
            onClick={() => window.wicked.invoke(SHELL_IPC.updateInstall)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Install &amp; Restart
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Postponed updates install automatically the next time WICKED quits.
        </p>
      </div>
    </div>
  )
}

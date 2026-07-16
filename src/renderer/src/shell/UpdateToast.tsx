import { useEffect } from 'react'
import { CheckCircle2, Loader2, TriangleAlert, X } from 'lucide-react'
import { useUpdates } from '@/stores/updates'

/**
 * Small transient status chip for the update check (checking / up-to-date /
 * error). The "downloaded" outcome is handled by UpdateDialog instead.
 */
export default function UpdateToast(): React.JSX.Element | null {
  const phase = useUpdates((s) => s.phase)
  const message = useUpdates((s) => s.message)
  const showStatus = useUpdates((s) => s.showStatus)
  const dismissStatus = useUpdates((s) => s.dismissStatus)

  const terminal = phase === 'none' || phase === 'error'

  useEffect(() => {
    if (showStatus && terminal) {
      const t = setTimeout(dismissStatus, 6000)
      return () => clearTimeout(t)
    }
    return undefined
  }, [showStatus, terminal, dismissStatus])

  if (!showStatus || phase === 'idle' || phase === 'downloaded') return null

  const busy = phase === 'checking' || phase === 'available'

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex max-w-md items-center gap-3 rounded-xl border border-edge bg-surface px-4 py-3 shadow-2xl">
        {busy && <Loader2 size={18} className="shrink-0 animate-spin text-accent" />}
        {phase === 'none' && <CheckCircle2 size={18} className="shrink-0 text-ok" />}
        {phase === 'error' && <TriangleAlert size={18} className="shrink-0 text-warn" />}
        <span className="text-sm text-ink">{message}</span>
        {terminal && (
          <button
            onClick={dismissStatus}
            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}

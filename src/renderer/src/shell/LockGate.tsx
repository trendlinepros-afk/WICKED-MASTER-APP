import { useEffect, useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import { SHELL_IPC } from '@shared/types'
import { BrandMark } from './BrandLogo'

/**
 * Optional launch lock. When an app-lock PIN is set (Settings → App Lock), the
 * shell is hidden behind this screen until the PIN is entered. It's a
 * convenience gate on top of the running app — the real protection for synced
 * data is the sync passphrase (which encrypts everything before it leaves the
 * PC); local data at rest isn't encrypted by this PIN.
 */
export default function LockGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [unlocked, setUnlocked] = useState(false)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.wicked
      .invoke(SHELL_IPC.appLockStatus)
      .then((s) => setEnabled((s as { enabled?: boolean }).enabled === true))
      .catch(() => setEnabled(false))
  }, [])

  const unlock = async (): Promise<void> => {
    if (!pin.trim() || checking) return
    setChecking(true)
    setError('')
    try {
      const res = (await window.wicked.invoke(SHELL_IPC.appLockVerify, pin)) as { ok?: boolean }
      if (res.ok) setUnlocked(true)
      else setError('Wrong PIN — try again.')
    } finally {
      setChecking(false)
      setPin('')
    }
  }

  if (enabled === null) return <>{children}</>
  if (!enabled || unlocked) return <>{children}</>

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-80 rounded-2xl border border-edge bg-surface p-7 text-center shadow-2xl">
        <div className="flex justify-center">
          <BrandMark size={44} />
        </div>
        <h1 className="mt-4 flex items-center justify-center gap-2 text-lg font-bold tracking-tight">
          <Lock size={16} className="text-accent" /> WICKED is locked
        </h1>
        <p className="mt-1 text-xs text-muted">Enter your app PIN to continue.</p>
        <input
          type="password"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void unlock()
          }}
          placeholder="PIN"
          className="mt-4 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-center text-sm outline-none focus:border-accent"
        />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <button
          onClick={() => void unlock()}
          disabled={!pin.trim() || checking}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {checking ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
          Unlock
        </button>
      </div>
    </div>
  )
}

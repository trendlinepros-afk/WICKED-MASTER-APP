import { useEffect, useState } from 'react'
import { BookLock, Eye, EyeOff, LoaderCircle, LockKeyhole, ShieldAlert } from 'lucide-react'
import { useDocs } from '../store'
import { btnAccent, input, strengthOf } from './ui'

const MIN = 4

function PasswordBox({
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  autoFocus?: boolean
  onEnter?: () => void
  disabled?: boolean
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`${input} pr-10 text-base tracking-wide`}
      />
      <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-ink" title={show ? 'Hide' : 'Show'}>
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

function Setup(): React.JSX.Element {
  const setup = useDocs((s) => s.setup)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const strength = strengthOf(pw)
  const ready = pw.length >= MIN && pw === confirm

  const go = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    const err = await setup(pw)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <>
      <h1 className="text-xl font-bold text-ink">Set a password for Documentation</h1>
      <p className="mt-1 text-sm text-muted">
        You’ll enter it each time you open this tool. It also encrypts every stored password, licence key and 2FA secret.
      </p>
      <div className="mt-5 space-y-3">
        <PasswordBox value={pw} onChange={setPw} placeholder={`Password (at least ${MIN} characters)`} autoFocus />
        {pw && (
          <div>
            <div className="flex gap-1">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className={`h-1.5 flex-1 rounded-full ${i <= strength.score ? (strength.score <= 1 ? 'bg-danger' : strength.score === 2 ? 'bg-warn' : 'bg-ok') : 'bg-raised'}`} />
              ))}
            </div>
            <div className={`mt-1 text-xs ${strength.score <= 1 ? 'text-danger' : strength.score === 2 ? 'text-warn' : 'text-muted'}`}>{strength.label}</div>
          </div>
        )}
        <PasswordBox value={confirm} onChange={setConfirm} placeholder="Confirm password" onEnter={() => void go()} />
        {confirm && pw !== confirm && <div className="text-xs text-danger">Passwords don’t match.</div>}
        {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <button className={`${btnAccent} w-full py-2.5`} disabled={!ready || busy} onClick={() => void go()}>
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <LockKeyhole size={16} />} Set password & open
        </button>
      </div>
      <div className="mt-5 flex gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-xs text-ink">
        <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" />
        <div>
          <b>There is no “forgot password”.</b> Everything except secret fields stays readable, but stored passwords can’t be recovered without it. A
          4-digit PIN is accepted; a longer passphrase is much harder to guess if someone copies your files.
        </div>
      </div>
    </>
  )
}

function Unlock(): React.JSX.Element {
  const status = useDocs((s) => s.status)
  const unlock = useDocs((s) => s.unlock)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(status?.retryAfter ?? 0)

  useEffect(() => {
    setRetry(status?.retryAfter ?? 0)
  }, [status?.retryAfter])
  useEffect(() => {
    if (retry <= 0) return
    const t = setTimeout(() => setRetry((r) => r - 1), 1000)
    return () => clearTimeout(t)
  }, [retry])

  const go = async (): Promise<void> => {
    if (!pw || busy || retry > 0) return
    setBusy(true)
    setError('')
    const r = await unlock(pw)
    setBusy(false)
    if (r.error) {
      setError(r.error)
      setRetry(r.retryAfter)
      setPw('')
    }
  }

  return (
    <>
      <h1 className="text-xl font-bold text-ink">Documentation is locked</h1>
      <p className="mt-1 text-sm text-muted">Enter your Documentation password to continue.</p>
      <div className="mt-5 space-y-3">
        <PasswordBox value={pw} onChange={setPw} placeholder="Password" autoFocus onEnter={() => void go()} disabled={retry > 0} />
        {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        <button className={`${btnAccent} w-full py-2.5`} disabled={!pw || busy || retry > 0} onClick={() => void go()}>
          {busy ? <LoaderCircle size={16} className="animate-spin" /> : <LockKeyhole size={16} />}
          {retry > 0 ? `Try again in ${retry}s` : 'Unlock'}
        </button>
        {(status?.failedAttempts ?? 0) >= 3 && <p className="text-center text-xs text-muted">{status?.failedAttempts} failed attempts — the wait doubles each time.</p>}
      </div>
    </>
  )
}

export default function LockScreen(): React.JSX.Element {
  const status = useDocs((s) => s.status)
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6">
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-7 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15">
            <BookLock size={24} className="text-accent" />
          </div>
          <div>
            <div className="text-sm font-semibold text-ink">Documentation</div>
            <div className="text-xs text-muted">Configurations · Passwords · Domains · Networks</div>
          </div>
        </div>
        {status?.configured ? <Unlock /> : <Setup />}
      </div>
    </div>
  )
}

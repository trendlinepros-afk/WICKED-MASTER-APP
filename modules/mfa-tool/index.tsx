import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  FlaskConical,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  QrCode,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import manifest from './module.json'
import { b32decode, b32encode } from './lib/encoding'
import { accountLabel, accountsFromPayloads, type VaultAccount } from './lib/migration'
import { decodeImageFile } from './lib/qr'
import { runSelfTest, type SelfTestReport } from './lib/selftest'
import { formatCode, generateCode, secondsRemaining } from './lib/totp'
import { useMfa, type Account } from './store'

export default function MfaTool(): React.JSX.Element {
  const phase = useMfa((s) => s.phase)

  useEffect(() => {
    void useMfa.getState().init()
  }, [])

  return (
    <div className="relative h-full overflow-hidden">
      {phase === 'loading' && (
        <div className="flex h-full items-center justify-center text-muted">
          <Loader2 className="animate-spin" size={22} />
        </div>
      )}
      {(phase === 'create' || phase === 'locked') && <Gate />}
      {phase === 'unlocked' && <VaultView />}
    </div>
  )
}

/* ---------------------------------------------------------------- gate --- */

function Gate(): React.JSX.Element {
  const phase = useMfa((s) => s.phase)
  const status = useMfa((s) => s.status)
  const storeError = useMfa((s) => s.error)
  const busy = useMfa((s) => s.busy)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const creating = phase === 'create'

  const submit = async (): Promise<void> => {
    setLocalError(null)
    if (!pw) {
      setLocalError('Password cannot be empty.')
      return
    }
    if (creating && pw !== pw2) {
      setLocalError('Passwords do not match.')
      return
    }
    const st = useMfa.getState()
    if (creating) await st.createVault(pw)
    else await st.unlock(pw)
  }

  const importLegacy = async (): Promise<void> => {
    setLocalError(null)
    if (!pw) {
      setLocalError('Enter the legacy vault password in the field above first.')
      return
    }
    await useMfa.getState().importLegacy(pw)
  }

  const error = localError ?? storeError

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
            <ShieldCheck size={20} />
          </span>
          <h1 className="text-xl font-bold tracking-tight">MFA Tool</h1>
          <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn">Beta</span>
        </div>

        <p className="mt-4 text-sm text-muted">
          {creating
            ? 'Set a master password to encrypt your accounts. There is no recovery if you forget it.'
            : 'Enter your master password to unlock the vault.'}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Master password"
            className="mt-4 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          {creating && (
            <input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="Confirm password"
              className="mt-2 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
            />
          )}

          {error && <p className="mt-3 text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 className="animate-spin" size={15} /> : <KeyRound size={15} />}
            {creating ? 'Create vault' : 'Unlock'}
          </button>
        </form>

        {creating && status?.legacyExists && (
          <div className="mt-6 rounded-lg border border-edge bg-raised p-3 text-xs text-muted">
            <p>
              Found a vault from the standalone MFA Tool at{' '}
              <span className="break-all font-mono">{status.legacyPath}</span>. The formats are
              identical — enter its master password above and import it.
            </p>
            <button
              onClick={() => void importLegacy()}
              disabled={busy}
              className="mt-2 rounded-lg bg-surface px-3 py-1.5 font-medium text-ink hover:bg-edge/60 disabled:opacity-50"
            >
              Unlock &amp; import legacy vault
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- vault --- */

function VaultView(): React.JSX.Element {
  const accounts = useMfa((s) => s.accounts)
  const error = useMfa((s) => s.error)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [modal, setModal] = useState<'add' | 'import' | 'selftest' | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-6 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-raised text-accent">
          <ShieldCheck size={18} />
        </span>
        <div>
          <h1 className="text-base font-bold leading-tight tracking-tight">MFA Tool</h1>
          <p className="text-xs text-muted">
            {accounts.length} account{accounts.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setModal('import')}
          className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
        >
          <QrCode size={15} />
          Import
        </button>
        <button
          onClick={() => setModal('add')}
          className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          <Plus size={15} />
          Add
        </button>
        <button
          onClick={() => useMfa.getState().lock()}
          title="Lock the vault"
          className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
        >
          <Lock size={15} />
          Lock
        </button>
      </header>

      {error && (
        <div className="mx-6 mt-3 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => useMfa.getState().clearError()} className="hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {accounts.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted">
              <p className="font-medium">No accounts yet.</p>
              <p className="mt-2">
                Click &ldquo;Import&rdquo; and pick a Google Authenticator export image,
                <br />
                or &ldquo;Add&rdquo; to enter one by hand.
              </p>
            </div>
          ) : (
            accounts.map((a) => <AccountRow key={a.id} account={a} nowMs={nowMs} />)
          )}
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-edge px-6 py-2 text-xs text-muted">
        <span>
          MFA Tool v{manifest.version} &middot; Beta &middot; vault encrypted with AES-256-GCM +
          scrypt
        </span>
        <button
          onClick={() => setModal('selftest')}
          className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-raised hover:text-ink"
        >
          <FlaskConical size={12} />
          Run self-test
        </button>
      </footer>

      {modal === 'add' && <AddModal onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal onClose={() => setModal(null)} />}
      {modal === 'selftest' && <SelfTestModal onClose={() => setModal(null)} />}
    </div>
  )
}

/* ----------------------------------------------------------------- row --- */

function AccountRow({ account, nowMs }: { account: Account; nowMs: number }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const confirmTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    },
    []
  )

  let code: string | null = null
  let codeError: string | null = null
  try {
    code = generateCode(account, nowMs)
  } catch (err) {
    codeError = err instanceof Error ? err.message : String(err)
  }

  const remaining = secondsRemaining(account.period, nowMs)

  const copy = async (): Promise<void> => {
    if (code === null) return
    await navigator.clipboard.writeText(code)
    setCopied(true)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200)
  }

  const remove = (): void => {
    if (!confirming) {
      setConfirming(true)
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 2500)
      return
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    void useMfa.getState().removeAccount(account.id)
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-edge bg-surface px-4 py-3">
      <Ring period={account.period} remaining={remaining} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{account.issuer || account.name}</span>
          {account.type === 'hotp' && (
            <span
              className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-warn"
              title="Stored as HOTP; the code shown is time-based — a quirk carried over from the original tool."
            >
              hotp
            </span>
          )}
        </div>
        {account.issuer && <div className="truncate text-sm text-muted">{account.name}</div>}
      </div>

      {code !== null ? (
        <button
          onClick={() => void copy()}
          title="Click to copy"
          className="font-mono text-2xl font-bold tracking-wider text-accent hover:opacity-80"
        >
          {formatCode(code)}
        </button>
      ) : (
        <span className="flex items-center gap-1.5 text-sm text-danger" title={codeError ?? ''}>
          <AlertTriangle size={14} />
          n/a
        </span>
      )}

      <button
        onClick={() => void copy()}
        disabled={code === null}
        className="flex w-24 items-center justify-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
      >
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <button
        onClick={remove}
        title={
          confirming
            ? `Remove ${accountLabel(account)}? This only removes it here; your phone is unaffected.`
            : 'Remove account'
        }
        className={
          confirming
            ? 'flex items-center gap-1.5 rounded-lg bg-danger px-3 py-2 text-sm font-medium text-accent-ink'
            : 'rounded-lg p-2 text-muted hover:bg-raised hover:text-danger'
        }
      >
        <Trash2 size={15} />
        {confirming && 'Sure?'}
      </button>
    </div>
  )
}

function Ring({ period, remaining }: { period: number; remaining: number }): React.JSX.Element {
  const R = 15.5
  const C = 2 * Math.PI * R
  const frac = Math.max(0, Math.min(1, remaining / period))
  const low = remaining <= 5
  return (
    <div className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
        <circle cx="20" cy="20" r={R} fill="none" strokeWidth="3.5" className="stroke-edge" />
        <circle
          cx="20"
          cy="20"
          r={R}
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${C * frac} ${C}`}
          className={low ? 'stroke-danger' : 'stroke-accent'}
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center text-[11px] ${
          low ? 'text-danger' : 'text-muted'
        }`}
      >
        {Math.max(0, Math.floor(remaining))}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------- modals --- */

function Modal({
  title,
  wide,
  onClose,
  children
}: {
  title: string
  wide?: boolean
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-bg/70 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`max-h-full w-full ${
          wide ? 'max-w-2xl' : 'max-w-md'
        } overflow-y-auto rounded-2xl border border-edge bg-surface p-6 shadow-xl`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-raised hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const FIELD_CLS =
  'w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent'
const LABEL_CLS = 'mt-3 block text-xs font-medium text-muted first:mt-0'

function AddModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [issuer, setIssuer] = useState('')
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [digits, setDigits] = useState('6')
  const [algorithm, setAlgorithm] = useState('SHA1')
  const [period, setPeriod] = useState('30')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setErr(null)
    const issuerT = issuer.trim()
    const nameT = name.trim()
    if (!issuerT && !nameT) {
      setErr('Enter at least an issuer or a name.')
      return
    }
    let secretBytes: Uint8Array
    try {
      secretBytes = b32decode(secret)
    } catch {
      setErr('Secret must be valid base32 (A-Z, 2-7).')
      return
    }
    if (secretBytes.length === 0) {
      setErr('Secret must be valid base32 (A-Z, 2-7).')
      return
    }
    const periodN = Number(period)
    if (!Number.isFinite(periodN) || periodN <= 0) {
      setErr('Period must be a positive number of seconds.')
      return
    }
    setBusy(true)
    const res = await useMfa.getState().addAccounts([
      {
        name: nameT,
        issuer: issuerT,
        secret: b32encode(secretBytes),
        algorithm,
        digits: Number(digits),
        type: 'totp',
        counter: 0,
        period: Math.trunc(periodN)
      }
    ])
    setBusy(false)
    if (res) onClose()
  }

  return (
    <Modal title="Add account" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className={LABEL_CLS}>Issuer (e.g. GitHub)</label>
        <input autoFocus value={issuer} onChange={(e) => setIssuer(e.target.value)} className={FIELD_CLS} />

        <label className={LABEL_CLS}>Account name / email</label>
        <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLS} />

        <label className={LABEL_CLS}>Secret key (base32)</label>
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          spellCheck={false}
          className={`${FIELD_CLS} font-mono`}
        />

        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-muted">Digits</label>
            <select value={digits} onChange={(e) => setDigits(e.target.value)} className={`mt-1 ${FIELD_CLS}`}>
              <option value="6">6</option>
              <option value="8">8</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Algorithm</label>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value)}
              className={`mt-1 ${FIELD_CLS}`}
            >
              <option>SHA1</option>
              <option>SHA256</option>
              <option>SHA512</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Period (s)</label>
            <input
              type="number"
              min={1}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className={`mt-1 ${FIELD_CLS}`}
            />
          </div>
        </div>

        {err && <p className="mt-3 text-sm text-danger">{err}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  const runImport = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    const payloads: string[] = []
    const probs: string[] = []

    for (const f of files) {
      try {
        const found = await decodeImageFile(f)
        if (found.length === 0) probs.push(`${f.name}: no QR code found`)
        payloads.push(...found)
      } catch (err) {
        probs.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (t) payloads.push(t)
    }

    const { accounts, problems: parseProblems } = accountsFromPayloads(payloads)
    probs.push(...parseProblems)

    if (accounts.length > 0) {
      const res = await useMfa.getState().addAccounts(accounts)
      if (res) setResult(`Found ${res.found} account(s); added ${res.added} new one(s).`)
    } else if (payloads.length > 0) {
      setResult('No TOTP/HOTP accounts found.')
    } else {
      probs.push('Nothing to import — pick an image or paste a URI.')
    }
    setProblems(probs)
    setBusy(false)
  }

  return (
    <Modal title="Import accounts" onClose={onClose} wide>
      <p className="text-sm text-muted">
        Pick Google Authenticator export QR image(s) (one code per image), or paste{' '}
        <span className="font-mono text-xs">otpauth://</span> /{' '}
        <span className="font-mono text-xs">otpauth-migration://</span> URIs below, one per line.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
        >
          <QrCode size={15} />
          Choose QR image(s)&hellip;
        </button>
        {files.length > 0 && (
          <span className="text-xs text-muted">{files.map((f) => f.name).join(', ')}</span>
        )}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={'otpauth://totp/GitHub:alice?secret=...\notpauth-migration://offline?data=...'}
        className="mt-3 w-full rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-accent"
      />

      {result && <p className="mt-3 text-sm text-ok">{result}</p>}
      {problems.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-warn">
          {problems.map((p, i) => (
            <li key={i} className="break-all">
              {p}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60"
        >
          Close
        </button>
        <button
          onClick={() => void runImport()}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={14} />}
          Import
        </button>
      </div>
    </Modal>
  )
}

function SelfTestModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      setReport(await runSelfTest())
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Modal title="Self-test" onClose={onClose} wide>
      {running && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="animate-spin" size={14} />
          Running&hellip;
        </p>
      )}
      {!running && report && (
        <>
          <p className={`text-sm font-semibold ${report.passed ? 'text-ok' : 'text-danger'}`}>
            {report.passed ? 'All self-tests PASSED.' : 'Self-tests FAILED.'}
          </p>
          <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-edge bg-raised p-3">
            {report.lines.map((l, i) => (
              <div key={i} className="flex gap-2 font-mono text-xs leading-5">
                <span
                  className={
                    l.status === 'ok'
                      ? 'w-10 shrink-0 text-ok'
                      : l.status === 'fail'
                        ? 'w-10 shrink-0 text-danger'
                        : 'w-10 shrink-0 text-muted'
                  }
                >
                  {l.status === 'ok' ? 'OK' : l.status === 'fail' ? 'FAIL' : ''}
                </span>
                <span className={`break-all ${l.status === 'info' ? 'text-muted' : ''}`}>{l.text}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => void run()}
              className="rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60"
            >
              Run again
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

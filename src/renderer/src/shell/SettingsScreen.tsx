import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Cloud,
  Copy,
  DatabaseBackup,
  DownloadCloud,
  FolderOpen,
  GitBranch,
  HardDriveDownload,
  History,
  KeyRound,
  LayoutGrid,
  Loader2,
  Lock,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
  Save,
  Sun,
  UploadCloud,
  Wifi,
  X
} from 'lucide-react'
import {
  API_PROVIDERS,
  SHELL_IPC,
  type ApiProviderId,
  type BackupInfo,
  type BackupResult,
  type CardSize,
  type McpStatus,
  type ModuleDataPath,
  type RecoveryResult,
  type RecoveryScan,
  type ShellSettings,
  type SyncConfig,
  type SyncResult,
  type SyncSnapshot,
  type SyncSnapshotList,
  type SyncStatus,
  type UpdateEvent,
  type WebServerStatus
} from '@shared/types'
import { modules, type RegisteredModule } from './registry'
import { CARD_SIZES, effectiveDescription, effectiveName } from './moduleView'
import { useSettings } from '@/stores/settings'
import ModuleIcon from './ModuleIcon'
import ThemeStudio from './ThemeStudio'

function ModuleRow({
  mod,
  overrides,
  enabled,
  first,
  onToggle
}: {
  mod: RegisteredModule
  overrides: ShellSettings['moduleOverrides']
  enabled: boolean
  first: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { manifest } = mod
  const [open, setOpen] = useState(false)
  const [paths, setPaths] = useState<ModuleDataPath[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const toggleOpen = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && paths === null) {
      setLoading(true)
      const p = (await window.wicked.invoke(
        SHELL_IPC.moduleDataPaths,
        manifest.id
      )) as ModuleDataPath[]
      setPaths(p)
      setLoading(false)
    }
  }

  return (
    <div className={first ? '' : 'border-t border-edge'}>
      <div className="flex items-center gap-2 p-4">
        <button
          onClick={toggleOpen}
          title={open ? 'Hide file paths' : 'Show file paths'}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <button
          onClick={toggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
            <ModuleIcon name={manifest.icon} size={16} strokeWidth={1.8} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {effectiveName(mod, overrides)}
              {manifest.status === 'beta' && (
                <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                  Beta
                </span>
              )}
            </span>
            <span className="block truncate text-xs text-muted">
              {effectiveDescription(mod, overrides)}
            </span>
          </span>
        </button>
        <input
          type="checkbox"
          title={enabled ? 'Hide from nav' : 'Show in nav'}
          checked={enabled}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 accent-[rgb(var(--wk-accent))]"
        />
      </div>

      {open && (
        <div className="border-t border-edge bg-raised/30 px-4 py-3 pl-12">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={13} className="animate-spin" /> Reading file paths…
            </div>
          ) : !paths || paths.length === 0 ? (
            <div className="text-xs text-muted">This app has no configurable file paths.</div>
          ) : (
            <div className="space-y-2.5">
              {paths.map((dp, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2 text-xs font-medium text-ink">
                    <FolderOpen size={12} className="shrink-0 text-muted" />
                    {dp.label}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 pl-[18px]">
                    {dp.path ? (
                      <>
                        <code className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1 font-mono text-[11px] text-ink">
                          {dp.path}
                        </code>
                        <button
                          title="Copy path"
                          onClick={async () => {
                            await navigator.clipboard.writeText(dp.path as string)
                            setCopied(dp.label)
                            setTimeout(() => setCopied(null), 1200)
                          }}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-ink"
                        >
                          <Copy size={12} />
                        </button>
                        {copied === dp.label && <span className="text-[11px] text-ok">Copied</span>}
                      </>
                    ) : (
                      <span className="text-[11px] italic text-muted">Not Configured Yet</span>
                    )}
                  </div>
                  {dp.note && <div className="mt-0.5 pl-[18px] text-[11px] text-muted">{dp.note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ApiKeyRow({
  id,
  name,
  placeholder,
  isSet,
  onChanged
}: {
  id: ApiProviderId
  name: string
  placeholder: string
  isSet: boolean
  onChanged: () => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    if (!value.trim()) return
    setError('')
    const res = (await window.wicked.invoke(SHELL_IPC.apiKeySet, id, value)) as {
      ok: boolean
      error?: string
    }
    if (res.ok) {
      setValue('')
      onChanged()
    } else {
      setError(res.error ?? 'Failed to save key')
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-edge p-4 first:border-t-0">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className={`h-2 w-2 rounded-full ${isSet ? 'bg-ok' : 'bg-muted/40'}`} />
          {name}
        </span>
        {isSet && (
          <button
            onClick={async () => {
              await window.wicked.invoke(SHELL_IPC.apiKeyClear, id)
              onChanged()
            }}
            className="text-xs font-medium text-muted hover:text-danger"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          placeholder={isSet ? '•••••••• (saved — enter to replace)' : placeholder || 'API key'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-1.5 font-mono text-xs outline-none focus:border-accent"
        />
        <button
          onClick={save}
          disabled={!value.trim()}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

const THEMES: { value: ShellSettings['theme']; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor }
]

/**
 * Restore user data left behind by a previous app version. Earlier builds kept
 * userData under a different folder name; updating across the rename orphaned
 * settings + module data. This finds that data and restores it (backing up the
 * current data first), then the app relaunches.
 */
function RecoverySection(): React.JSX.Element {
  const [scan, setScan] = useState<RecoveryScan | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const runScan = async (pick: boolean): Promise<void> => {
    setLoading(true)
    setMessage(null)
    const res = (await window.wicked.invoke(
      pick ? SHELL_IPC.recoveryPick : SHELL_IPC.recoveryScan
    )) as RecoveryScan
    setScan(res)
    setLoading(false)
  }

  useEffect(() => {
    void runScan(false)
  }, [])

  const restore = async (path: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const res = (await window.wicked.invoke(SHELL_IPC.recoveryRestore, path)) as RecoveryResult
    // On success the main process relaunches the app, so we rarely get here.
    if (res.canceled) setMessage(null)
    else if (!res.ok) setMessage(res.error ?? 'Restore failed.')
    setBusy(false)
  }

  const candidates = scan?.candidates ?? []

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <DatabaseBackup size={14} />
        Data &amp; Recovery
      </h2>
      <p className="mt-1 max-w-xl text-xs text-muted">
        WICKED keeps your settings, nav order and each app’s data in a fixed folder that stays
        put across updates. If an older version left data behind under a different folder name,
        you can restore it here — your current data is backed up first, then WICKED restarts.
      </p>

      <div className="mt-3 max-w-xl rounded-xl border border-edge bg-surface p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Looking for previous data…
          </div>
        ) : candidates.length === 0 ? (
          <div className="text-sm text-muted">
            No data from a previous version was found on this PC — your current data is the only
            WICKED data folder, and it stays put across updates. If you have an old copy elsewhere
            (another drive or a backup),{' '}
            <button
              onClick={() => void runScan(true)}
              className="font-medium text-accent hover:underline"
            >
              choose a folder…
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {candidates.map((c) => (
              <div
                key={c.path}
                className="flex flex-col gap-2 rounded-lg border border-edge bg-raised/40 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-ink" title={c.path}>
                    {c.path}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    Settings ✓
                    {c.moduleCount > 0
                      ? ` · ${c.moduleCount} app${c.moduleCount === 1 ? '' : 's'} with saved data`
                      : ' · no module data'}
                    {c.moduleIds.length > 0 && (
                      <span className="text-muted/70"> ({c.moduleIds.join(', ')})</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => void restore(c.path)}
                  disabled={busy}
                  className="flex w-fit items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink disabled:opacity-40"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  Restore &amp; restart
                </button>
              </div>
            ))}
            <button
              onClick={() => void runScan(true)}
              className="text-xs font-medium text-muted hover:text-ink hover:underline"
            >
              Restore from another folder…
            </button>
          </div>
        )}

        {scan && scan.currentHasSettings && candidates.length > 0 && (
          <p className="mt-3 border-t border-edge pt-3 text-xs text-warn">
            Restoring replaces your current settings and app data. A timestamped backup is saved
            inside the current data folder first, so it can be undone.
          </p>
        )}
        {message && <p className="mt-3 text-xs text-danger">{message}</p>}
      </div>
    </section>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
}

const SCHEDULE_OPTS: { hours: number; label: string }[] = [
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Daily' },
  { hours: 168, label: 'Weekly' }
]

/**
 * Whole-app Backup & Restore: back up every module's data + settings to a single
 * .zip in a folder you choose (e.g. a network share), on demand or on a
 * schedule, and restore it (here or on another PC).
 */
function BackupSection(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const backup = settings.backup
  const [destination, setDestination] = useState<string>('')
  const [isDefault, setIsDefault] = useState(true)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hasPassword, setHasPassword] = useState(false)
  const [pwInput, setPwInput] = useState('')
  const [editingPw, setEditingPw] = useState(false)

  const refresh = async (): Promise<void> => {
    const res = (await window.wicked.invoke(SHELL_IPC.backupConfig)) as {
      destination: string
      isDefaultDestination: boolean
      backups: BackupInfo[]
    }
    setDestination(res.destination)
    setIsDefault(res.isDefaultDestination)
    setBackups(res.backups ?? [])
    const pw = (await window.wicked.invoke(SHELL_IPC.backupPasswordStatus)) as { hasPassword?: boolean }
    setHasPassword(!!pw.hasPassword)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const savePassword = async (): Promise<void> => {
    const res = (await window.wicked.invoke(SHELL_IPC.backupPasswordSet, pwInput)) as { ok?: boolean; error?: string }
    if (res.ok) {
      setMessage('Backup password set — future backups will include your API keys (encrypted).')
      setError(null)
      setPwInput('')
      setEditingPw(false)
      await refresh()
    } else setError(res.error ?? 'Could not set the password.')
  }

  const clearPassword = async (): Promise<void> => {
    await window.wicked.invoke(SHELL_IPC.backupPasswordClear)
    setMessage('Backup password cleared — API keys will no longer be included in backups.')
    await refresh()
  }

  const backupNow = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    setError(null)
    const res = (await window.wicked.invoke(SHELL_IPC.backupNow)) as BackupResult
    if (res.ok) setMessage(`Backed up ${res.fileCount ?? 0} files (${fmtBytes(res.size ?? 0)}).`)
    else setError(res.error ?? 'Backup failed.')
    await refresh()
    setBusy(false)
  }

  const pickDestination = async (): Promise<void> => {
    setError(null)
    const res = (await window.wicked.invoke(SHELL_IPC.backupPickDestination)) as {
      ok?: boolean
      canceled?: boolean
      destination?: string
    }
    if (res.ok) await refresh()
  }

  const restore = async (file?: string, password?: string): Promise<void> => {
    setError(null)
    setMessage(null)
    const res = (await window.wicked.invoke(SHELL_IPC.backupRestore, file ?? null, password ?? null)) as BackupResult
    // The backup carries password-protected API keys → ask for the password and retry.
    if (res.needPassword) {
      const pw = window.prompt(
        'This backup contains API keys protected by a backup password.\nEnter the backup password to import them (Cancel to restore without keys):'
      )
      if (pw && pw.trim()) {
        await restore(res.file ?? file, pw.trim())
      } else if (pw === '') {
        setError('No password entered — enter your backup password to import the keys.')
      }
      return
    }
    // On success the main process relaunches, so we usually don't return here.
    if (!res.ok && !res.canceled) setError(res.error ?? 'Restore failed.')
  }

  const setSchedule = (patch: Partial<ShellSettings['backup']['schedule']>): void => {
    void update({ backup: { ...backup, schedule: { ...backup.schedule, ...patch } } })
  }

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <DatabaseBackup size={14} />
        Backup &amp; Restore
      </h2>
      <p className="mt-1 max-w-xl text-xs text-muted">
        Save every module’s data and all settings — email rules, AI Chat, Project Board (cards, freeform
        notes &amp; images), Trade Journal, bookmarks, themes, the works — into one <code>.zip</code>. Set a
        backup password to carry your API keys too. Point the destination at a network share, back up on
        demand or on a schedule, and restore it here or on a new PC.
      </p>

      <div className="mt-3 max-w-xl space-y-4 rounded-xl border border-edge bg-surface p-4">
        {/* destination */}
        <div>
          <div className="text-sm font-medium">Backup folder</div>
          <div className="mt-2 flex items-center gap-2">
            <input
              readOnly
              value={destination}
              title={destination}
              className="min-w-0 flex-1 truncate rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-muted"
            />
            <button
              onClick={() => void pickDestination()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
            >
              <FolderOpen size={14} /> Change…
            </button>
          </div>
          {isDefault && <p className="mt-1 text-xs text-muted">Default location. Choose a folder (e.g. a network drive) to keep backups off this PC.</p>}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-3">
          <button
            onClick={() => void backupNow()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Back up now
          </button>
          <button
            onClick={() => void restore()}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <HardDriveDownload size={14} /> Restore from file…
          </button>
        </div>
        {message && <p className="text-xs text-ok">{message}</p>}
        {error && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}

        {/* API-key portability */}
        <div className="border-t border-edge pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">Include API keys (backup password)</div>
              <p className="mt-0.5 text-xs text-muted">
                Set a password to include your API keys in every backup — encrypted, so they move to a new
                computer. You’ll type this same password when restoring there. Without it, keys stay on this PC
                only (all other data still backs up).
              </p>
            </div>
            <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${hasPassword ? 'bg-ok/15 text-ok' : 'bg-raised text-muted'}`}>
              {hasPassword ? 'Keys included' : 'Keys excluded'}
            </span>
          </div>
          {editingPw ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="password"
                autoFocus
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void savePassword()
                  if (e.key === 'Escape') setEditingPw(false)
                }}
                placeholder="Choose a backup password…"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => void savePassword()}
                disabled={pwInput.trim().length < 4}
                className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                Save
              </button>
              <button onClick={() => setEditingPw(false)} className="rounded-lg bg-raised px-3 py-2 text-sm hover:bg-edge/60">
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => {
                  setPwInput('')
                  setEditingPw(true)
                }}
                className="rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
              >
                {hasPassword ? 'Change password' : 'Set backup password'}
              </button>
              {hasPassword && (
                <button
                  onClick={() => void clearPassword()}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-danger"
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>

        {/* schedule */}
        <div className="border-t border-edge pt-3">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Scheduled backups</span>
            <input
              type="checkbox"
              checked={backup.schedule.enabled}
              onChange={(e) => setSchedule({ enabled: e.target.checked })}
              className="h-4 w-4 accent-[rgb(var(--wk-accent))]"
            />
          </label>
          <div className="mt-2 flex items-center justify-between gap-4">
            <span className={`text-sm ${backup.schedule.enabled ? '' : 'text-muted'}`}>Frequency</span>
            <select
              value={backup.schedule.intervalHours}
              disabled={!backup.schedule.enabled}
              onChange={(e) => setSchedule({ intervalHours: Number(e.target.value) })}
              className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {SCHEDULE_OPTS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1 text-xs text-muted">
            Keeps the newest {backup.keep} backups in the folder; older ones are removed.
            {backup.lastBackupUtc ? ` Last backup: ${fmtWhen(backup.lastBackupUtc)}.` : ' No backup taken yet.'}
          </p>
        </div>

        {/* recent backups */}
        {backups.length > 0 && (
          <div className="border-t border-edge pt-3">
            <div className="text-xs font-medium text-muted">Backups in this folder</div>
            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
              {backups.map((b) => (
                <div key={b.file} className="flex items-center gap-2 rounded-md bg-raised/50 px-2.5 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate" title={b.file}>
                    {b.name}
                  </span>
                  <span className="shrink-0 text-muted">{fmtBytes(b.size)}</span>
                  <span className="shrink-0 text-muted">{fmtWhen(b.modifiedUtc)}</span>
                  <button
                    onClick={() => void restore(b.file)}
                    className="shrink-0 rounded px-2 py-0.5 font-medium text-accent hover:bg-accent/10"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="border-t border-edge pt-3 text-xs text-muted">
          Note: API keys are encrypted per-PC, so after restoring on a <em>different</em> computer
          you may need to re-enter them in API Keys. External folders you pointed modules at (an
          Obsidian vault, a custom data root) are your own files — back those up where they live.
        </p>
      </div>
    </section>
  )
}

/**
 * Cloud Sync — keep every device's config in one PRIVATE GitHub repo. Snapshots
 * are encrypted with your passphrase before upload; your main PC auto-pushes and
 * other devices pull on demand. See src/main/sync.ts for the model.
 */
function SyncSection(): React.JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [deviceName, setDeviceName] = useState('')
  const [token, setToken] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [showSnaps, setShowSnaps] = useState(false)
  const [snaps, setSnaps] = useState<SyncSnapshot[] | null>(null)
  const [loadingSnaps, setLoadingSnaps] = useState(false)
  const [snapErr, setSnapErr] = useState<string | null>(null)
  const seeded = useRef(false)

  const refresh = async (): Promise<void> => {
    setStatus((await window.wicked.invoke(SHELL_IPC.syncStatus)) as SyncStatus)
  }
  useEffect(() => {
    void refresh()
    return window.wicked.on(SHELL_IPC.syncEvent, (raw) => setStatus(raw as SyncStatus))
  }, [])
  useEffect(() => {
    if (status && !seeded.current) {
      setRepo(status.repo)
      setBranch(status.branch || 'main')
      setDeviceName(status.deviceName)
      seeded.current = true
    }
  }, [status])

  const setConfig = async (patch: Partial<SyncConfig>): Promise<void> => {
    setStatus((await window.wicked.invoke(SHELL_IPC.syncSetConfig, patch)) as SyncStatus)
  }

  const saveConnection = async (): Promise<void> => {
    setErr(null)
    setMsg(null)
    await setConfig({ repo, branch, deviceName })
    if (token.trim() || passphrase.trim()) {
      const res = (await window.wicked.invoke(SHELL_IPC.syncSetSecrets, {
        token: token.trim() || undefined,
        passphrase: passphrase.trim() || undefined
      })) as { ok?: boolean; error?: string }
      if (!res.ok) {
        setErr(res.error ?? 'Could not store the token/passphrase.')
        return
      }
      setToken('')
      setPassphrase('')
    }
    setMsg('Saved.')
    void refresh()
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.syncTestRepo)) as { ok?: boolean; defaultBranch?: string; private?: boolean; error?: string }
    setBusy('')
    if (res.ok) setMsg(`Connected. Default branch: ${res.defaultBranch}${res.private === false ? ' · ⚠ this repo is PUBLIC — use a private one' : ' · private ✓'}`)
    else setErr(res.error ?? 'Connection failed.')
  }

  const push = async (): Promise<void> => {
    setBusy('push')
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.syncPushNow)) as SyncResult
    setBusy('')
    if (res.ok) setMsg(`Pushed snapshot v${res.version}.`)
    else setErr(res.error ?? 'Push failed.')
  }

  const check = async (): Promise<void> => {
    setBusy('check')
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.syncCheckRemote)) as SyncResult
    setBusy('')
    if (!res.ok) {
      setErr(res.error ?? 'Could not reach the repo.')
      return
    }
    if (res.compare === 'no-remote') setMsg('Nothing has been pushed to this repo yet.')
    else if (res.compare === 'up-to-date') setMsg('This device is up to date with the cloud.')
    else if (res.compare === 'remote-newer') setMsg(`Cloud has newer data (v${res.remote?.version} from ${res.remote?.device}). Use “Pull from cloud” to bring it in.`)
    else setMsg('This device is ahead of the cloud — a pull would replace newer local data.')
  }

  const pull = async (): Promise<void> => {
    setBusy('pull')
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.syncPullNow)) as SyncResult
    setBusy('')
    // On success the app relaunches; we only get here on cancel/failure.
    if (!res.ok && res.error && res.error !== 'Canceled.') setErr(res.error)
  }

  const forget = async (): Promise<void> => {
    await window.wicked.invoke(SHELL_IPC.syncClearSecrets)
    setMsg('Token and passphrase forgotten on this device.')
    void refresh()
  }

  const openSnapshots = async (): Promise<void> => {
    setShowSnaps(true)
    setSnaps(null)
    setSnapErr(null)
    setLoadingSnaps(true)
    const res = (await window.wicked.invoke(SHELL_IPC.syncListSnapshots)) as SyncSnapshotList
    setLoadingSnaps(false)
    if (res.ok) setSnaps(res.snapshots ?? [])
    else setSnapErr(res.error ?? 'Could not list snapshots.')
  }

  const restoreSnap = async (sha: string): Promise<void> => {
    setBusy('restore')
    setSnapErr(null)
    const res = (await window.wicked.invoke(SHELL_IPC.syncRestoreSnapshot, sha)) as SyncResult
    setBusy('')
    // On success the app relaunches; we only get here on cancel/failure.
    if (!res.ok && res.error && res.error !== 'Canceled.') setSnapErr(res.error)
  }

  const input = 'w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent'
  const remote = status?.remote

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <Cloud size={14} />
        Cloud Sync (private GitHub repo)
      </h2>
      <p className="mt-1 max-w-xl text-xs text-muted">
        Keep every device in sync through a <strong>private</strong> GitHub repo. Each snapshot (settings,
        all module data and your API keys) is <strong>encrypted with your passphrase before it leaves this
        PC</strong> — a leaked token or repo only ever exposes ciphertext. Your main PC auto-pushes; other
        devices click <em>Pull from cloud</em> to download and restart. You’ll need a fine-grained token with
        <strong> Contents: read &amp; write</strong> on just that repo.
      </p>

      <div className="mt-3 max-w-xl space-y-4 rounded-xl border border-edge bg-surface p-4">
        {/* repo + branch */}
        <div className="grid grid-cols-[1fr_140px] gap-2">
          <div>
            <label className="text-xs font-medium text-muted">Repo (owner / name)</label>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="yourname/wicked-sync" className={`mt-1 ${input}`} />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs font-medium text-muted"><GitBranch size={11} /> Branch</label>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className={`mt-1 ${input}`} />
          </div>
        </div>

        {/* token + passphrase */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <span className={`h-2 w-2 rounded-full ${status?.hasToken ? 'bg-ok' : 'bg-muted/40'}`} /> GitHub token
            </label>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status?.hasToken ? '•••••• (saved — enter to replace)' : 'github_pat_…'} autoComplete="off" className={`mt-1 font-mono text-xs ${input}`} />
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <span className={`h-2 w-2 rounded-full ${status?.hasPassphrase ? 'bg-ok' : 'bg-muted/40'}`} /> Sync passphrase
            </label>
            <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={status?.hasPassphrase ? '•••••• (saved — enter to replace)' : 'encrypts everything'} autoComplete="off" className={`mt-1 ${input}`} />
          </div>
        </div>
        <p className="-mt-2 text-[11px] text-muted">
          The passphrase never leaves your PC. Use the <strong>same passphrase on every device</strong> — it’s
          what unlocks your synced data (and API keys) on a new machine. There is no recovery if you forget it.
        </p>

        <div>
          <label className="text-xs font-medium text-muted">This device’s name</label>
          <input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="e.g. Desktop, Field-Laptop" className={`mt-1 ${input}`} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void saveConnection()} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90">
            <Save size={14} /> Save
          </button>
          <button onClick={() => void test()} disabled={busy === 'test'} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-50">
            {busy === 'test' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Test connection
          </button>
          {(status?.hasToken || status?.hasPassphrase) && (
            <button onClick={() => void forget()} className="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-danger">
              Forget on this device
            </button>
          )}
        </div>

        {/* auto-push + on close */}
        <div className="border-t border-edge pt-3">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Auto-push on a schedule</span>
            <input type="checkbox" checked={status?.autoPush ?? false} onChange={(e) => void setConfig({ autoPush: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--wk-accent))]" />
          </label>
          <div className="mt-2 flex items-center justify-between gap-4">
            <span className={`text-sm ${status?.autoPush ? '' : 'text-muted'}`}>Push every</span>
            <select value={status?.intervalMinutes ?? 30} disabled={!status?.autoPush} onChange={(e) => void setConfig({ intervalMinutes: Number(e.target.value) })} className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm disabled:opacity-50">
              {[15, 30, 60, 360].map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m / 60 === 1 ? '' : 's'}`}</option>
              ))}
            </select>
          </div>
          <label className="mt-3 flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Sync app on close</span>
            <input type="checkbox" checked={status?.pushOnClose ?? false} onChange={(e) => void setConfig({ pushOnClose: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--wk-accent))]" />
          </label>
          <p className="mt-1 text-[11px] text-muted">Recommended: turn auto-push on for your MAIN PC only, and pull on demand elsewhere so a stale device can’t overwrite newer work.</p>
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-3">
          <button onClick={() => void push()} disabled={!status?.configured || !!busy} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40">
            {busy === 'push' ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />} Sync now (push)
          </button>
          <button onClick={() => void check()} disabled={!status?.repo || !status?.hasToken || !!busy} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
            {busy === 'check' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check cloud
          </button>
          <button onClick={() => void pull()} disabled={!status?.configured || !!busy} title="Download the newest cloud copy, replace local data and restart" className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
            {busy === 'pull' ? <Loader2 size={14} className="animate-spin" /> : <DownloadCloud size={14} />} Pull from cloud
          </button>
          <button onClick={() => void openSnapshots()} disabled={!status?.configured || !!busy} title="Browse every past snapshot in the cloud and restore any one of them" className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
            <History size={14} /> Restore from a specific snapshot…
          </button>
        </div>

        {msg && <p className="text-xs text-ok">{msg}</p>}
        {err && <p className="rounded-lg bg-danger/10 p-2 text-xs text-danger">{err}</p>}

        {/* status line */}
        <div className="border-t border-edge pt-3 text-[11px] text-muted">
          {status?.configured ? (
            <>
              Ready · this device “{status.deviceName}” · last synced v{status.lastSyncedVersion}
              {status.lastPushUtc && ` · pushed ${fmtWhen(status.lastPushUtc)}`}
              {status.lastPullUtc && ` · pulled ${fmtWhen(status.lastPullUtc)}`}
              {remote && <div className="mt-0.5">Cloud: v{remote.version} from {remote.device || 'another device'} · {fmtWhen(remote.updatedUtc)} · {fmtBytes(remote.sizeBytes)}</div>}
            </>
          ) : (
            'Not set up yet — add a repo, token and passphrase, then Save.'
          )}
        </div>
      </div>

      {showSnaps && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowSnaps(false)}>
          <div className="max-h-[80vh] w-full max-w-lg overflow-hidden rounded-2xl border border-edge bg-surface shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-edge px-4 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <History size={15} /> Restore from a specific snapshot
              </h3>
              <button onClick={() => setShowSnaps(false)} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink" title="Close">
                <X size={16} />
              </button>
            </div>
            <p className="border-b border-edge px-4 py-2 text-[11px] text-muted">
              Every push is kept in the cloud history. Pick any one to restore it to this PC — useful when a device overwrote newer
              work before you could pull.
            </p>
            <div className="max-h-[55vh] overflow-y-auto p-2">
              {loadingSnaps ? (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
                  <Loader2 size={15} className="animate-spin" /> Loading snapshot history…
                </div>
              ) : snapErr ? (
                <p className="m-2 rounded-lg bg-danger/10 p-2 text-xs text-danger">{snapErr}</p>
              ) : !snaps || snaps.length === 0 ? (
                <p className="p-6 text-center text-xs text-muted">No snapshots found in this repo yet.</p>
              ) : (
                <ul className="space-y-1">
                  {snaps.map((snp) => (
                    <li key={snp.commitSha} className="flex items-center gap-3 rounded-lg border border-edge bg-raised/40 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                          <span>Snapshot v{snp.version || '—'}</span>
                          {snp.isCurrent && (
                            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">This device</span>
                          )}
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              snp.trigger === 'manual' ? 'bg-ok/15 text-ok' : snp.trigger === 'auto' ? 'bg-muted/15 text-muted' : 'bg-muted/10 text-muted'
                            }`}
                          >
                            {snp.trigger === 'unknown' ? 'snapshot' : snp.trigger}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted">
                          {snp.device || 'unknown device'} · {fmtWhen(snp.updatedUtc)}
                          {snp.sizeBytes ? ` · ${fmtBytes(snp.sizeBytes)}` : ''}
                          {snp.appVersion ? ` · app v${snp.appVersion}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => void restoreSnap(snp.commitSha)}
                        disabled={!!busy}
                        className="flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                      >
                        {busy === 'restore' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-edge px-4 py-2 text-[11px] text-muted">
              Restoring replaces this PC’s data and restarts. A timestamped local backup is written first.
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/** Optional launch PIN (device-local). Convenience gate; see LockGate. */
function AppLockSection(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [pin, setPin] = useState('')
  const [current, setCurrent] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const s = (await window.wicked.invoke(SHELL_IPC.appLockStatus)) as { enabled?: boolean }
    setEnabled(s.enabled === true)
  }
  useEffect(() => {
    void refresh()
  }, [])

  const save = async (): Promise<void> => {
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.appLockSet, pin)) as { ok?: boolean; error?: string }
    if (res.ok) {
      setMsg(enabled ? 'PIN updated.' : 'App lock enabled.')
      setPin('')
      void refresh()
    } else setErr(res.error ?? 'Could not set the PIN.')
  }

  const disable = async (): Promise<void> => {
    setErr(null)
    setMsg(null)
    const res = (await window.wicked.invoke(SHELL_IPC.appLockClear, current)) as { ok?: boolean; error?: string }
    if (res.ok) {
      setMsg('App lock turned off.')
      setCurrent('')
      void refresh()
    } else setErr(res.error ?? 'Wrong PIN.')
  }

  const input = 'min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent'

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <Lock size={14} />
        App Lock
      </h2>
      <p className="mt-1 max-w-xl text-xs text-muted">
        Require a PIN to open WICKED on this device. It’s a convenience gate on top of the running app — the
        real protection for your synced data is the sync passphrase, which encrypts everything before it
        leaves the PC. The PIN is stored only as a salted hash and never syncs.
      </p>
      <div className="mt-3 max-w-xl space-y-3 rounded-xl border border-edge bg-surface p-4">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-ok' : 'bg-muted/40'}`} />
          <span className="text-sm font-medium">{enabled ? 'App lock is ON for this device' : 'App lock is off'}</span>
        </div>
        <div className="flex items-center gap-2">
          <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder={enabled ? 'New PIN (min 4)' : 'Set a PIN (min 4)'} autoComplete="off" className={input} />
          <button onClick={() => void save()} disabled={pin.trim().length < 4} className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40">
            {enabled ? 'Change PIN' : 'Enable lock'}
          </button>
        </div>
        {enabled && (
          <div className="flex items-center gap-2 border-t border-edge pt-3">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current PIN to turn off" autoComplete="off" className={input} />
            <button onClick={() => void disable()} disabled={!current.trim()} className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-danger disabled:opacity-40">
              Turn off
            </button>
          </div>
        )}
        {msg && <p className="text-xs text-ok">{msg}</p>}
        {err && <p className="text-xs text-danger">{err}</p>}
      </div>
    </section>
  )
}

function WebServerSection(): React.JSX.Element {
  const [status, setStatus] = useState<WebServerStatus | null>(null)
  const [password, setPassword] = useState('')
  const [port, setPort] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState('')

  const refresh = async (): Promise<void> => {
    const s = (await window.wicked.invoke(SHELL_IPC.webServerStatus)) as WebServerStatus
    setStatus(s)
    if (!port) setPort(String(s.port))
  }
  useEffect(() => {
    void refresh()
  }, [])

  const savePassword = async (): Promise<void> => {
    setMsg(null)
    const s = (await window.wicked.invoke(SHELL_IPC.webServerSetPassword, password)) as WebServerStatus
    setStatus(s)
    setPassword('')
    setMsg(s.error ? s.error : 'Password saved.')
  }

  const toggle = async (on: boolean): Promise<void> => {
    setMsg(null)
    const s = (await window.wicked.invoke(SHELL_IPC.webServerSetEnabled, on)) as WebServerStatus
    setStatus(s)
    if (on && !s.running && s.error) setMsg(s.error)
  }

  const savePort = async (): Promise<void> => {
    const n = Number(port)
    const s = (await window.wicked.invoke(SHELL_IPC.webServerSetPort, n)) as WebServerStatus
    setStatus(s)
    if (s.error) setMsg(s.error)
  }

  const input = 'min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent'
  const running = status?.running ?? false

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <Wifi size={14} />
        Web Server (LAN remote access)
      </h2>
      <p className="mt-1 max-w-xl text-xs text-muted">
        Serve the WHOLE app to other devices on your network. Anyone who opens the address below and enters
        the password gets the full app in their browser — and it can do everything the desktop app can,
        including actions that touch files and run programs on THIS PC. Off by default; the setting and
        password are stored only on this device and never sync.
      </p>
      <div className="mt-3 max-w-xl space-y-3 rounded-xl border border-warn/40 bg-warn/5 p-4">
        <p className="flex items-start gap-2 text-xs text-warn">
          <span className="mt-0.5">⚠</span>
          <span>
            This is full remote control over plain HTTP. Only turn it on trusted networks, use a strong
            password, and turn it off when you don&apos;t need it.
          </span>
        </p>

        {/* password */}
        <div className="flex items-center gap-2 border-t border-edge pt-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={status?.hasPassword ? 'Replace password (min 4)' : 'Set a password (min 4)'}
            autoComplete="off"
            className={input}
          />
          <button
            onClick={() => void savePassword()}
            disabled={password.trim().length < 4}
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {status?.hasPassword ? 'Replace' : 'Set password'}
          </button>
        </div>

        {/* port */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Port</span>
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8420"
            className="w-28 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void savePort()}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-ink"
          >
            Save port
          </button>
        </div>

        {/* toggle */}
        <label className="flex items-center justify-between gap-4 border-t border-edge pt-3">
          <span className="text-sm font-medium">
            {running ? 'Web server is ON' : 'Enable web server'}
            {!status?.hasPassword && <span className="ml-2 text-xs text-muted">(set a password first)</span>}
          </span>
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={!status?.hasPassword}
            onChange={(e) => void toggle(e.target.checked)}
            className="h-4 w-4 accent-[rgb(var(--wk-accent))] disabled:opacity-40"
          />
        </label>

        {running && status && status.urls.length > 0 && (
          <div className="space-y-1 border-t border-edge pt-3">
            <div className="text-xs text-muted">Open from another device on your network:</div>
            {status.urls.map((u) => (
              <div key={u} className="flex items-center gap-2">
                <code className="rounded bg-raised px-2 py-1 text-xs text-ink">{u}</code>
                <button
                  title="Copy address"
                  onClick={async () => {
                    await navigator.clipboard.writeText(u)
                    setCopied(u)
                    setTimeout(() => setCopied(''), 1500)
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
                >
                  <Copy size={13} />
                </button>
                {copied === u && <span className="text-xs text-ok">Copied</span>}
              </div>
            ))}
            <p className="pt-1 text-xs text-muted">Each new browser session is prompted for the password.</p>
          </div>
        )}
        {running && status && status.urls.length === 0 && (
          <p className="border-t border-edge pt-3 text-xs text-muted">
            Running on port {status.port}, but no network address was detected — check your Wi-Fi/Ethernet
            connection.
          </p>
        )}
        {msg && <p className={`text-xs ${status?.error && msg === status.error ? 'text-danger' : 'text-ok'}`}>{msg}</p>}
      </div>
    </section>
  )
}

export default function SettingsScreen(): React.JSX.Element {
  const { settings, update } = useSettings()
  const [version, setVersion] = useState('')
  const [updateState, setUpdateState] = useState('')
  const [keyStatus, setKeyStatus] = useState<Record<ApiProviderId, boolean> | null>(null)
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  const [mcpCopied, setMcpCopied] = useState(false)

  const refreshKeys = (): void => {
    window.wicked
      .invoke(SHELL_IPC.apiKeysStatus)
      .then((s) => setKeyStatus(s as Record<ApiProviderId, boolean>))
  }

  useEffect(() => {
    refreshKeys()
    window.wicked.invoke(SHELL_IPC.mcpStatus).then((s) => setMcp(s as McpStatus))
  }, [])

  const toggleMcp = async (enabled: boolean): Promise<void> => {
    setMcp((await window.wicked.invoke(SHELL_IPC.mcpSetEnabled, enabled)) as McpStatus)
  }

  useEffect(() => {
    window.wicked.invoke(SHELL_IPC.appVersion).then((v) => setVersion(v as string))
    return window.wicked.on(SHELL_IPC.updateEvent, (raw) => {
      const ev = raw as UpdateEvent
      setUpdateState(
        ev.kind === 'checking'
          ? 'Checking for updates…'
          : ev.kind === 'available'
            ? `Downloading ${ev.version}…`
            : ev.kind === 'downloaded'
              ? `${ev.version} ready to install`
              : ev.kind === 'none'
                ? 'Up to date'
                : `Update check failed: ${ev.message}`
      )
    })
  }, [])

  const toggleModule = (id: string): void => {
    const disabled = settings.disabledModules.includes(id)
      ? settings.disabledModules.filter((m) => m !== id)
      : [...settings.disabledModules, id]
    update({ disabledModules: disabled })
  }

  return (
    <div className="h-full overflow-y-auto p-10">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted">WICKED {version}</p>

      {/* Theme */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Appearance</h2>
        <div className="mt-3 inline-flex rounded-xl border border-edge bg-surface p-1">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              onClick={() => update({ theme: value })}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                settings.theme === value
                  ? 'bg-accent text-accent-ink'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        {settings.activeThemeId && (
          <p className="mt-2 text-xs text-muted">
            A custom theme is active — the Light/Dark/System toggle above picks which of its sub-themes
            (light or dark) is shown.
          </p>
        )}

        {/* Card size */}
        <div className="mt-6">
          <h3 className="text-sm font-medium">App tile size</h3>
          <p className="mt-0.5 text-xs text-muted">
            How big the app cards look on the home &amp; folder screens.
          </p>
          <div className="mt-3 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
            {(Object.keys(CARD_SIZES) as CardSize[]).map((key) => {
              const spec = CARD_SIZES[key]
              const active = (settings.cardSize ?? 'md') === key
              const chip = { sm: 18, md: 24, lg: 30, xl: 36 }[key]
              return (
                <button
                  key={key}
                  onClick={() => update({ cardSize: key })}
                  title={`${spec.label} tiles`}
                  className={`flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors ${
                    active ? 'border-accent bg-accent/5' : 'border-edge bg-surface hover:border-accent/50'
                  }`}
                >
                  {/* miniature tile preview — scales with the chosen size */}
                  <div className="flex h-20 w-full items-center justify-center rounded-lg bg-raised/50">
                    <div className="flex items-center gap-2 rounded-md border border-edge bg-surface px-2 py-1.5">
                      <span
                        className="flex items-center justify-center rounded bg-accent/15 text-accent"
                        style={{ height: chip, width: chip }}
                      >
                        <LayoutGrid size={Math.round(chip * 0.55)} />
                      </span>
                      <span className="flex flex-col gap-1">
                        <span className="block rounded-full bg-ink/70" style={{ height: 4, width: chip * 1.7 }} />
                        <span className="block rounded-full bg-muted/50" style={{ height: 3, width: chip }} />
                      </span>
                    </div>
                  </div>
                  <span className={`text-xs font-medium ${active ? 'text-accent' : 'text-ink'}`}>
                    {spec.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <ThemeStudio />
      </section>

      {/* Updates */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Updates</h2>
        <div className="mt-3 max-w-xl rounded-xl border border-edge bg-surface p-4">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm">Check for updates automatically</span>
            <input
              type="checkbox"
              checked={settings.update.autoCheck}
              onChange={(e) =>
                update({ update: { ...settings.update, autoCheck: e.target.checked } })
              }
              className="h-4 w-4 accent-[rgb(var(--wk-accent))]"
            />
          </label>
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-sm">Check every</span>
            <select
              value={settings.update.intervalHours}
              onChange={(e) =>
                update({ update: { ...settings.update, intervalHours: Number(e.target.value) } })
              }
              className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm"
            >
              {[1, 4, 12, 24].map((h) => (
                <option key={h} value={h}>
                  {h} hour{h > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-edge pt-3">
            <span className="text-xs text-muted">{updateState || 'No check run yet'}</span>
            <button
              onClick={() => window.wicked.invoke(SHELL_IPC.updateCheck)}
              className="flex items-center gap-2 rounded-lg bg-raised px-3 py-1.5 text-sm font-medium hover:bg-edge/60"
            >
              <RefreshCw size={14} />
              Check now
            </button>
          </div>
        </div>
      </section>

      {/* Backup & Restore */}
      <BackupSection />

      {/* Cloud Sync (private GitHub repo) */}
      <SyncSection />

      {/* App Lock */}
      <AppLockSection />

      {/* Web Server (LAN remote access) */}
      <WebServerSection />

      {/* Data & Recovery */}
      <RecoverySection />

      {/* AI Tools (MCP) */}
      <section className="mt-8">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Bot size={14} />
          AI Tools (MCP)
        </h2>
        <p className="mt-1 max-w-xl text-xs text-muted">
          Runs a local Model Context Protocol server so an AI agent (Claude Desktop, Claude
          Code, or any MCP client) can call every module’s actions. Localhost only. Destructive
          actions require confirmation and credentials are never auto-used.
        </p>
        <div className="mt-3 max-w-xl rounded-xl border border-edge bg-surface p-4">
          <label className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">Enable local MCP server</span>
            <input
              type="checkbox"
              checked={mcp?.enabled ?? false}
              onChange={(e) => toggleMcp(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--wk-accent))]"
            />
          </label>
          {mcp?.running && (
            <>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-edge pt-3">
                <span className="text-xs text-muted">Endpoint</span>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-raised px-2 py-1 text-xs text-ink">{mcp.url}</code>
                  <button
                    title="Copy endpoint"
                    onClick={async () => {
                      await navigator.clipboard.writeText(mcp.url)
                      setMcpCopied(true)
                      setTimeout(() => setMcpCopied(false), 1500)
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-ink"
                  >
                    <Copy size={13} />
                  </button>
                </div>
              </div>
              <div className="mt-1 text-xs text-ok">
                {mcpCopied ? 'Copied' : `Running · ${mcp.toolCount} tools exposed`}
              </div>
            </>
          )}
        </div>
      </section>

      {/* API Keys */}
      <section className="mt-8">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <KeyRound size={14} />
          API Keys
        </h2>
        <p className="mt-1 max-w-xl text-xs text-muted">
          Set once, used by every module (CodeLens, AI Chat, Coding App, Automatic Editing,
          Event Viewer Analyzer…). Keys are encrypted with Windows credential protection and
          never shown again after saving.
        </p>
        <div className="mt-3 max-w-xl overflow-hidden rounded-xl border border-edge bg-surface">
          {API_PROVIDERS.map((p) => (
            <ApiKeyRow
              key={p.id}
              id={p.id}
              name={p.name}
              placeholder={p.placeholder}
              isSet={keyStatus?.[p.id] ?? false}
              onChanged={refreshKeys}
            />
          ))}
        </div>
      </section>

      {/* Modules */}
      <section className="mt-8 pb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Modules</h2>
        <p className="mt-1 max-w-xl text-xs text-muted">
          Toggle a module’s visibility in the nav, or expand it to see where that app keeps its
          files and data.
        </p>
        <div className="mt-3 max-w-xl overflow-hidden rounded-xl border border-edge bg-surface">
          {modules.length === 0 && (
            <div className="p-4 text-sm text-muted">No modules installed.</div>
          )}
          {modules.map((mod, i) => (
            <ModuleRow
              key={mod.manifest.id}
              mod={mod}
              overrides={settings.moduleOverrides}
              enabled={!settings.disabledModules.includes(mod.manifest.id)}
              first={i === 0}
              onToggle={() => toggleModule(mod.manifest.id)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { KeyRound, Monitor, Moon, RefreshCw, Sun } from 'lucide-react'
import {
  API_PROVIDERS,
  SHELL_IPC,
  type ApiProviderId,
  type ShellSettings,
  type UpdateEvent
} from '@shared/types'
import { modules } from './registry'
import { useSettings } from '@/stores/settings'
import ModuleIcon from './ModuleIcon'

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

export default function SettingsScreen(): React.JSX.Element {
  const { settings, update } = useSettings()
  const [version, setVersion] = useState('')
  const [updateState, setUpdateState] = useState('')
  const [keyStatus, setKeyStatus] = useState<Record<ApiProviderId, boolean> | null>(null)

  const refreshKeys = (): void => {
    window.wicked
      .invoke(SHELL_IPC.apiKeysStatus)
      .then((s) => setKeyStatus(s as Record<ApiProviderId, boolean>))
  }

  useEffect(() => {
    refreshKeys()
  }, [])

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
        <div className="mt-3 max-w-xl overflow-hidden rounded-xl border border-edge bg-surface">
          {modules.length === 0 && (
            <div className="p-4 text-sm text-muted">No modules installed.</div>
          )}
          {modules.map(({ manifest }, i) => (
            <label
              key={manifest.id}
              className={`flex items-center justify-between gap-4 p-4 ${
                i > 0 ? 'border-t border-edge' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
                  <ModuleIcon name={manifest.icon} size={16} strokeWidth={1.8} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {manifest.name}
                    {manifest.status === 'beta' && (
                      <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warn">
                        Beta
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {manifest.description}
                  </span>
                </span>
              </span>
              <input
                type="checkbox"
                checked={!settings.disabledModules.includes(manifest.id)}
                onChange={() => toggleModule(manifest.id)}
                className="h-4 w-4 shrink-0 accent-[rgb(var(--wk-accent))]"
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  )
}

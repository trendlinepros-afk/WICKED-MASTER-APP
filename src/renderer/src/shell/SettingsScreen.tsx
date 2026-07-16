import { useEffect, useState } from 'react'
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  KeyRound,
  Loader2,
  Monitor,
  Moon,
  RefreshCw,
  Sun
} from 'lucide-react'
import {
  API_PROVIDERS,
  SHELL_IPC,
  type ApiProviderId,
  type McpStatus,
  type ModuleDataPath,
  type ShellSettings,
  type UpdateEvent
} from '@shared/types'
import { modules, type RegisteredModule } from './registry'
import { effectiveDescription, effectiveName } from './moduleView'
import { useSettings } from '@/stores/settings'
import ModuleIcon from './ModuleIcon'

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

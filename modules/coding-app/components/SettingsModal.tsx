import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/bridge'
import {
  MODEL_CATALOG,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type ProviderId
} from '../shared/config'
import type { Prereq, ProviderStatus } from '../shared/types'
import { VramUsage } from './VramUsage'

/**
 * Full module settings panel rendered as a modal overlay. Reads and writes
 * every field through the store's `updateConfig`. Organised into sections
 * selectable from a left-hand nav.
 *
 * Port notes vs the standalone app:
 *  - API keys are no longer entered here. They live in the WICKED shell's
 *    central, encrypted key vault (Settings → API Keys); this panel only shows
 *    whether a key is set and where to add one. Key values never reach this
 *    renderer.
 *  - Theme and update settings were removed — the shell owns both.
 */

type Section = 'general' | 'api' | 'ollama' | 'prereqs' | 'advanced'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'api', label: 'API Configuration' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'prereqs', label: 'Prerequisites' },
  { id: 'advanced', label: 'Advanced' }
]

const PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'gemini', 'deepseek']

function providerStatusText(s: ProviderStatus): string {
  const base =
    s.status === 'valid'
      ? '✓ Valid'
      : s.status === 'invalid'
        ? '✗ Invalid'
        : s.status === 'unconfigured'
          ? '⚠ Not configured'
          : 'Unknown'
  return s.message ? `${base} — ${s.message}` : base
}

export function SettingsModal(): JSX.Element | null {
  const config = useStore((s) => s.config)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const updateConfig = useStore((s) => s.updateConfig)
  const ollamaStatus = useStore((s) => s.ollamaStatus)
  const refreshOllama = useStore((s) => s.refreshOllama)
  const conversations = useStore((s) => s.conversations)
  const refreshConversations = useStore((s) => s.refreshConversations)
  const setBanner = useStore((s) => s.setBanner)
  // Presence of keys in the shell vault (booleans only, never values).
  const apiKeys = useStore((s) => s.apiKeys)
  const refreshApiKeys = useStore((s) => s.refreshApiKeys)

  const refreshModels = useStore((s) => s.refreshModels)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const favorites = config?.favoriteModels ?? []

  const [section, setSection] = useState<Section>('general')
  const [configPath, setConfigPath] = useState('')
  const [testResults, setTestResults] = useState<Partial<Record<ProviderId, ProviderStatus>>>({})
  const [testing, setTesting] = useState<Partial<Record<ProviderId, boolean>>>({})
  const [prereqs, setPrereqs] = useState<Prereq[] | null>(null)
  const [detectingVram, setDetectingVram] = useState(false)
  // Display unit for the LLM inactivity timeout (stored as seconds in config).
  const initialSecs = config?.llmKeepAliveSeconds ?? 300
  const [timeoutUnit, setTimeoutUnit] = useState<'minutes' | 'seconds'>(
    initialSecs % 60 === 0 ? 'minutes' : 'seconds'
  )
  // Per-model download progress for the catalog (keyed by model name).
  const [pullProgress, setPullProgress] = useState<
    Record<string, { status: string; percent: number }>
  >({})
  const overlayRef = useRef<HTMLDivElement>(null)

  // Subscribe to Ollama pull progress while the modal is open.
  useEffect(() => {
    if (!settingsOpen) return
    return api.onOllamaPullProgress((p) => {
      setPullProgress((prev) => ({
        ...prev,
        [p.name]: { status: p.status, percent: p.percent }
      }))
    })
  }, [settingsOpen])

  // Refresh vault key presence when the modal opens.
  useEffect(() => {
    if (!settingsOpen) return
    void refreshApiKeys()
  }, [settingsOpen, refreshApiKeys])

  // Load prerequisite status when the modal opens.
  useEffect(() => {
    if (!settingsOpen) return
    let alive = true
    void api.checkPrereqs().then((p) => {
      if (alive) setPrereqs(p)
    })
    return () => {
      alive = false
    }
  }, [settingsOpen])

  // Fetch the config file path when the modal opens.
  useEffect(() => {
    if (!settingsOpen) return
    let alive = true
    void api.getConfigPath().then((p) => {
      if (alive) setConfigPath(p)
    })
    return () => {
      alive = false
    }
  }, [settingsOpen])

  if (!settingsOpen || !config) return null

  const close = (): void => setSettingsOpen(false)

  // LLM timeout value shown in the selected unit; writes back seconds.
  const timeoutSeconds = config.llmKeepAliveSeconds
  const timeoutValue =
    timeoutUnit === 'minutes'
      ? Math.max(1, Math.round(timeoutSeconds / 60))
      : timeoutSeconds
  const setTimeoutValue = (value: number): void => {
    const secs = timeoutUnit === 'minutes' ? Math.round(value * 60) : Math.round(value)
    void updateConfig({ llmKeepAliveSeconds: Math.max(1, secs) })
  }

  // Auto-saved discrete choices (model select, enabled toggle).
  const setProvider = (
    p: ProviderId,
    patch: Partial<{ model: string; enabled: boolean }>
  ): void => {
    void updateConfig({
      api: { ...config.api, [p]: { ...config.api[p], ...patch } }
    })
  }

  const runTest = async (p: ProviderId): Promise<void> => {
    setTesting((t) => ({ ...t, [p]: true }))
    try {
      const res = await api.testProvider(p)
      setTestResults((r) => ({ ...r, [p]: res }))
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [p]: { provider: p, status: 'unknown', message: (err as Error).message }
      }))
    } finally {
      setTesting((t) => ({ ...t, [p]: false }))
    }
  }

  const installedNames = new Set((ollamaStatus?.models ?? []).map((m) => m.name))

  const pullModel = async (name: string): Promise<void> => {
    setPullProgress((prev) => ({ ...prev, [name]: { status: 'starting', percent: 0 } }))
    const res = await api.pullOllamaModel(name)
    setPullProgress((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    if (res.ok) {
      await refreshOllama()
      await refreshModels()
      setBanner({ kind: 'info', text: `Downloaded ${name}.` })
    } else if (res.error && res.error !== 'cancelled') {
      setBanner({ kind: 'error', text: `Download failed: ${res.error}` })
    }
  }

  const browseFolder = async (key: 'projectsRootPath' | 'obsidianVaultPath'): Promise<void> => {
    const dir = await api.pickFolder()
    if (dir) void updateConfig({ [key]: dir } as Record<typeof key, string>)
  }

  const detectVram = async (): Promise<void> => {
    setDetectingVram(true)
    try {
      const gb = await api.detectGpuVram()
      if (gb && gb > 0) {
        await updateConfig({ gpuVramGb: gb })
        setBanner({ kind: 'info', text: `Detected ${gb} GB of GPU VRAM.` })
      } else {
        setBanner({
          kind: 'error',
          text: 'Could not auto-detect VRAM. Please enter it manually.'
        })
      }
    } finally {
      setDetectingVram(false)
    }
  }

  const clearHistory = async (): Promise<void> => {
    if (!window.confirm(`Delete all ${conversations.length} conversation(s)? This cannot be undone.`))
      return
    for (const c of conversations) {
      try {
        await api.deleteConversation(c.id)
      } catch {
        // continue clearing remaining conversations
      }
    }
    await refreshConversations()
    setBanner({ kind: 'info', text: 'Chat history cleared.' })
  }

  const restoreBackup = async (): Promise<void> => {
    try {
      await api.restoreConfigBackup()
      location.reload()
    } catch (err) {
      setBanner({ kind: 'error', text: `Restore failed: ${(err as Error).message}` })
    }
  }

  const labelCls = 'block text-sm font-medium text-ink'
  const inputCls =
    'mt-1 w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent'

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) close()
      }}
    >
      <div className="flex max-h-[85vh] w-[640px] flex-col overflow-hidden rounded-lg border border-edge bg-raised shadow-xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-lg font-semibold text-ink">Settings</h2>
          <button
            type="button"
            className="rounded px-2 py-1 text-sm text-muted hover:bg-edge/60"
            onClick={close}
          >
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="w-40 shrink-0 border-r border-edge p-2">
            {SECTIONS.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`mb-1 block w-full rounded px-2 py-1.5 text-left text-sm ${
                  section === s.id
                    ? 'bg-accent text-accent-ink'
                    : 'text-ink hover:bg-edge/60'
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 space-y-5 overflow-y-auto p-4">
            {section === 'general' && (
              <>
                <div>
                  <label className={labelCls}>GPU VRAM (GB)</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={config.gpuVramGb}
                      onChange={(e) =>
                        void updateConfig({ gpuVramGb: Number(e.target.value) || 0 })
                      }
                      className={`${inputCls} mt-0 flex-1`}
                    />
                    <button
                      type="button"
                      disabled={detectingVram}
                      onClick={() => void detectVram()}
                      className="shrink-0 rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60 disabled:opacity-50"
                      title="Auto-detect from your GPU (nvidia-smi or Windows)"
                    >
                      {detectingVram ? 'Detecting…' : 'Detect'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    How much VRAM your GPU has. This is not a usage limit — the
                    app doesn't cap anything. It's used only to compare against
                    each local model's size so models that won't fit are flagged
                    in the model switcher.
                  </p>
                </div>

                <div>
                  <label className={labelCls}>Projects folder</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={config.projectsRootPath}
                      placeholder="Not set"
                      className={`${inputCls} mt-0 flex-1`}
                    />
                    <button
                      type="button"
                      className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                      onClick={() => void browseFolder('projectsRootPath')}
                    >
                      Browse
                    </button>
                  </div>
                </div>

                <div>
                  <label className={labelCls}>Obsidian vault</label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={config.obsidianVaultPath}
                      placeholder="Not set"
                      className={`${inputCls} mt-0 flex-1`}
                    />
                    <button
                      type="button"
                      className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                      onClick={() => void browseFolder('obsidianVaultPath')}
                    >
                      Browse
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Conversations are saved as Markdown into this folder (plus a
                    hidden JSON sidecar for restoring them here).
                  </p>
                </div>

                <p className="text-xs text-muted">
                  Theme and app updates are managed by the WICKED shell
                  (Settings in the activity bar).
                </p>
              </>
            )}

            {section === 'api' && (
              <>
                <div className="rounded border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-ink">
                  API keys are managed centrally in{' '}
                  <b>WICKED Settings → API Keys</b> (encrypted at rest, never
                  shown to modules' UI). This panel only picks models and
                  enables/disables providers.
                  {configPath && (
                    <div className="mt-1 break-all opacity-70">Module config: {configPath}</div>
                  )}
                </div>

                {PROVIDERS.map((p) => {
                  const result = testResults[p]
                  const enabled = config.api[p].enabled
                  const keySet = apiKeys[p] === true
                  return (
                    <div
                      key={p}
                      className="space-y-2 rounded border border-edge bg-surface p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-ink">
                          {PROVIDER_LABELS[p]}
                        </span>
                        {/* Per-provider enable/disable toggle. */}
                        <label
                          className="flex cursor-pointer items-center gap-2 text-xs text-muted"
                          title={
                            enabled
                              ? 'Enabled — models appear in the switcher'
                              : 'Disabled — models hidden from the switcher'
                          }
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) =>
                              setProvider(p, { enabled: e.target.checked })
                            }
                          />
                          {enabled ? 'Enabled' : 'Disabled'}
                        </label>
                      </div>
                      <div className={enabled ? '' : 'opacity-50'}>
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className={`rounded px-1.5 py-0.5 font-medium ${
                              keySet ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'
                            }`}
                          >
                            {keySet ? '✓ API key set' : '⚠ No API key'}
                          </span>
                          {!keySet && (
                            <span className="text-muted">
                              Add one in WICKED Settings → API Keys.
                            </span>
                          )}
                        </div>
                        <label className={`${labelCls} mt-2`}>Model</label>
                        <select
                          value={config.api[p].model}
                          onChange={(e) => setProvider(p, { model: e.target.value })}
                          className={inputCls}
                        >
                          {PROVIDER_MODELS[p].map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          disabled={testing[p] || !keySet}
                          onClick={() => void runTest(p)}
                          title={keySet ? undefined : 'Set an API key first'}
                          className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-50"
                        >
                          {testing[p] ? 'Testing…' : 'Test'}
                        </button>
                        {result && (
                          <span
                            className={`text-sm ${
                              result.status === 'valid'
                                ? 'text-ok'
                                : result.status === 'invalid'
                                  ? 'text-danger'
                                  : 'text-muted'
                            }`}
                          >
                            {providerStatusText(result)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}

                <div className="space-y-2 rounded border border-edge bg-surface p-3">
                  <div className="text-sm font-semibold text-ink">Gemini Analysis</div>
                  <label
                    className={`flex items-center gap-2 text-sm ${
                      apiKeys.gemini ? 'text-ink' : 'text-muted'
                    }`}
                    title={
                      apiKeys.gemini
                        ? undefined
                        : 'Add a Google Gemini API key in WICKED Settings → API Keys to enable analysis'
                    }
                  >
                    <input
                      type="checkbox"
                      disabled={!apiKeys.gemini}
                      checked={config.geminiAnalysisEnabled}
                      onChange={(e) =>
                        void updateConfig({ geminiAnalysisEnabled: e.target.checked })
                      }
                    />
                    Have Gemini Analyze Screenshots
                  </label>
                  <p className="text-xs text-muted">
                    Analyzes live preview screenshots for bugs and UI issues.
                  </p>
                </div>
              </>
            )}

            {section === 'ollama' && (
              <>
                <div>
                  <label className={labelCls}>Endpoint</label>
                  <input
                    type="text"
                    value={config.ollamaEndpoint}
                    onChange={(e) => void updateConfig({ ollamaEndpoint: e.target.value })}
                    placeholder="http://localhost:11434"
                    className={inputCls}
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={config.autoStartOllama}
                    onChange={(e) => void updateConfig({ autoStartOllama: e.target.checked })}
                  />
                  Auto-start Ollama when this module opens
                </label>

                {/* Local LLM inactivity timeout (Ollama keep_alive). */}
                <div className="rounded border border-edge bg-surface p-3">
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={config.llmTimeoutEnabled}
                      onChange={(e) =>
                        void updateConfig({ llmTimeoutEnabled: e.target.checked })
                      }
                    />
                    Local LLM timeout (auto-unload after inactivity)
                  </label>
                  {config.llmTimeoutEnabled && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-sm text-muted">Unload after</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={timeoutValue}
                        onChange={(e) => setTimeoutValue(Number(e.target.value) || 1)}
                        className={`${inputCls} mt-0 w-24`}
                      />
                      <select
                        value={timeoutUnit}
                        onChange={(e) =>
                          setTimeoutUnit(e.target.value as 'minutes' | 'seconds')
                        }
                        className={`${inputCls} mt-0 w-32`}
                      >
                        <option value="minutes">minutes</option>
                        <option value="seconds">seconds</option>
                      </select>
                      <span className="text-sm text-muted">of inactivity</span>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted">
                    {config.llmTimeoutEnabled
                      ? `The model unloads and frees VRAM after ${config.llmKeepAliveSeconds}s idle.`
                      : 'Disabled — the model stays loaded until you unload it manually.'}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-sm text-ink">Status:</span>
                  <span
                    className={`text-sm font-medium ${
                      ollamaStatus?.connected ? 'text-ok' : 'text-danger'
                    }`}
                  >
                    {ollamaStatus?.connected ? 'Connected' : 'Disconnected'}
                  </span>
                  <button
                    type="button"
                    className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                    onClick={() => {
                      void (async () => {
                        await api.startOllama()
                        await refreshOllama()
                      })()
                    }}
                  >
                    Reconnect
                  </button>
                </div>

                <p className="text-sm text-muted">
                  Ollama not installed?{' '}
                  <button
                    type="button"
                    className="text-accent underline"
                    onClick={() => void api.openExternal('https://ollama.com/download')}
                  >
                    Download Ollama
                  </button>
                  . After installing a model, use the "Load Model" button next to the
                  model switcher to load it into memory.
                </p>

                <VramUsage className="rounded border border-edge bg-surface p-3" />

                <div className="border-t border-edge pt-3">
                  <div className="text-sm font-semibold text-ink">
                    Recommended models (4–12 GB)
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    Coding-capable models that fit common GPUs. Download one that
                    fits your VRAM ({config.gpuVramGb} GB set). Sizes are
                    approximate.
                  </p>
                  <div className="mt-2 space-y-2">
                    {MODEL_CATALOG.map((cm) => {
                      const installed = installedNames.has(cm.name)
                      const prog = pullProgress[cm.name]
                      const fits = cm.vramGb <= config.gpuVramGb
                      return (
                        <div
                          key={cm.name}
                          className="rounded border border-edge bg-surface p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                                <button
                                  type="button"
                                  onClick={() => void toggleFavorite(`ollama:${cm.name}`)}
                                  title={
                                    favorites.includes(`ollama:${cm.name}`)
                                      ? 'Unfavorite'
                                      : 'Favorite (pin to top of the model list)'
                                  }
                                  className={`leading-none ${
                                    favorites.includes(`ollama:${cm.name}`)
                                      ? 'text-warn'
                                      : 'text-muted hover:text-warn'
                                  }`}
                                >
                                  {favorites.includes(`ollama:${cm.name}`) ? '★' : '☆'}
                                </button>
                                {cm.name}
                                <span
                                  className={`rounded px-1.5 py-0.5 text-xs font-normal ${
                                    fits ? 'bg-edge/60 text-muted' : 'bg-warn/20 text-warn'
                                  }`}
                                  title={
                                    fits
                                      ? 'Fits your VRAM'
                                      : `Exceeds your ${config.gpuVramGb} GB — will be slow`
                                  }
                                >
                                  ~{cm.vramGb} GB
                                </span>
                              </div>
                              <p className="mt-0.5 text-xs text-muted">
                                {cm.description}
                              </p>
                            </div>
                            <div className="shrink-0">
                              {installed ? (
                                <span className="text-xs font-medium text-ok">
                                  ✓ Installed
                                </span>
                              ) : prog ? (
                                <button
                                  type="button"
                                  className="rounded border border-edge px-2.5 py-1 text-xs hover:bg-edge/60"
                                  onClick={() => void api.cancelOllamaPull(cm.name)}
                                >
                                  {prog.percent > 0 ? `${prog.percent}%` : prog.status}·Cancel
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded bg-accent px-2.5 py-1 text-xs text-accent-ink hover:opacity-90"
                                  onClick={() => void pullModel(cm.name)}
                                >
                                  Download
                                </button>
                              )}
                            </div>
                          </div>
                          {prog && (
                            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-edge/60">
                              <div
                                className="h-full bg-accent transition-all"
                                style={{ width: `${prog.percent}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}

            {section === 'prereqs' && (
              <>
                <p className="text-sm text-muted">
                  These external tools aren't bundled with WICKED. The module
                  runs without them, but each unlocks specific features.
                </p>
                {prereqs === null ? (
                  <p className="text-sm text-muted">Checking…</p>
                ) : (
                  prereqs.map((pr) => (
                    <div
                      key={pr.id}
                      className="flex items-start justify-between gap-3 rounded border border-edge bg-surface p-3"
                    >
                      <div>
                        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
                          <span className={pr.installed ? 'text-ok' : 'text-danger'}>
                            {pr.installed ? '✓' : '✗'}
                          </span>
                          {pr.name}
                          <span
                            className={`text-xs font-normal ${
                              pr.installed ? 'text-ok' : 'text-muted'
                            }`}
                          >
                            {pr.installed ? 'Installed' : 'Not found'}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted">{pr.impact}</p>
                      </div>
                      {!pr.installed && (
                        <button
                          type="button"
                          className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm text-accent-ink hover:opacity-90"
                          onClick={() => void api.openExternal(pr.downloadUrl)}
                        >
                          Download
                        </button>
                      )}
                    </div>
                  ))
                )}
                <button
                  type="button"
                  className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                  onClick={() => void api.checkPrereqs().then((p) => setPrereqs(p))}
                >
                  Re-check
                </button>
              </>
            )}

            {section === 'advanced' && (
              <>
                <div>
                  <label className={labelCls}>
                    Temperature: {config.temperature.toFixed(2)}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.temperature}
                    onChange={(e) =>
                      void updateConfig({ temperature: Number(e.target.value) })
                    }
                    className="mt-1 w-full"
                  />
                  <p className="mt-1 text-xs text-muted">
                    Controls randomness. Lower (~0.2) = focused, consistent, best
                    for code. Higher (~0.8) = more creative and varied, but more
                    likely to wander or make mistakes.
                  </p>
                </div>

                <div>
                  <label className={labelCls}>Max tokens</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={config.maxTokens}
                    onChange={(e) =>
                      void updateConfig({ maxTokens: Number(e.target.value) || 1 })
                    }
                    className={inputCls}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Maximum length of a single response (~1 token ≈ ¾ of a word,
                    so 2048 ≈ 1,500 words). Raise it for generating large files;
                    higher values are slower and cost more on paid APIs.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  <button
                    type="button"
                    className="rounded border border-danger/50 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
                    onClick={() => void clearHistory()}
                  >
                    Clear all chat history
                  </button>
                  <button
                    type="button"
                    className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                    onClick={() => void restoreBackup()}
                  >
                    Restore config from backup
                  </button>
                  <button
                    type="button"
                    className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                    onClick={() => void api.exportLogs()}
                  >
                    Export app logs
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

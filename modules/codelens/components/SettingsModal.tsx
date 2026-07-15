import { KeyRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { SHELL_IPC } from '@shared/types'
import { codelensApi } from '../lib/bridge'
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_LABELS,
  DEFAULT_MODELS,
  MODEL_SUGGESTIONS
} from '../shared/providers'
import type { AiProvider, Settings } from '../shared/types'
import { Spinner } from './Spinner'

interface Props {
  settings: Settings
  hasProject: boolean
  onClose(): void
  onSettingsChanged(next: Settings): void
  onRescan(): void
}

type KeyStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

const input =
  'rounded-md border border-edge bg-bg px-3 py-2 text-xs text-ink placeholder-muted/60 outline-none focus:border-accent'

export function SettingsModal({
  settings,
  hasProject,
  onClose,
  onSettingsChanged,
  onRescan
}: Props) {
  const [provider, setProvider] = useState<AiProvider>(settings.ai.provider)
  const [model, setModel] = useState(settings.ai.models[settings.ai.provider])
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({ kind: 'idle' })
  const [ignoresText, setIgnoresText] = useState(settings.customIgnores.join('\n'))
  const [ignoresSaved, setIgnoresSaved] = useState(false)

  useEffect(() => setIgnoresText(settings.customIgnores.join('\n')), [settings.customIgnores])

  // keys live in the WICKED central vault — refresh presence flags when they change
  useEffect(() => {
    return window.wicked.on(SHELL_IPC.apiKeysChanged, () => {
      codelensApi.getSettings().then(onSettingsChanged)
    })
  }, [onSettingsChanged])

  const applyConfig = async (p: AiProvider, m: string): Promise<void> => {
    const next = await codelensApi.setAiConfig(p, m.trim() || DEFAULT_MODELS[p])
    onSettingsChanged(next)
  }

  const switchProvider = (p: AiProvider): void => {
    setProvider(p)
    setModel(settings.ai.models[p])
    setKeyStatus({ kind: 'idle' })
    void applyConfig(p, settings.ai.models[p])
  }

  const commitModel = (): void => {
    const m = model.trim() || DEFAULT_MODELS[provider]
    setModel(m)
    void applyConfig(provider, m)
  }

  const testConnection = async (): Promise<void> => {
    setKeyStatus({ kind: 'busy', label: `Testing against ${AI_PROVIDER_LABELS[provider]}…` })
    await applyConfig(provider, model) // make sure this provider+model is active before testing
    const test = await codelensApi.testApiKey()
    if (test.ok) {
      setKeyStatus({ kind: 'ok', message: test.data })
    } else {
      setKeyStatus({ kind: 'error', message: test.error })
    }
  }

  const saveIgnores = async (): Promise<void> => {
    const list = ignoresText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const next = await codelensApi.setCustomIgnores(list)
    onSettingsChanged(next)
    setIgnoresSaved(true)
    setTimeout(() => setIgnoresSaved(false), 2500)
  }

  const hasKeyForProvider = settings.ai.hasKey[provider]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[85vh] w-[560px] overflow-y-auto rounded-xl border border-edge bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Settings</h2>
          <button className="text-muted/70 hover:text-ink" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* AI provider + model + key */}
        <section className="mb-6">
          <h3 className="mb-1 flex items-center gap-1.5 text-sm font-medium text-ink">
            <KeyRound size={14} className={hasKeyForProvider ? 'text-ok' : 'text-muted/70'} />
            AI provider
          </h3>
          <p className="mb-3 text-xs text-muted">
            Powers the plain-English explanations and the project report. API keys are managed
            centrally in <b>WICKED Settings → API Keys</b> and shared by all modules. Without a
            key, all scanning and graph features still work offline.
          </p>

          <div className="mb-3 flex gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-muted">Provider</label>
              <select
                className={`${input} w-full`}
                value={provider}
                onChange={(e) => switchProvider(e.target.value as AiProvider)}
              >
                {AI_PROVIDER_IDS.map((p) => (
                  <option key={p} value={p}>
                    {AI_PROVIDER_LABELS[p]}
                    {settings.ai.hasKey[p] ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-muted">Model</label>
              <input
                className={`${input} w-full`}
                list="codelens-model-suggestions"
                value={model}
                placeholder={DEFAULT_MODELS[provider]}
                onChange={(e) => setModel(e.target.value)}
                onBlur={commitModel}
                onKeyDown={(e) => e.key === 'Enter' && commitModel()}
              />
              <datalist id="codelens-model-suggestions">
                {MODEL_SUGGESTIONS[provider].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>
          <p className="mb-3 text-[11px] text-muted/70">
            The model list is a suggestion — type any model id your {AI_PROVIDER_LABELS[provider]}{' '}
            account can access.
          </p>

          <div className="flex items-center gap-2 rounded-md border border-edge bg-raised/50 px-3 py-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${hasKeyForProvider ? 'bg-ok' : 'bg-muted/40'}`} />
            <span className="min-w-0 flex-1 text-xs text-muted">
              {hasKeyForProvider
                ? `A ${AI_PROVIDER_LABELS[provider]} key is set in WICKED Settings → API Keys.`
                : `No ${AI_PROVIDER_LABELS[provider]} key set — add one in WICKED Settings → API Keys.`}
            </span>
            <button
              className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink hover:bg-accent/85 disabled:opacity-40"
              onClick={() => void testConnection()}
              disabled={!hasKeyForProvider || keyStatus.kind === 'busy'}
            >
              Test connection
            </button>
          </div>
          <div className="mt-2 min-h-[18px] text-xs">
            {keyStatus.kind === 'busy' && <Spinner label={keyStatus.label} />}
            {keyStatus.kind === 'ok' && <span className="text-ok">{keyStatus.message}</span>}
            {keyStatus.kind === 'error' && <span className="text-danger">{keyStatus.message}</span>}
          </div>
        </section>

        {/* custom ignores */}
        <section>
          <h3 className="mb-1 text-sm font-medium text-ink">Custom ignore patterns</h3>
          <p className="mb-2 text-xs text-muted">
            One gitignore-style pattern per line, applied on top of each project&apos;s .gitignore and
            the built-in defaults (node_modules, .git, dist, build, binaries…).
          </p>
          <textarea
            className="h-28 w-full resize-y rounded-md border border-edge bg-bg p-3 font-mono text-xs text-ink outline-none focus:border-accent"
            placeholder={'examples:\nlegacy/\n*.generated.ts'}
            value={ignoresText}
            onChange={(e) => setIgnoresText(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink hover:bg-accent/85"
              onClick={() => void saveIgnores()}
            >
              Save patterns
            </button>
            {ignoresSaved && hasProject && (
              <button
                className="text-xs text-accent underline-offset-2 hover:underline"
                onClick={onRescan}
              >
                Saved — rescan project now?
              </button>
            )}
            {ignoresSaved && !hasProject && <span className="text-xs text-ok">Saved.</span>}
          </div>
        </section>
      </div>
    </div>
  )
}

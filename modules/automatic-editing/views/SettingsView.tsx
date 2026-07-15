import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { btn, input, panel } from '../lib/ui'
import type { AITask, AIProviderId } from '../shared/types'

const TASKS: { id: AITask; label: string }[] = [
  { id: 'retake-detection', label: 'Retake removal (stage 1)' },
  { id: 'cut-review', label: 'Cut review (stage 2)' },
  { id: 'graphic-planning', label: 'Graphic planning (stage 4)' },
  { id: 'graphic-slot-filling', label: 'Graphic slot filling (stage 4)' },
  { id: 'revision-parsing', label: 'Revision parsing (review loop)' }
]
const PROVIDERS: AIProviderId[] = ['gemini', 'openai', 'deepseek', 'anthropic']

export default function SettingsView() {
  const { settings, refreshSettings, project, setView, viewBeforeSettings } = useStore()
  useEffect(() => {
    refreshSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!settings) return <div className="p-8 text-muted">Loading settings…</div>

  // Back returns to the view the user came from (editor, shorts, or library),
  // falling back to the library if that view needs a project and none is open.
  const needsProject = viewBeforeSettings === 'editor' || viewBeforeSettings === 'shorts'
  const backTarget = needsProject && !project ? 'library' : viewBeforeSettings
  const backLabel = backTarget === 'editor' ? 'editor' : backTarget === 'shorts' ? 'shorts' : 'projects'

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-3xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-ink">Settings</h1>
          <button className={btn} onClick={() => setView(backTarget)}>
            ← Back to {backLabel}
          </button>
        </div>
        <ProjectStorage />
        <ApiKeys />
        <Routing />
        <PipelineTuning />
        <BrandKitPanel />
        <Libraries />
        <HostingPanel />
        <OpusClipPanel />
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className={`${panel} p-5`}>
      <h2 className="font-semibold text-ink mb-1">{title}</h2>
      {hint && <p className="text-xs text-muted mb-4">{hint}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-72 text-sm text-ink/80 shrink-0">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ProjectStorage() {
  const { settings, completeOnboarding } = useStore()
  const [error, setError] = useState<string | null>(null)
  if (!settings) return null
  return (
    <Section
      title="Project storage"
      hint="The master folder where all projects and their renders live. Changing it affects new projects; existing projects stay where they were created."
    >
      <Row label="Projects folder">
        <span className="text-xs text-muted truncate flex-1">
          {settings.projectsDir ?? 'Default location (module data folder)'}
        </span>
        <button
          className={`${btn} text-xs`}
          onClick={async () => {
            setError(null)
            const dir = await api.pickDirectory()
            if (!dir) return
            try {
              await completeOnboarding(dir)
            } catch (err: any) {
              setError(err?.message ?? "Couldn't use that folder — pick a different one.")
            }
          }}
        >
          Change…
        </button>
      </Row>
      {error && <p className="text-xs text-danger">{error}</p>}
    </Section>
  )
}

/**
 * API keys live in the WICKED shell's central vault (Settings → API Keys),
 * not in this module — this section only shows which keys are present and
 * where to add them. Values never reach this renderer.
 */
function ApiKeys() {
  const { settings } = useStore()
  const keys = [
    { id: 'gemini' as const, label: 'Gemini (default AI provider)' },
    { id: 'openai' as const, label: 'OpenAI (Whisper transcription + optional AI)' },
    { id: 'deepseek' as const, label: 'DeepSeek (optional AI)' },
    { id: 'anthropic' as const, label: 'Anthropic (Claude — optional AI)' },
    { id: 'opusclip' as const, label: 'OpusClip (shorts — Pro Beta / Max / Business plan)' }
  ]
  const missing = keys.filter((k) => !settings?.keysPresent[k.id])
  return (
    <Section
      title="API keys"
      hint="Keys are managed centrally in the WICKED shell: Settings → API Keys. They are encrypted with Windows credential storage and read only by this module's background pipeline — a feature whose key is missing runs in mock mode."
    >
      {keys.map((k) => (
        <Row key={k.id} label={k.label}>
          {settings?.keysPresent[k.id] ? (
            <span className="text-ok text-xs">● saved in shell vault</span>
          ) : (
            <span className="text-warn text-xs">not set — add it in Settings → API Keys (mock mode until then)</span>
          )}
        </Row>
      ))}
      {missing.length > 0 && (
        <p className="text-xs text-muted">
          Open the shell&apos;s <b className="text-ink">Settings → API Keys</b> (gear icon in the WICKED nav) to add
          missing keys.
        </p>
      )}
    </Section>
  )
}

function Routing() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  return (
    <Section title="AI routing" hint="Per-task provider. Default is Gemini. Transcription is pinned to OpenAI Whisper and is not routable. A task whose provider has no key runs in mock mode.">
      {TASKS.map((t) => (
        <Row key={t.id} label={t.label}>
          <select
            className={`${input} !w-44`}
            value={settings.routing.taskProviders[t.id]}
            onChange={(e) =>
              saveSettings({
                routing: {
                  taskProviders: { ...settings.routing.taskProviders, [t.id]: e.target.value as AIProviderId }
                }
              })
            }
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
                {!settings.keysPresent[p as 'gemini' | 'openai' | 'deepseek' | 'anthropic'] ? ' (no key → mock)' : ''}
              </option>
            ))}
          </select>
        </Row>
      ))}
    </Section>
  )
}

function PipelineTuning() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const num = (v: string, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return (
    <Section
      title="Pipeline tuning"
      hint="With an OpenAI key, dead space is detected from the transcript — it keeps exactly where words are (plus the keep-pad buffer) and cuts the gaps, so you mostly only need Min silence duration + Keep-pad. The dB threshold is used only as a fallback when there's no transcript."
    >
      <Row label="Silence threshold (dB) — fallback only">
        <input
          className={`${input} !w-28`} type="number" defaultValue={settings.silence.thresholdDb}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, thresholdDb: num(e.target.value, -35) } })}
        />
      </Row>
      <Row label="Min silence duration (s)">
        <input
          className={`${input} !w-28`} type="number" step="0.1" defaultValue={settings.silence.minSilenceSec}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, minSilenceSec: num(e.target.value, 0.6) } })}
        />
      </Row>
      <Row label="Keep-pad (ms)">
        <input
          className={`${input} !w-28`} type="number" defaultValue={settings.silence.keepPadMs}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, keepPadMs: num(e.target.value, 150) } })}
        />
      </Row>
      <Row label="Scene threshold (0–1)">
        <input
          className={`${input} !w-28`} type="number" step="0.05" defaultValue={settings.scene.threshold}
          onBlur={(e) => saveSettings({ scene: { ...settings.scene, threshold: num(e.target.value, 0.4) } })}
        />
      </Row>
      <Row label="Default transition">
        <select
          className={`${input} !w-44`} value={settings.scene.defaultTransition}
          onChange={(e) => saveSettings({ scene: { ...settings.scene, defaultTransition: e.target.value as any } })}
        >
          <option value="crossfade">crossfade</option>
          <option value="dip-to-black">dip-to-black</option>
        </select>
      </Row>
      <Row label="Prefer NVENC (GPU) encoding">
        <input
          type="checkbox" checked={settings.export.preferNvenc} className="accent-accent"
          onChange={(e) => saveSettings({ export: { preferNvenc: e.target.checked } })}
        />
      </Row>
    </Section>
  )
}

function BrandKitPanel() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const bk = settings.brandKit
  const save = (patch: Partial<typeof bk>) => saveSettings({ brandKit: { ...bk, ...patch } })
  return (
    <Section title="Brand kit" hint="Every generated graphic AND every caption pulls from here, so output stays consistent.">
      <Row label="Display font">
        <input className={input} defaultValue={bk.fontDisplay} onBlur={(e) => save({ fontDisplay: e.target.value })} />
      </Row>
      <Row label="Body / caption font">
        <input className={input} defaultValue={bk.fontBody} onBlur={(e) => save({ fontBody: e.target.value })} />
      </Row>
      <Row label="Custom fonts (.ttf/.otf)">
        <div className="flex-1">
          {bk.customFonts.map((f) => (
            <div key={f.path} className="flex items-center gap-2 text-xs text-muted mb-1">
              <span className="flex-1 truncate">{f.name} — {f.path}</span>
              <button className="text-danger hover:underline" onClick={() => save({ customFonts: bk.customFonts.filter((x) => x.path !== f.path) })}>remove</button>
            </div>
          ))}
          <button
            className={`${btn} text-xs`}
            onClick={async () => {
              const font = await api.pickFontFile()
              if (font) save({ customFonts: [...bk.customFonts, font] })
            }}
          >
            + Load font file
          </button>
        </div>
      </Row>
      <Row label="Palette">
        <div className="flex gap-2">
          {(Object.keys(bk.palette) as (keyof typeof bk.palette)[]).map((k) => (
            <label key={k} className="flex flex-col items-center gap-1 text-[10px] text-muted">
              <input
                type="color"
                // Uncontrolled + persist on blur: onChange fires on every drag
                // tick of the OS picker, which would hammer disk with a save
                // per tick. The native input shows the live color itself.
                defaultValue={bk.palette[k]}
                key={bk.palette[k]}
                className="w-9 h-9 rounded cursor-pointer bg-transparent"
                onBlur={(e) => save({ palette: { ...bk.palette, [k]: e.target.value } })}
              />
              {k}
            </label>
          ))}
        </div>
      </Row>
      <Row label="Logo">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-muted truncate flex-1">{bk.logoPath ?? 'none'}</span>
          <button
            className={`${btn} text-xs`}
            onClick={async () => {
              const p = await api.pickLogoFile()
              if (p) save({ logoPath: p })
            }}
          >
            Pick logo
          </button>
        </div>
      </Row>
    </Section>
  )
}

function Libraries() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const pick = async (key: 'musicLibraryDir' | 'sfxLibraryDir') => {
    const dir = await api.pickDirectory()
    if (dir) saveSettings({ [key]: dir })
  }
  return (
    <Section title="Music & SFX libraries" hint="Point at local folders. Stage 5 lays background music from the music library and ducks it under speech automatically.">
      <Row label="Music folder">
        <span className="text-xs text-muted truncate flex-1">{settings.musicLibraryDir ?? 'not set'}</span>
        <button className={`${btn} text-xs`} onClick={() => pick('musicLibraryDir')}>Browse</button>
      </Row>
      <Row label="SFX folder">
        <span className="text-xs text-muted truncate flex-1">{settings.sfxLibraryDir ?? 'not set'}</span>
        <button className={`${btn} text-xs`} onClick={() => pick('sfxLibraryDir')}>Browse</button>
      </Row>
    </Section>
  )
}

function HostingPanel() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const h = settings.hosting
  const save = (patch: Partial<typeof h>) => saveSettings({ hosting: { ...h, ...patch } })
  return (
    <Section
      title="Final video hosting (required for Shorts)"
      hint="OpusClip ingests a video URL, not a local file — your approved final render is uploaded here first, then the URL is passed to OpusClip. Any S3-compatible bucket works (AWS S3, Cloudflare R2, Backblaze B2, MinIO). The S3 access/secret keys go in the shell's Settings → API Keys."
    >
      <Row label="Bucket"><input className={input} defaultValue={h.bucket ?? ''} onBlur={(e) => save({ bucket: e.target.value })} /></Row>
      <Row label="Region"><input className={input} defaultValue={h.region ?? ''} placeholder="us-east-1" onBlur={(e) => save({ region: e.target.value })} /></Row>
      <Row label="Endpoint (non-AWS)"><input className={input} defaultValue={h.endpoint ?? ''} placeholder="https://…r2.cloudflarestorage.com" onBlur={(e) => save({ endpoint: e.target.value })} /></Row>
      <Row label="Public base URL (optional)"><input className={input} defaultValue={h.publicBaseUrl ?? ''} placeholder="https://cdn.example.com — leave empty to use signed URLs" onBlur={(e) => save({ publicBaseUrl: e.target.value })} /></Row>
      <p className={`text-xs ${h.configured ? 'text-ok' : 'text-warn'}`}>
        {h.configured
          ? '✓ Hosting configured.'
          : 'Hosting not configured yet — set the bucket above AND the s3-access / s3-secret keys in Settings → API Keys. Shorts generation is blocked until then.'}
      </p>
    </Section>
  )
}

function OpusClipPanel() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  return (
    <Section
      title="OpusClip"
      hint="Requires a Pro Beta, Max, or Business plan. Rate limit: 30 requests/min. Minimum ~10 credits (≈10 min of video) per project. The API key goes in the shell's Settings → API Keys."
    >
      <Row label="Brand template ID">
        <input
          className={input} defaultValue={settings.opusclip.brandTemplateId ?? ''} placeholder="from your OpusClip dashboard"
          onBlur={(e) => saveSettings({ opusclip: { ...settings.opusclip, brandTemplateId: e.target.value || undefined } })}
        />
      </Row>
      <Row label="Webhook URL (optional)">
        <input
          className={input} defaultValue={settings.opusclip.webhookUrl ?? ''} placeholder="left empty → the module polls for results"
          onBlur={(e) => saveSettings({ opusclip: { ...settings.opusclip, webhookUrl: e.target.value || undefined } })}
        />
      </Row>
    </Section>
  )
}

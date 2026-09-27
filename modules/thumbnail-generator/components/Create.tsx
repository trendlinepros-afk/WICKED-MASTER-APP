import { useEffect, useState } from 'react'
import { Ban, Coins, ExternalLink, FolderOpen, Gauge, ImagePlus, LoaderCircle, Minus, Palette, Plus, Sparkles, TriangleAlert, UserRound, X, Youtube } from 'lucide-react'
import { inv, useThumbs } from '../store'
import type { Generated, ImageRef, Model } from '../types'
import { estimate, FORMATS, fmtUsd, MODELS, modelInfo, modelRestriction } from '../lib/models'
import { btn, btnAccent, btnSm, card, input, label, ytPreview, Pill, Segmented, Thumb } from './ui'

/* ------------------------------ cost estimate ------------------------------ */

export function CostBadge(): React.JSX.Element {
  const s = useThumbs((st) => st.settings)
  const f = useThumbs((st) => st.form)
  const est = estimate(s, s.creditsPerModel[f.model], f.count)
  return (
    <div className={`${card} min-w-[230px] px-4 py-2.5`} title="Based on the credit prices in Settings; updated automatically when Pikzels reports a cost.">
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
        <Coins size={12} /> Cost estimate
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums text-ink">{est.creditsEach} credits</span>
        {est.dollarsEach != null && <span className="text-sm text-muted">≈ {fmtUsd(est.dollarsEach)}</span>}
        <span className="text-xs text-muted">per thumbnail</span>
      </div>
      {f.count > 1 && (
        <div className="text-xs text-muted">
          × {f.count} = <b className="text-ink">{est.creditsTotal} credits</b>
          {est.dollarsTotal != null && <> ≈ {fmtUsd(est.dollarsTotal)}</>}
        </div>
      )}
      <div className="mt-0.5 text-[10.5px] text-muted">
        {modelInfo(f.model).label}
        {s.creditsRemaining != null ? ` · balance ${s.creditsRemaining.toLocaleString()} credits` : est.dollarsEach == null ? ' · set your plan in Settings for $' : ''}
      </div>
    </div>
  )
}

/* ------------------------------- image picker ------------------------------ */

function ImageSlot({ value, onChange, placeholder, allowUrl }: { value: ImageRef | null; onChange: (v: ImageRef | null) => void; placeholder: string; allowUrl?: boolean }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const pick = async (): Promise<void> => {
    const r = (await inv('pick-images', { multi: false, title: placeholder })) as { images?: ImageRef[]; error?: string }
    if (r.images?.[0]) onChange(r.images[0])
  }
  if (value)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-edge bg-bg p-2">
        <Thumb path={value.path} url={value.preview ?? ytPreview(value.url) ?? value.url} className="w-28 shrink-0" />
        <div className="min-w-0 flex-1 truncate text-xs text-muted">{value.label ?? value.url ?? value.path}</div>
        <button className={btnSm} onClick={() => onChange(null)}>
          <X size={12} /> Remove
        </button>
      </div>
    )
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className={btn} onClick={() => void pick()}>
        <ImagePlus size={14} /> Choose image…
      </button>
      {allowUrl && (
        <>
          <span className="text-xs text-muted">or</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && onChange({ url: url.trim(), label: url.trim() })} placeholder="Paste an image URL" className={`${input} max-w-xs`} />
          <button className={btnSm} disabled={!url.trim()} onClick={() => onChange({ url: url.trim(), label: url.trim() })}>
            Use
          </button>
        </>
      )}
    </div>
  )
}

/* --------------------------------- results --------------------------------- */

function ResultCard({ g }: { g: Generated }): React.JSX.Element {
  const s = useThumbs()
  const [scoring, setScoring] = useState(false)
  const score = async (): Promise<void> => {
    setScoring(true)
    const r = (await inv('score', { generatedId: g.id, title: g.prompt })) as { ok: boolean; error?: string; score?: { main: number } }
    setScoring(false)
    if (!r.ok) return s.showToast('err', r.error ?? 'Could not score')
    s.showToast('ok', `Score: ${r.score?.main}/10`)
    await s.loadHistory()
  }
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="relative">
        <Thumb path={g.status === 'done' ? g.file : undefined} aspect={g.format === '9:16' ? '9/16' : g.format === '1:1' ? '1/1' : '16/9'} className="rounded-none" />
        {g.status !== 'done' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-xs text-white">
            {g.status === 'failed' ? (
              <>
                <TriangleAlert size={18} className="text-warn" />
                <span className="max-w-[90%] text-center">{g.error}</span>
              </>
            ) : (
              <>
                <LoaderCircle size={18} className="animate-spin" />
                <span>{g.status === 'queued' ? 'Queued…' : 'Generating…'}</span>
              </>
            )}
          </div>
        )}
        {g.score && (
          <div className="absolute right-2 top-2 rounded-md bg-black/70 px-2 py-0.5 text-xs font-semibold text-white" title={g.score.suggestion}>
            <Gauge size={11} className="mr-1 inline" />
            {g.score.main}/10
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 p-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted" title={g.fileName || g.error}>
          {g.fileName || (g.status === 'failed' ? 'failed' : '…')}
        </span>
        {g.status === 'done' && (
          <>
            <button className={btnSm} onClick={() => void inv('open', { path: g.file })} title="Open">
              <ExternalLink size={12} />
            </button>
            <button className={btnSm} onClick={() => void inv('open', { path: g.file, reveal: true })} title="Show in folder">
              <FolderOpen size={12} />
            </button>
            <button className={btnSm} disabled={scoring} onClick={() => void score()} title="Score this thumbnail">
              {scoring ? <LoaderCircle size={12} className="animate-spin" /> : <Gauge size={12} />}
            </button>
            <button className={btnSm} onClick={() => s.recreateFrom({ path: g.file, label: g.fileName })} title="Use as the base for a recreate">
              <Sparkles size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------- page ---------------------------------- */

export default function Create(): React.JSX.Element {
  const s = useThumbs()
  const f = s.form
  const personas = s.library.filter((i) => i.kind === 'persona' && i.status === 'completed')
  const styles = s.library.filter((i) => i.kind === 'style' && i.status === 'completed')
  const training = s.library.filter((i) => i.status === 'processing').length
  const [busy, setBusy] = useState(false)

  const restriction = (m: Model): string | null => modelRestriction(m, { persona: !!f.personaId, style: !!f.styleId, recreateWithPrompt: f.mode === 'image' && !!f.prompt.trim(), imageWeight: f.mode === 'image' && f.model === 'pkz_2' && !!f.imageWeight && m !== 'pkz_2' ? false : false })

  // keep the model valid as options change (persona/theme need PKZ 4+)
  useEffect(() => {
    const why = restriction(f.model)
    if (why) s.setForm({ model: 'pkz_4_5' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.personaId, f.styleId, f.mode, f.prompt])

  const image = f.image ?? (f.imageUrlText.trim() ? { url: f.imageUrlText.trim() } : null)
  const problem = !s.hasKey
    ? 'Add your Pikzels API key in Settings → API Keys.'
    : f.mode === 'text' && !f.prompt.trim()
      ? 'Write a prompt.'
      : f.mode === 'image' && !image
        ? 'Add a YouTube link, image URL or image file.'
        : restriction(f.model)
  const running = s.job && !s.job.done

  const go = async (): Promise<void> => {
    if (problem || busy) return
    setBusy(true)
    await s.generate()
    setBusy(false)
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink">Create thumbnails</h1>
            <p className="text-sm text-muted">Results are saved to your Downloads automatically.</p>
          </div>
          <CostBadge />
        </div>

        {!s.hasKey && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">
            <TriangleAlert size={15} className="shrink-0 text-warn" />
            <span className="flex-1">
              No Pikzels API key yet — add it under <b>Settings → API Keys → Pikzels</b>, then come back.
            </span>
            <button className={btnSm} onClick={() => void s.refreshKey()}>
              Re-check
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className={`${card} space-y-4 p-5`}>
            <Segmented
              value={f.mode}
              options={[
                { id: 'text', label: 'From a prompt' },
                { id: 'image', label: 'Recreate from a video or image' }
              ]}
              onChange={(mode) => s.setForm({ mode })}
            />

            {f.mode === 'image' && (
              <div>
                <label className={label}>Source — a YouTube video link, an image URL, or a file</label>
                {f.image ? (
                  <ImageSlot value={f.image} onChange={(v) => s.setForm({ image: v, imageUrlText: '' })} placeholder="Choose the thumbnail to recreate" />
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[260px] flex-1">
                      <Youtube size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                      <input value={f.imageUrlText} onChange={(e) => s.setForm({ imageUrlText: e.target.value })} placeholder="https://www.youtube.com/watch?v=…  or an image URL" className={`${input} pl-8`} />
                    </div>
                    <span className="text-xs text-muted">or</span>
                    <button
                      className={btn}
                      onClick={async () => {
                        const r = (await inv('pick-images', { multi: false, title: 'Choose the thumbnail to recreate' })) as { images?: ImageRef[] }
                        if (r.images?.[0]) s.setForm({ image: r.images[0], imageUrlText: '' })
                      }}
                    >
                      <ImagePlus size={14} /> Choose file…
                    </button>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className={label}>{f.mode === 'text' ? 'Prompt' : 'What to change (optional — needs PKZ 4 or 4.5)'}</label>
              <textarea
                value={f.prompt}
                onChange={(e) => s.setForm({ prompt: e.target.value })}
                rows={f.mode === 'text' ? 4 : 2}
                placeholder={
                  f.mode === 'text'
                    ? 'e.g. Shocked trader pointing at a huge green candle on a futures chart, bold text "I MADE $600 TODAY", dramatic lighting'
                    : 'e.g. Same layout but with my face, red background, text "LIVE"'
                }
                className={`${input} resize-y leading-relaxed`}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={label}>
                  <UserRound size={11} className="mr-1 inline" /> Persona (your face)
                </label>
                <select value={f.personaId} onChange={(e) => s.setForm({ personaId: e.target.value })} className={input}>
                  <option value="">None</option>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {!personas.length && (
                  <p className="mt-1 text-[11px] text-muted">
                    {training ? `${training} still training…` : 'No personas yet — train one in Library.'}
                  </p>
                )}
              </div>
              <div>
                <label className={label}>
                  <Palette size={11} className="mr-1 inline" /> Theme (visual style)
                </label>
                <select value={f.styleId} onChange={(e) => s.setForm({ styleId: e.target.value })} className={input}>
                  <option value="">None</option>
                  {styles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {!styles.length && <p className="mt-1 text-[11px] text-muted">No themes yet — build one from your channel in Library.</p>}
              </div>
            </div>

            <div>
              <label className={label}>Model</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {MODELS.map((m) => {
                  const why = restriction(m.id)
                  const active = f.model === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!!why}
                      title={why ?? undefined}
                      onClick={() => s.setForm({ model: m.id, imageWeight: m.id === 'pkz_2' ? f.imageWeight : '' })}
                      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left ${active ? 'border-accent bg-accent/10' : why ? 'border-edge opacity-40' : 'border-edge bg-bg hover:border-accent/50'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-ink">{m.label}</div>
                        <div className="truncate text-[11px] text-muted">{why ?? m.blurb}</div>
                      </div>
                      <span className="shrink-0 text-xs tabular-nums text-muted">{s.settings.creditsPerModel[m.id]} cr</span>
                      {why && <Ban size={13} className="shrink-0 text-muted" />}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-[auto_auto_1fr]">
              <div>
                <label className={label}>Format</label>
                <Segmented value={f.format} options={FORMATS.map((x) => ({ id: x.id, label: x.label, hint: x.hint }))} onChange={(format) => s.setForm({ format })} />
              </div>
              <div>
                <label className={label}>How many</label>
                <div className="flex items-center gap-1 rounded-lg bg-raised p-1">
                  <button className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink" onClick={() => s.setForm({ count: Math.max(1, f.count - 1) })}>
                    <Minus size={14} />
                  </button>
                  <span className="w-8 text-center text-sm font-semibold tabular-nums text-ink">{f.count}</span>
                  <button className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink" onClick={() => s.setForm({ count: Math.min(10, f.count + 1) })}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              {f.mode === 'image' && f.model === 'pkz_2' && (
                <div>
                  <label className={label}>Image weight (how closely to follow the source)</label>
                  <Segmented
                    value={f.imageWeight || 'medium'}
                    options={[
                      { id: 'low', label: 'Low' },
                      { id: 'medium', label: 'Medium' },
                      { id: 'high', label: 'High' }
                    ]}
                    onChange={(w) => s.setForm({ imageWeight: w })}
                  />
                </div>
              )}
            </div>

            <div>
              <label className={label}>Reference image (optional — a layout or subject to borrow)</label>
              <ImageSlot value={f.support} onChange={(v) => s.setForm({ support: v })} placeholder="Choose a reference image" allowUrl />
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-4">
              <button className={`${btnAccent} px-5 py-2.5 text-base`} disabled={!!problem || busy || !!running} onClick={() => void go()}>
                {busy || running ? <LoaderCircle size={18} className="animate-spin" /> : <Sparkles size={18} />}
                {running ? 'Generating…' : `Generate ${f.count > 1 ? `${f.count} thumbnails` : 'thumbnail'}`}
              </button>
              {running && (
                <button className={btn} onClick={() => void s.cancel()}>
                  Cancel
                </button>
              )}
              {problem && s.hasKey && (
                <span className="flex items-center gap-1 text-xs text-warn">
                  <TriangleAlert size={12} /> {problem}
                </span>
              )}
              {f.personaId && <Pill tone="accent">persona: {personas.find((p) => p.id === f.personaId)?.name}</Pill>}
              {f.styleId && <Pill tone="accent">theme: {styles.find((p) => p.id === f.styleId)?.name}</Pill>}
            </div>
          </div>

          <div className="space-y-3">
            <div className={`${card} p-4 text-xs text-muted`}>
              <div className="mb-1 text-sm font-semibold text-ink">Tips</div>
              <ul className="list-disc space-y-1 pl-4">
                <li>Personas and themes only work on PKZ 4 / 4.5 — other models grey out while one is selected.</li>
                <li>Paste any YouTube watch link to recreate that video's thumbnail; add a prompt to change it.</li>
                <li>Generate 3–5 variations and score them — the best usually isn't the first.</li>
                <li>Pikzels links expire after 24 h; the app has already saved each file for you.</li>
              </ul>
            </div>
            <button className={`${btn} w-full`} onClick={() => void inv('open', { folder: true })}>
              <FolderOpen size={14} /> Open the download folder
            </button>
          </div>
        </div>

        {s.job && (
          <div className="mt-5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">{s.job.done ? 'Results' : 'Generating…'}</span>
              <span className="text-xs text-muted">
                {s.job.items.filter((i) => i.status === 'done').length}/{s.job.items.length} done
                {s.job.items.some((i) => i.creditsUsed != null) && ` · ${s.job.items.reduce((a, i) => a + (i.creditsUsed ?? 0), 0)} credits used`}
              </span>
            </div>
            <div className={`grid gap-3 ${f.format === '9:16' ? 'grid-cols-3 md:grid-cols-5' : 'grid-cols-2 md:grid-cols-3'}`}>
              {s.job.items.map((g) => (
                <ResultCard key={g.id} g={g} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

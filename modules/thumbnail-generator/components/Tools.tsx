import { useState } from 'react'
import { Copy, Gauge, ImagePlus, LoaderCircle, Paintbrush, Type, X } from 'lucide-react'
import { inv, useThumbs } from '../store'
import type { Format, Generated, ImageRef, Score, TitleResult } from '../types'
import { FORMATS } from '../lib/models'
import { btn, btnAccent, btnSm, card, input, label, Segmented, Thumb } from './ui'

function Slot({ value, onChange, title }: { value: ImageRef | null; onChange: (v: ImageRef | null) => void; title: string }): React.JSX.Element {
  const pick = async (): Promise<void> => {
    const r = (await inv('pick-images', { multi: false, title })) as { images?: ImageRef[] }
    if (r.images?.[0]) onChange(r.images[0])
  }
  return value ? (
    <div className="flex items-center gap-3 rounded-lg border border-edge bg-bg p-2">
      <Thumb path={value.path} url={value.url} className="w-24 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-xs text-muted">{value.label ?? value.url ?? value.path}</span>
      <button className={btnSm} onClick={() => onChange(null)}>
        <X size={12} />
      </button>
    </div>
  ) : (
    <button className={btn} onClick={() => void pick()}>
      <ImagePlus size={14} /> {title}
    </button>
  )
}

function ScoreTool(): React.JSX.Element {
  const s = useThumbs()
  const [image, setImage] = useState<ImageRef | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [score, setScore] = useState<Score | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('score', { image, title })) as { ok: boolean; error?: string; score?: Score }
    setBusy(false)
    if (!r.ok) return s.showToast('err', r.error ?? 'Could not score')
    setScore(r.score ?? null)
  }
  return (
    <section className={`${card} p-5`}>
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Gauge size={16} className="text-accent" /> Score a thumbnail
      </div>
      <p className="mb-3 text-xs text-muted">Pikzels rates click-worthiness out of 10 with sub-scores and a suggestion. ≈ {s.settings.creditsScore} credits.</p>
      <div className="space-y-3">
        <Slot value={image} onChange={setImage} title="Choose a thumbnail" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Video title (optional — scored together)" className={input} />
        <button className={btnAccent} disabled={busy || !image || !s.hasKey} onClick={() => void run()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Gauge size={14} />} Score
        </button>
        {score && (
          <div className="rounded-lg border border-edge bg-bg p-3">
            <div className="text-2xl font-bold text-ink">
              {score.main}
              <span className="text-sm font-normal text-muted">/10</span>
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(score.subscores).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <span className="w-28 capitalize text-muted">{k.replace(/_/g, ' ')}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, v * 10))}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums text-ink">{v}</span>
                </div>
              ))}
            </div>
            {score.suggestion && <p className="mt-2 text-xs text-ink">{score.suggestion}</p>}
          </div>
        )}
      </div>
    </section>
  )
}

function TitleTool(): React.JSX.Element {
  const s = useThumbs()
  const [prompt, setPrompt] = useState('')
  const [image, setImage] = useState<ImageRef | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<TitleResult | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('titles', { prompt, image })) as { ok: boolean; error?: string; result?: TitleResult }
    setBusy(false)
    if (!r.ok) return s.showToast('err', r.error ?? 'Could not generate titles')
    setRes(r.result ?? null)
  }
  return (
    <section className={`${card} p-5`}>
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Type size={16} className="text-accent" /> Title ideas
      </div>
      <p className="mb-3 text-xs text-muted">From a topic, a thumbnail, or both. ≈ {s.settings.creditsTitle} credits.</p>
      <div className="space-y-3">
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What's the video about?" className={input} />
        <Slot value={image} onChange={setImage} title="Add a thumbnail (optional)" />
        <button className={btnAccent} disabled={busy || (!prompt.trim() && !image) || !s.hasKey} onClick={() => void run()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Type size={14} />} Suggest titles
        </button>
        {res && (
          <div className="space-y-1">
            {res.outputs.map((t, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink">
                <span className="flex-1">{t}</span>
                <button
                  className={btnSm}
                  onClick={() => {
                    void navigator.clipboard.writeText(t)
                    s.showToast('ok', 'Copied')
                  }}
                >
                  <Copy size={12} />
                </button>
              </div>
            ))}
            {res.reasoning && <p className="text-xs text-muted">{res.reasoning}</p>}
          </div>
        )}
      </div>
    </section>
  )
}

function EditTool(): React.JSX.Element {
  const s = useThumbs()
  const [image, setImage] = useState<ImageRef | null>(null)
  const [mask, setMask] = useState<ImageRef | null>(null)
  const [support, setSupport] = useState<ImageRef | null>(null)
  const [prompt, setPrompt] = useState('')
  const [format, setFormat] = useState<Format>('16:9')
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState<Generated | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('edit', { prompt, image, mask, support, format })) as { ok: boolean; error?: string; item?: Generated }
    setBusy(false)
    if (!r.ok) return s.showToast('err', r.error ?? 'Edit failed')
    setOut(r.item ?? null)
    s.showToast('ok', `Saved ${r.item?.fileName}`)
    void s.loadHistory()
  }
  return (
    <section className={`${card} p-5 lg:col-span-2`}>
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Paintbrush size={16} className="text-accent" /> Edit a thumbnail
      </div>
      <p className="mb-3 text-xs text-muted">Describe the change. Add a mask image (white = area to change) to limit it. ≈ {s.settings.creditsEdit} credits. Saved to Downloads like everything else.</p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className={label}>Image to edit</label>
            <Slot value={image} onChange={setImage} title="Choose the thumbnail" />
          </div>
          <div>
            <label className={label}>Change</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder='e.g. Replace the text with "SOLD OUT" and make the background blue' className={`${input} resize-y`} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className={label}>Mask (optional)</label>
              <Slot value={mask} onChange={setMask} title="Choose a mask" />
            </div>
            <div>
              <label className={label}>Reference (optional)</label>
              <Slot value={support} onChange={setSupport} title="Choose a reference" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Segmented value={format} options={FORMATS.map((x) => ({ id: x.id, label: x.label, hint: x.hint }))} onChange={setFormat} />
            <button className={btnAccent} disabled={busy || !image || !prompt.trim() || !s.hasKey} onClick={() => void run()}>
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Paintbrush size={14} />} Apply edit
            </button>
          </div>
        </div>
        <div>
          {out ? (
            <div>
              <Thumb path={out.file} aspect={format === '9:16' ? '9/16' : format === '1:1' ? '1/1' : '16/9'} />
              <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                <span className="flex-1 truncate">{out.fileName}</span>
                <button className={btnSm} onClick={() => void inv('open', { path: out.file, reveal: true })}>
                  Show in folder
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[160px] items-center justify-center rounded-lg border border-dashed border-edge text-xs text-muted">The edited image appears here</div>
          )}
        </div>
      </div>
    </section>
  )
}

export default function Tools(): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl p-6">
        <h1 className="text-xl font-bold text-ink">Tools</h1>
        <p className="mb-4 text-sm text-muted">Everything else the Pikzels API can do.</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ScoreTool />
          <TitleTool />
          <EditTool />
        </div>
      </div>
    </div>
  )
}

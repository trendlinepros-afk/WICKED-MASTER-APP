import { useEffect, useState } from 'react'
import { Check, Download, ImagePlus, LoaderCircle, Palette, Pencil, Plus, RefreshCw, Sparkles, Trash2, TriangleAlert, UserRound, Youtube } from 'lucide-react'
import { inv, useThumbs } from '../store'
import type { ImageRef, LibraryItem, LibraryKind, YtLookup } from '../types'
import { btn, btnAccent, btnDanger, btnSm, card, fmtAgo, input, label, Modal, Pill, Thumb } from './ui'

const kindLabel = (k: LibraryKind): string => (k === 'persona' ? 'persona' : 'theme')

/* --------------------------------- trainer --------------------------------- */

function Trainer({ kind, onClose }: { kind: LibraryKind; onClose: () => void }): React.JSX.Element {
  const s = useThumbs()
  const [name, setName] = useState('')
  const [source, setSource] = useState<'files' | 'youtube'>(kind === 'persona' ? 'files' : 'youtube')
  const [pool, setPool] = useState<ImageRef[]>([])
  const [picked, setPicked] = useState<ImageRef[]>([])
  const [yt, setYt] = useState('')
  const [ytBusy, setYtBusy] = useState(false)
  const [ytLabel, setYtLabel] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const credits = kind === 'persona' ? s.settings.creditsPersona : s.settings.creditsStyle
  const key = (r: ImageRef): string => r.path ?? r.url ?? ''
  const isPicked = (r: ImageRef): boolean => picked.some((p) => key(p) === key(r))
  const toggle = (r: ImageRef): void => {
    if (isPicked(r)) setPicked(picked.filter((p) => key(p) !== key(r)))
    else if (picked.length < 3) setPicked([...picked, r])
  }

  const addFiles = async (): Promise<void> => {
    const r = (await inv('pick-images', { multi: true, title: kind === 'persona' ? 'Choose 3 clear photos of your face' : 'Choose 3 thumbnails in the look you want' })) as { images?: ImageRef[]; error?: string }
    if (r.error) setError(r.error)
    const imgs = r.images ?? []
    setPool((cur) => [...cur, ...imgs.filter((i) => !cur.some((c) => key(c) === key(i)))])
    // auto-pick up to 3 of what was just added
    setPicked((cur) => {
      const next = [...cur]
      for (const i of imgs) if (next.length < 3 && !next.some((c) => key(c) === key(i))) next.push(i)
      return next
    })
  }

  const fetchYt = async (): Promise<void> => {
    if (!yt.trim()) return
    setYtBusy(true)
    setError('')
    const r = (await inv('youtube', { url: yt.trim() })) as { ok: boolean; error?: string } & Partial<YtLookup>
    setYtBusy(false)
    if (!r.ok) return setError(r.error ?? 'Lookup failed')
    const imgs: ImageRef[] = (r.items ?? []).map((t) => ({ url: t.url, label: t.title || t.videoId, preview: t.url }))
    setYtLabel(`${r.kind === 'channel' ? 'Channel' : 'Video'} ${r.label ?? ''} — ${imgs.length} thumbnail${imgs.length === 1 ? '' : 's'}`)
    setPool(imgs)
    setPicked(imgs.slice(0, 3))
    // "@TheEmotionalTraderMindset" → "The Emotional Trader Mindset look"
    if (!name.trim() && r.kind === 'channel' && r.label) setName(`${r.label.replace(/^@/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ')} look`)
  }

  const train = async (): Promise<void> => {
    if (picked.length !== 3 || !name.trim() || busy) return
    setBusy(true)
    setError('')
    const r = (await inv('train', { kind, name: name.trim(), images: picked.map(({ path, url }) => ({ path, url })), specialInstructions: instructions, sourceUrl: source === 'youtube' ? yt.trim() : '' })) as { ok: boolean; error?: string; pikzelsName?: string }
    setBusy(false)
    if (!r.ok) return setError(r.error ?? 'Training failed to start')
    const renamed = r.pikzelsName ? ` Pikzels didn’t accept “${name.trim()}” as a name, so it’s “${r.pikzelsName}” on Pikzels (still “${name.trim()}” here).` : ''
    s.showToast('ok', `Training the ${kindLabel(kind)} — usually a few minutes. It will show as ready in Library.${renamed}`)
    onClose()
  }

  return (
    <Modal title={kind === 'persona' ? 'New persona — your face in thumbnails' : 'New theme — a repeatable look'} onClose={onClose} wide>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          <div>
            <label className={label}>Name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'persona' ? 'e.g. Matt — studio' : 'e.g. Trading channel look'} className={input} />
          </div>
          <div className="flex gap-1 rounded-lg bg-raised p-1">
            <button onClick={() => setSource('files')} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${source === 'files' ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
              <ImagePlus size={14} /> From my images
            </button>
            <button onClick={() => setSource('youtube')} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${source === 'youtube' ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
              <Youtube size={14} /> From a YouTube channel / video
            </button>
          </div>
          {source === 'files' ? (
            <div>
              <button className={btn} onClick={() => void addFiles()}>
                <ImagePlus size={14} /> Add images…
              </button>
              <p className="mt-1 text-[11px] text-muted">
                {kind === 'persona' ? 'Three clear, well-lit photos of the same face from slightly different angles work best.' : 'Three thumbnails that share the look you want to reproduce — colours, text style, framing.'}
              </p>
            </div>
          ) : (
            <div>
              <div className="flex gap-2">
                <input value={yt} onChange={(e) => setYt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void fetchYt()} placeholder="youtube.com/@channel  or a video link" className={input} />
                <button className={btn} disabled={ytBusy || !yt.trim()} onClick={() => void fetchYt()}>
                  {ytBusy ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />} Fetch
                </button>
              </div>
              <p className="mt-1 text-[11px] text-muted">{ytLabel || 'Pulls the channel’s recent thumbnails (or the video’s) so you can pick three.'}</p>
            </div>
          )}
          {pool.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>Pick exactly 3</span>
                <span className={picked.length === 3 ? 'text-ok' : ''}>{picked.length}/3 selected</span>
              </div>
              <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                {pool.map((r) => {
                  const on = isPicked(r)
                  return (
                    <button key={key(r)} onClick={() => toggle(r)} className={`relative rounded-lg border-2 ${on ? 'border-accent' : 'border-transparent'} ${!on && picked.length >= 3 ? 'opacity-50' : ''}`} title={r.label}>
                      <Thumb path={r.path} url={r.preview ?? r.url} aspect={kind === 'persona' && r.path ? '1/1' : '16/9'} />
                      {on && (
                        <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-accent-ink">
                          <Check size={12} />
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div>
            <label className={label}>Special instructions (optional)</label>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} placeholder={kind === 'persona' ? 'e.g. Always keep the beard; no glasses' : 'e.g. Always use the yellow/black palette; big impact font'} className={`${input} resize-y`} />
          </div>
          {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        </div>
        <div className="space-y-3">
          <div className={`${card} p-3 text-xs text-muted`}>
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-ink">{kind === 'persona' ? <UserRound size={14} /> : <Palette size={14} />} What you get</div>
            {kind === 'persona'
              ? 'A trained likeness you can drop into any prompt or recreate. Pick it in Create → Persona.'
              : 'A trained visual identity — palette, typography, composition — applied to any prompt or recreate. Pick it in Create → Theme.'}
            <div className="mt-2 border-t border-edge pt-2">
              Training cost: <b className="text-ink">≈ {credits} credits</b> (Settings → Credits). Uses PKZ 4 / 4.5 only.
            </div>
          </div>
          <div className="space-y-1.5">
            {picked.map((r, i) => (
              <div key={key(r)} className="flex items-center gap-2 text-xs text-muted">
                <Thumb path={r.path} url={r.preview ?? r.url} aspect="16/9" className="w-16 shrink-0" />
                <span className="truncate">
                  {i + 1}. {r.label ?? key(r)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnAccent} disabled={busy || picked.length !== 3 || !name.trim()} onClick={() => void train()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />} Train {kindLabel(kind)} ({credits} cr)
        </button>
      </div>
    </Modal>
  )
}

/* ------------------------------ import existing ----------------------------- */

function ImportExisting({ onClose }: { onClose: () => void }): React.JSX.Element {
  const s = useThumbs()
  const [id, setId] = useState('')
  const [kind, setKind] = useState<LibraryKind>('persona')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('import-item', { id: id.trim(), kind, name })) as { ok: boolean; error?: string }
    setBusy(false)
    if (!r.ok) return setError(r.error ?? 'Not found')
    onClose()
    s.showToast('ok', 'Added to the library')
  }
  return (
    <Modal title="Add an existing persona / theme by id" onClose={onClose}>
      <p className="mb-3 text-sm text-muted">For something trained on another PC before it synced, or in the Pikzels web app. The id is checked with Pikzels.</p>
      <div className="space-y-3">
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Pikzels id" className={input} />
        <div className="flex gap-1 rounded-lg bg-raised p-1">
          {(['persona', 'style'] as LibraryKind[]).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize ${kind === k ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
              {kindLabel(k)}
            </button>
          ))}
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" className={input} />
        {error && <div className="text-sm text-danger">{error}</div>}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button className={btnAccent} disabled={busy || !id.trim()} onClick={() => void go()}>
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />} Add
        </button>
      </div>
    </Modal>
  )
}

/* ---------------------------------- card ---------------------------------- */

function LibPreview({ item, index }: { item: LibraryItem; index: number }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const file = item.previews[index]
    if (!file) return
    let alive = true
    void (inv('library-preview', { id: item.id, file }) as Promise<{ ok: boolean; dataUrl?: string }>).then((r) => alive && r.ok && setUrl(r.dataUrl ?? null))
    return () => {
      alive = false
    }
  }, [item.id, item.previews, index])
  return <Thumb url={url ?? undefined} aspect={item.kind === 'persona' ? '1/1' : '16/9'} />
}

function ItemCard({ item }: { item: LibraryItem }): React.JSX.Element {
  const s = useThumbs()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.specialInstructions)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(item.name)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = async (channel: string, args: Record<string, unknown>, okMsg?: string): Promise<boolean> => {
    setBusy(true)
    const r = (await inv(channel, { id: item.id, ...args })) as { ok: boolean; error?: string }
    setBusy(false)
    if (!r.ok) {
      s.showToast('err', r.error ?? 'Failed')
      return false
    }
    if (okMsg) s.showToast('ok', okMsg)
    await s.loadLibrary()
    return true
  }
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="grid grid-cols-3 gap-0.5 bg-black/20">
        {[0, 1, 2].map((i) => (
          <LibPreview key={i} item={item} index={i} />
        ))}
      </div>
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <div className="flex gap-1">
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={`${input} py-1`} onKeyDown={(e) => e.key === 'Enter' && void act('rename-item', { name }).then(() => setRenaming(false))} />
                <button className={btnSm} onClick={() => void act('rename-item', { name }).then(() => setRenaming(false))}>
                  <Check size={12} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold text-ink" title={item.pikzelsName ? `Named “${item.pikzelsName}” on Pikzels` : undefined}>
                  {item.name}
                </span>
                <button className="text-muted hover:text-ink" onClick={() => setRenaming(true)} title="Rename">
                  <Pencil size={11} />
                </button>
              </div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
              {item.status === 'completed' ? (
                <Pill tone="ok">ready</Pill>
              ) : item.status === 'failed' ? (
                <Pill tone="danger">failed</Pill>
              ) : (
                <Pill tone="warn">
                  <LoaderCircle size={10} className="animate-spin" /> training {item.progress ? `${item.progress}%` : ''}
                </Pill>
              )}
              <span>{fmtAgo(item.createdAt)}</span>
              {item.source === 'youtube' && <Youtube size={11} />}
            </div>
          </div>
          <button className={btnSm} disabled={item.status !== 'completed'} onClick={() => s.useInCreate(item)} title="Use in Create">
            <Sparkles size={12} /> Use
          </button>
        </div>
        {item.status === 'processing' && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-raised">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, item.progress)}%` }} />
          </div>
        )}
        {item.error && (
          <div className="mt-2 flex items-start gap-1 text-[11px] text-danger">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {item.error}
          </div>
        )}
        {editing ? (
          <div className="mt-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className={`${input} resize-y text-xs`} placeholder="Special instructions Pikzels applies every time" />
            <div className="mt-1 flex items-center gap-1">
              <button className={btnSm} disabled={busy} onClick={() => void act('set-instructions', { text }, 'Instructions saved').then((ok) => ok && setEditing(false))}>
                <Check size={12} /> Save
              </button>
              <button className={btnSm} onClick={() => setEditing(false)}>
                Cancel
              </button>
              {item.instructionHistory.length > 0 && (
                <select className="ml-auto max-w-[160px] rounded-md border border-edge bg-bg px-1 py-0.5 text-[11px] text-muted" value="" onChange={(e) => e.target.value && setText(item.instructionHistory[Number(e.target.value)].text)}>
                  <option value="">Restore older…</option>
                  {item.instructionHistory.map((h, i) => (
                    <option key={i} value={i}>
                      {fmtAgo(h.at)} — {h.text.slice(0, 40)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="mt-2 block w-full truncate text-left text-[11px] text-muted hover:text-ink" title="Edit special instructions">
            {item.specialInstructions ? `“${item.specialInstructions}”` : '+ special instructions'}
          </button>
        )}
        <div className="mt-2 flex items-center gap-1 border-t border-edge pt-2">
          <button className={btnSm} disabled={busy} onClick={() => void act('refresh-item', {})} title="Refresh status from Pikzels">
            <RefreshCw size={12} />
          </button>
          <span className="flex-1 truncate font-mono text-[10px] text-muted" title={item.id}>
            {item.id}
          </span>
          <button className={`${btnSm} text-danger`} onClick={() => setConfirm(true)} title="Delete">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {confirm && (
        <Modal title={`Delete ${kindLabel(item.kind)} “${item.name}”?`} onClose={() => setConfirm(false)}>
          <p className="text-sm text-muted">Removes it from your library on every PC and, unless you keep it, deletes it on Pikzels too (training credits are not refunded).</p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btn} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button className={btn} onClick={() => void act('delete-item', { keepOnPikzels: true }, 'Removed from library').then(() => setConfirm(false))}>
              Remove here only
            </button>
            <button className={btnDanger} onClick={() => void act('delete-item', {}, 'Deleted').then(() => setConfirm(false))}>
              <Trash2 size={14} /> Delete everywhere
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ---------------------------------- page ---------------------------------- */

export default function Library(): React.JSX.Element {
  const s = useThumbs()
  const [trainer, setTrainer] = useState<LibraryKind | null>(null)
  const [importing, setImporting] = useState(false)
  const section = (kind: LibraryKind, title: string, blurb: string, icon: React.ReactNode): React.JSX.Element => {
    const items = s.library.filter((i) => i.kind === kind)
    return (
      <section>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-accent">{icon}</span>
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <span className="text-xs text-muted">{items.length}</span>
          <button className={`${btnAccent} ml-auto`} disabled={!s.hasKey} onClick={() => setTrainer(kind)}>
            <Plus size={14} /> New {kindLabel(kind)}
          </button>
        </div>
        {items.length === 0 ? (
          <div className={`${card} p-6 text-center text-sm text-muted`}>{blurb}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((i) => (
              <ItemCard key={i.id} item={i} />
            ))}
          </div>
        )}
      </section>
    )
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-ink">Personas & themes</h1>
            <p className="text-sm text-muted">Trained on Pikzels, remembered here — and on every PC that syncs with WICKED.</p>
          </div>
          <button className={btn} onClick={() => setImporting(true)}>
            <Download size={14} /> Add existing by id
          </button>
        </div>
        {section('persona', 'Personas', 'No personas yet. Train one from three photos of your face — then any thumbnail can feature you.', <UserRound size={18} />)}
        {section('style', 'Themes', 'No themes yet. Paste your channel link (or three thumbnails you like) to build a repeatable look.', <Palette size={18} />)}
      </div>
      {trainer && <Trainer kind={trainer} onClose={() => setTrainer(null)} />}
      {importing && <ImportExisting onClose={() => setImporting(false)} />}
    </div>
  )
}

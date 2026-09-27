import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, Save, X } from 'lucide-react'
import { inv, useDocs } from '../store'
import type { DocRecord, FieldValue } from '../types'
import { btn, btnAccent, card, input, label, TypeIcon } from './ui'
import { FieldInput } from './fields'

interface Draft {
  name: string
  fields: Record<string, FieldValue>
  tags: string[]
  folder: string
}

/** Create / edit any record — the form is generated from the asset type's fields. */
export default function RecordEditor(): React.JSX.Element {
  const s = useDocs()
  const v = s.view
  const typeId = v.kind === 'edit' ? v.type : ''
  const editId = v.kind === 'edit' ? v.id : undefined
  const startFolder = v.kind === 'edit' ? (v.folder ?? '') : ''
  const t = s.types.find((x) => x.id === typeId)

  const [draft, setDraft] = useState<Draft | null>(null)
  const [names, setNames] = useState<Record<string, { name: string; type: string }>>({})
  const [folders, setFolders] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      if (editId) {
        const r = (await inv('record', { id: editId })) as { ok: boolean; record?: DocRecord; names?: Record<string, { name: string; type: string }>; error?: string }
        if (!alive) return
        if (!r.ok || !r.record) return setError(r.error ?? 'Could not load the record.')
        setDraft({ name: r.record.name, fields: { ...r.record.fields }, tags: r.record.tags, folder: r.record.folder })
        setNames(r.names ?? {})
      } else {
        const fields: Record<string, FieldValue> = {}
        for (const f of t?.fields ?? []) if (f.defaultValue !== undefined) fields[f.key] = f.defaultValue as FieldValue
        setDraft({ name: '', fields, tags: [], folder: startFolder })
      }
      const [fo, ta] = (await Promise.all([inv('folders', { type: typeId }), inv('tags')])) as [{ folders?: string[] }, { tags?: string[] }]
      if (!alive) return
      setFolders(fo.folders ?? [])
      setAllTags(ta.tags ?? [])
    })()
    return () => {
      alive = false
    }
  }, [editId, typeId, startFolder, t])

  const shortFields = useMemo(() => (t?.fields ?? []).filter((f) => !['markdown', 'textarea', 'relation'].includes(f.kind)), [t])
  const wideFields = useMemo(() => (t?.fields ?? []).filter((f) => ['markdown', 'textarea', 'relation'].includes(f.kind)), [t])

  if (!t) return <div className="p-6 text-sm text-danger">Unknown asset type.</div>
  if (!draft)
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted">
        {error ? <span className="text-danger">{error}</span> : <LoaderCircle size={15} className="animate-spin" />}
      </div>
    )

  const setField = (key: string, value: FieldValue): void => setDraft((d) => (d ? { ...d, fields: { ...d.fields, [key]: value } } : d))
  const addTag = (raw: string): void => {
    const tag = raw.trim().toLowerCase().replace(/,+$/, '')
    if (!tag) return
    setDraft((d) => (d && !d.tags.includes(tag) ? { ...d, tags: [...d.tags, tag] } : d))
    setTagText('')
  }

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError('')
    const rec = await s.saveRecord({ id: editId, type: t.id, name: draft.name, fields: draft.fields, tags: draft.tags, folder: draft.folder })
    setSaving(false)
    if (!rec) {
      setError(s.error || 'Could not save.')
      s.clearError()
      return
    }
    s.showToast('ok', editId ? 'Saved' : `${t.name} created`)
    s.go({ kind: 'record', id: rec.id })
  }
  const cancel = (): void => (editId ? s.go({ kind: 'record', id: editId }) : s.go({ kind: 'list', type: t.id }))

  const isDoc = t.id === 'document'
  const content = t.fields.find((f) => f.key === 'content' && f.kind === 'markdown')

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <TypeIcon name={t.icon} size={20} />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-ink">{editId ? `Edit ${t.name}` : `New ${t.name}`}</h1>
            <p className="text-xs text-muted">{t.description}</p>
          </div>
          <button className={btn} onClick={cancel}>
            <X size={14} /> Cancel
          </button>
          <button className={btnAccent} disabled={saving || !draft.name.trim()} onClick={() => void save()}>
            {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>

        {error && <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

        <div className={`${card} space-y-4 p-5`}>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className={isDoc ? '' : 'md:col-span-2'}>
              <label className={label}>
                {t.nameLabel} <span className="text-danger">*</span>
              </label>
              <input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${input} text-base font-medium`} />
            </div>
            {isDoc && (
              <div>
                <label className={label}>Folder</label>
                <input list="doc-folders" value={draft.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} placeholder="e.g. Onboarding/Laptops" className={input} />
                <datalist id="doc-folders">
                  {folders.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </div>
            )}
            {shortFields.map((f) => (
              <div key={f.key} className={f.kind === 'checkbox' ? 'flex items-end' : ''}>
                <label className={label}>
                  {f.label} {f.required && <span className="text-danger">*</span>}
                  {f.hint && f.kind !== 'checkbox' && <span className="ml-1 font-normal text-muted/70">— {f.hint}</span>}
                </label>
                <FieldInput field={f} value={draft.fields[f.key]} onChange={(val) => setField(f.key, val)} names={names} types={s.types} onNames={setNames} excludeId={editId} />
              </div>
            ))}
          </div>

          {wideFields
            .filter((f) => f !== content)
            .map((f) => (
              <div key={f.key}>
                <label className={label}>
                  {f.label} {f.required && <span className="text-danger">*</span>}
                  {f.hint && <span className="ml-1 font-normal text-muted/70">— {f.hint}</span>}
                </label>
                <FieldInput field={f} value={draft.fields[f.key]} onChange={(val) => setField(f.key, val)} names={names} types={s.types} onNames={setNames} excludeId={editId} />
              </div>
            ))}

          <div>
            <label className={label}>Tags</label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-edge bg-bg px-2 py-1.5">
              {draft.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-0.5 text-xs text-ink">
                  {tag}
                  <button type="button" onClick={() => setDraft({ ...draft, tags: draft.tags.filter((x) => x !== tag) })} className="text-muted hover:text-danger">
                    <X size={11} />
                  </button>
                </span>
              ))}
              <input
                list="doc-tags"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addTag(tagText)
                  } else if (e.key === 'Backspace' && !tagText && draft.tags.length) setDraft({ ...draft, tags: draft.tags.slice(0, -1) })
                }}
                onBlur={() => addTag(tagText)}
                placeholder={draft.tags.length ? '' : 'Add tags (Enter or comma)'}
                className="min-w-[140px] flex-1 bg-transparent py-0.5 text-sm text-ink placeholder:text-muted/60 focus:outline-none"
              />
              <datalist id="doc-tags">
                {allTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </div>
          </div>
        </div>

        {content && (
          <div className="mt-4">
            <FieldInput field={content} value={draft.fields[content.key]} onChange={(val) => setField(content.key, val)} names={names} types={s.types} onNames={setNames} excludeId={editId} />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button className={btn} onClick={cancel}>
            Cancel
          </button>
          <button className={btnAccent} disabled={saving || !draft.name.trim()} onClick={() => void save()}>
            {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />} Save {t.name.toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  )
}

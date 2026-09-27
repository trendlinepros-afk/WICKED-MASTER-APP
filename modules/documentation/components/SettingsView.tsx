import { useState } from 'react'
import { ArrowDown, ArrowUp, Download, GripVertical, LoaderCircle, Lock, Plus, Settings, Trash2, X } from 'lucide-react'
import { inv, useDocs } from '../store'
import type { AssetType, FieldDef, FieldKind } from '../types'
import { FIELD_KINDS, SECTIONS, TYPE_ICONS } from '../lib/schema'
import { btn, btnAccent, btnDanger, btnSm, card, input, inputSm, label, Modal, strengthOf, Toggle, TypeIcon } from './ui'

type Tab = 'types' | 'security' | 'sidebar' | 'data'

/* ------------------------------ type designer ------------------------------ */

function TypeEditor({ initial, onClose }: { initial: AssetType | null; onClose: (saved: boolean) => void }): React.JSX.Element {
  const s = useDocs()
  const [t, setT] = useState<AssetType>(
    initial ?? { id: '', name: '', namePlural: '', icon: 'FileText', section: 'apps', fields: [{ key: '', label: 'Notes', kind: 'markdown' }], builtin: false, sortOrder: 100, description: '', nameLabel: 'Name', archived: false }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const setField = (i: number, patch: Partial<FieldDef>): void => setT({ ...t, fields: t.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  const move = (i: number, dir: -1 | 1): void => {
    const j = i + dir
    if (j < 0 || j >= t.fields.length) return
    const fields = [...t.fields]
    ;[fields[i], fields[j]] = [fields[j], fields[i]]
    setT({ ...t, fields })
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = (await inv('type-save', t)) as { ok: boolean; error?: string }
    setBusy(false)
    if (!r.ok) return setError(r.error ?? 'Could not save.')
    await s.loadTypes()
    onClose(true)
  }
  const del = async (): Promise<void> => {
    const r = (await inv('type-delete', { id: t.id })) as { ok: boolean; error?: string; removed?: number }
    if (!r.ok) return setError(r.error ?? 'Could not delete.')
    await s.loadTypes()
    s.showToast('ok', `Deleted ${t.name}${r.removed ? ` and ${r.removed} record(s)` : ''}`)
    onClose(true)
  }
  const count = initial ? (s.counts.byType[initial.id] ?? 0) : 0

  return (
    <Modal title={initial ? `Edit asset type — ${initial.name}` : 'New asset type'} onClose={() => onClose(false)} wide>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className={label}>Name (singular)</label>
          <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value, namePlural: t.namePlural || '' })} placeholder="e.g. Firewall rule" className={input} />
        </div>
        <div>
          <label className={label}>Plural (sidebar label)</label>
          <input value={t.namePlural} onChange={(e) => setT({ ...t, namePlural: e.target.value })} placeholder={t.name ? `${t.name}s` : ''} className={input} />
        </div>
        <div>
          <label className={label}>Sidebar section</label>
          <select value={t.section} onChange={(e) => setT({ ...t, section: e.target.value as AssetType['section'] })} disabled={t.builtin && t.section === 'core'} className={input}>
            {SECTIONS.map((sec) => (
              <option key={sec.id} value={sec.id}>
                {sec.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Label for the name field</label>
          <input value={t.nameLabel} onChange={(e) => setT({ ...t, nameLabel: e.target.value })} className={input} />
        </div>
        <div className="md:col-span-2">
          <label className={label}>Description</label>
          <input value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} className={input} />
        </div>
        <div className="md:col-span-2">
          <label className={label}>Icon</label>
          <div className="flex flex-wrap gap-1">
            {TYPE_ICONS.map((ic) => (
              <button key={ic} type="button" onClick={() => setT({ ...t, icon: ic })} className={`rounded-md p-1.5 ${t.icon === ic ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-raised hover:text-ink'}`} title={ic}>
                <TypeIcon name={ic} size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <label className={label}>Fields</label>
          <button className={btnSm} onClick={() => setT({ ...t, fields: [...t.fields, { key: '', label: '', kind: 'text' }] })}>
            <Plus size={12} /> Add field
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-edge">
          <div className="grid grid-cols-[20px_1fr_150px_1fr_auto] items-center gap-2 border-b border-edge bg-raised/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            <span />
            <span>Label</span>
            <span>Kind</span>
            <span>Options / links to</span>
            <span className="w-[164px]">List · Req · Expiry</span>
          </div>
          {t.fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[20px_1fr_150px_1fr_auto] items-center gap-2 border-b border-edge/60 px-2 py-1.5 last:border-0">
              <div className="flex flex-col text-muted">
                <button onClick={() => move(i, -1)} className="hover:text-ink" title="Up">
                  <ArrowUp size={10} />
                </button>
                <button onClick={() => move(i, 1)} className="hover:text-ink" title="Down">
                  <ArrowDown size={10} />
                </button>
              </div>
              <input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Label" className={`${inputSm} w-full`} />
              <select value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as FieldKind })} disabled={!!f.builtin} className={`${inputSm} w-full`}>
                {FIELD_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
              {f.kind === 'select' ? (
                <input value={(f.options ?? []).join(', ')} onChange={(e) => setField(i, { options: e.target.value.split(',').map((x) => x.trim()) })} placeholder="Option A, Option B" className={`${inputSm} w-full`} />
              ) : f.kind === 'relation' ? (
                <select value={f.relationType ?? ''} onChange={(e) => setField(i, { relationType: e.target.value })} disabled={!!f.builtin} className={`${inputSm} w-full`}>
                  <option value="">— pick a type —</option>
                  {s.types.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.namePlural}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={f.hint ?? ''} onChange={(e) => setField(i, { hint: e.target.value })} placeholder="Hint (optional)" className={`${inputSm} w-full`} />
              )}
              <div className="flex w-[164px] items-center gap-3 text-xs text-muted">
                <input type="checkbox" checked={!!f.showInList} onChange={(e) => setField(i, { showInList: e.target.checked })} title="Show as a list column" />
                <input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} title="Required" />
                <input type="checkbox" checked={!!f.expires} disabled={f.kind !== 'date'} onChange={(e) => setField(i, { expires: e.target.checked })} title="Counts as an expiry (dates only)" />
                {f.builtin ? (
                  <Lock size={12} className="ml-auto" aria-label="Built-in field" />
                ) : (
                  <button onClick={() => setT({ ...t, fields: t.fields.filter((_x, j) => j !== i) })} className="ml-auto hover:text-danger" title="Remove field">
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-muted">
          <GripVertical size={10} className="inline" /> Built-in fields (lock icon) can be relabelled and reordered but not removed. Field keys are generated from the label the first time.
        </p>
      </div>

      {error && <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
      <div className="mt-5 flex items-center gap-2">
        {initial && !initial.builtin && (
          <button className={`${btn} text-danger`} onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> Delete type
          </button>
        )}
        <span className="flex-1" />
        <button className={btn} onClick={() => onClose(false)}>
          Cancel
        </button>
        <button className={btnAccent} disabled={busy || !t.name.trim()} onClick={() => void save()}>
          {busy && <LoaderCircle size={14} className="animate-spin" />} Save type
        </button>
      </div>
      {confirmDelete && (
        <Modal title={`Delete “${t.name}”?`} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-muted">
            {count ? `This also permanently deletes its ${count} record${count === 1 ? '' : 's'} and their attachments.` : 'This asset type has no records.'} It cannot be undone.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btn} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button className={btnDanger} onClick={() => void del()}>
              <Trash2 size={14} /> Delete {count ? `type + ${count} records` : 'type'}
            </button>
          </div>
        </Modal>
      )}
    </Modal>
  )
}

/* --------------------------------- security -------------------------------- */

function Security(): React.JSX.Element {
  const s = useDocs()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const strength = strengthOf(next)
  const change = async (): Promise<void> => {
    if (next.length < 4 || next !== confirm || busy) return
    setBusy(true)
    const err = await s.changePassword(cur, next)
    setBusy(false)
    setMsg(err ? { ok: false, text: err } : { ok: true, text: 'Password changed. Stored secrets were re-keyed automatically.' })
    if (!err) {
      setCur('')
      setNext('')
      setConfirm('')
    }
  }
  return (
    <div className="space-y-4">
      <section className={`${card} p-5`}>
        <h3 className="text-sm font-semibold text-ink">Change password</h3>
        <p className="mb-3 text-xs text-muted">Your data stays as it is — only the key that unlocks it is re-wrapped with the new password.</p>
        <div className="grid max-w-md gap-2">
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current password" autoComplete="off" className={input} />
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (4+ characters)" autoComplete="off" className={input} />
          {next && <div className={`text-xs ${strength.score <= 1 ? 'text-danger' : strength.score === 2 ? 'text-warn' : 'text-ok'}`}>{strength.label}</div>}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && void change()} className={input} />
          {msg && <div className={`text-xs ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</div>}
          <div>
            <button className={btnAccent} disabled={busy || !cur || next.length < 4 || next !== confirm} onClick={() => void change()}>
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Lock size={14} />} Change password
            </button>
          </div>
        </div>
      </section>
      <section className={`${card} p-5`}>
        <h3 className="text-sm font-semibold text-ink">Locking</h3>
        <div className="mt-3 grid max-w-md gap-3">
          <label className="flex items-center justify-between gap-3 text-sm text-ink">
            <span>
              Lock automatically after
              <span className="block text-xs text-muted">Counts from your last click or keystroke in Documentation. Always locks when WICKED restarts.</span>
            </span>
            <select value={s.settings.autoLockMinutes} onChange={(e) => void s.saveSettings({ autoLockMinutes: Number(e.target.value) })} className={inputSm}>
              <option value={1}>1 minute</option>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={0}>Never</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-3 text-sm text-ink">
            <span>
              Clear the clipboard after copying a secret
              <span className="block text-xs text-muted">Only if the clipboard still holds that secret.</span>
            </span>
            <select value={s.settings.clipboardClearSeconds} onChange={(e) => void s.saveSettings({ clipboardClearSeconds: Number(e.target.value) })} className={inputSm}>
              <option value={15}>15 seconds</option>
              <option value={45}>45 seconds</option>
              <option value={90}>90 seconds</option>
              <option value={0}>Never</option>
            </select>
          </label>
          <div>
            <button className={btn} onClick={() => void s.lock()}>
              <Lock size={14} /> Lock now
            </button>
          </div>
        </div>
      </section>
      <section className={`${card} p-5 text-xs text-muted`}>
        <h3 className="mb-1 text-sm font-semibold text-ink">How your data is protected</h3>
        <ul className="list-disc space-y-1 pl-4">
          <li>Passwords, one-time-code secrets and licence keys are encrypted (AES-256-GCM) with a key that only your password unlocks. Names, notes, IPs and other fields are stored as plain text so they stay searchable.</li>
          <li>Secrets never leave the app except when you press Reveal or Copy — and each of those is written to the activity log.</li>
          <li>The lock is not tied to this PC: restore a WICKED backup on another machine and the same password opens it. That also means someone with a copy of your files can try passwords offline — a short PIN is guessable, a passphrase is not.</li>
          <li>There is no password reset. Without the password, the encrypted fields are unrecoverable (everything else stays readable).</li>
        </ul>
      </section>
    </div>
  )
}

/* -------------------------------- sidebar tab ------------------------------- */

function SidebarSettings(): React.JSX.Element {
  const s = useDocs()
  const hidden = new Set(s.settings.hiddenTypes)
  const toggle = (id: string): void => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    void s.saveSettings({ hiddenTypes: [...next] })
  }
  return (
    <section className={`${card} p-5`}>
      <h3 className="text-sm font-semibold text-ink">Customize sidebar</h3>
      <p className="mb-3 text-xs text-muted">Hide the asset types you don’t use. Hidden types keep their records and still show up in search.</p>
      {SECTIONS.map((sec) => (
        <div key={sec.id} className="mb-3">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{sec.label}</div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {s.types
              .filter((t) => t.section === sec.id && !t.archived)
              .map((t) => (
                <label key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-raised">
                  <Toggle on={!hidden.has(t.id)} onChange={() => toggle(t.id)} />
                  <TypeIcon name={t.icon} size={14} className="text-muted" />
                  <span className="min-w-0 flex-1 truncate">{t.namePlural}</span>
                  <span className="text-[10px] text-muted">{s.counts.byType[t.id] ?? 0}</span>
                </label>
              ))}
          </div>
        </div>
      ))}
    </section>
  )
}

/* ---------------------------------- data tab ---------------------------------- */

function DataTab(): React.JSX.Element {
  const s = useDocs()
  const [busy, setBusy] = useState(false)
  const [withSecrets, setWithSecrets] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = (await inv('export', { includeSecrets: withSecrets })) as { ok: boolean; cancelled?: boolean; error?: string; records?: number }
    setBusy(false)
    if (r.ok) s.showToast('ok', `Exported ${r.records} records`)
    else if (!r.cancelled) s.showToast('err', r.error ?? 'Export failed')
  }
  return (
    <section className={`${card} p-5`}>
      <h3 className="text-sm font-semibold text-ink">Export</h3>
      <p className="mb-3 text-xs text-muted">Everything as one JSON file (asset types, records, relations). Attachments stay in the module’s attachments folder.</p>
      <label className="mb-3 flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} className="mt-1" />
        <span>
          Include secrets in plain text
          <span className="block text-xs text-warn">The file will contain every password unencrypted. Store it somewhere safe and delete it when done.</span>
        </span>
      </label>
      <button className={btnAccent} disabled={busy} onClick={() => void run()}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />} Export JSON…
      </button>
      <p className="mt-4 text-xs text-muted">File locations are listed under Settings → Modules → Documentation. The database and lock file are included in WICKED Backup / Cloud Sync.</p>
    </section>
  )
}

/* ---------------------------------- page ---------------------------------- */

export default function SettingsView(): React.JSX.Element {
  const s = useDocs()
  const tab: Tab = s.view.kind === 'settings' ? s.view.tab : 'types'
  const [editing, setEditing] = useState<AssetType | null | 'new'>(null)
  const tabs: { id: Tab; label: string }[] = [
    { id: 'types', label: 'Asset types' },
    { id: 'security', label: 'Security' },
    { id: 'sidebar', label: 'Sidebar' },
    { id: 'data', label: 'Export' }
  ]
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <div className="mb-4 flex items-center gap-3">
          <Settings size={20} className="text-accent" />
          <h1 className="text-xl font-bold text-ink">Settings</h1>
        </div>
        <div className="mb-4 flex gap-1 rounded-lg bg-raised p-1">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => s.go({ kind: 'settings', tab: t.id })} className={`flex-1 rounded-md px-3 py-1.5 text-sm ${tab === t.id ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'types' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">Every sidebar item is an asset type with its own fields. Edit the built-in ones or design your own — like IT Glue’s flexible assets.</p>
              <button className={btnAccent} onClick={() => setEditing('new')}>
                <Plus size={14} /> New asset type
              </button>
            </div>
            {SECTIONS.map((sec) => (
              <div key={sec.id} className={card}>
                <div className="border-b border-edge px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{sec.label}</div>
                {s.types
                  .filter((t) => t.section === sec.id)
                  .map((t) => (
                    <button key={t.id} onClick={() => setEditing(t)} className="flex w-full items-center gap-3 border-b border-edge/60 px-4 py-2.5 text-left hover:bg-raised/60 last:border-0">
                      <TypeIcon name={t.icon} size={16} className="text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-ink">
                          {t.namePlural} {t.builtin && <span className="ml-1 text-[10px] font-normal text-muted">built-in</span>}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {t.fields.length} fields · {t.fields.map((f) => f.label).slice(0, 6).join(', ')}
                          {t.fields.length > 6 ? '…' : ''}
                        </div>
                      </div>
                      <span className="text-xs text-muted">{s.counts.byType[t.id] ?? 0} records</span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}
        {tab === 'security' && <Security />}
        {tab === 'sidebar' && <SidebarSettings />}
        {tab === 'data' && <DataTab />}
      </div>
      {editing && <TypeEditor initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

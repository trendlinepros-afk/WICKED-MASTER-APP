import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useSettings } from '@/stores/settings'
import { useShellUi } from '@/stores/shellUi'
import { moduleById } from './registry'

/** Edit a module's display name + short description (persisted as an override). */
export default function EditModuleModal(): React.JSX.Element | null {
  const editing = useShellUi((s) => s.editing)
  const closeEdit = useShellUi((s) => s.closeEdit)
  const overrides = useSettings((s) => s.settings.moduleOverrides)
  const update = useSettings((s) => s.update)

  const mod = editing ? moduleById(editing) : undefined
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (!mod) return
    const ov = overrides[mod.manifest.id] ?? {}
    setName(ov.name ?? mod.manifest.name)
    setDescription(ov.description ?? mod.manifest.description)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  if (!editing || !mod) return null
  const id = mod.manifest.id

  const save = (): void => {
    const next = { ...overrides }
    const ov: { name?: string; description?: string } = {}
    if (name.trim() && name.trim() !== mod.manifest.name) ov.name = name.trim()
    if (description.trim() && description.trim() !== mod.manifest.description)
      ov.description = description.trim()
    if (ov.name || ov.description) next[id] = ov
    else delete next[id]
    update({ moduleOverrides: next })
    closeEdit()
  }

  const reset = (): void => {
    const next = { ...overrides }
    delete next[id]
    update({ moduleOverrides: next })
    closeEdit()
  }

  const hasOverride = Boolean(overrides[id])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeEdit()
      }}
    >
      <div className="w-[440px] max-w-full rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <h3 className="text-base font-semibold">Edit “{mod.manifest.name}”</h3>
        <p className="mt-1 text-xs text-muted">
          Rename this app and change the description shown on its card. This only changes how it
          appears — the app itself is unchanged.
        </p>

        <label className="mt-4 block text-xs font-medium text-muted">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <label className="mt-3 block text-xs font-medium text-muted">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mt-1 w-full resize-none rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            onClick={reset}
            disabled={!hasOverride}
            className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised disabled:opacity-40"
          >
            <RotateCcw size={14} />
            Reset to default
          </button>
          <div className="flex gap-2">
            <button
              onClick={closeEdit}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

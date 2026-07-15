import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * In-app "New Project" dialog. Electron does not support window.prompt(), so we
 * use this modal to collect the project name. On save it calls createProject,
 * which creates `<projectsRootPath>/<name>` and makes it the active project.
 * If the projects folder isn't configured yet, we point the user to Settings.
 */
export function NewProjectModal(): JSX.Element | null {
  const open = useStore((s) => s.newProjectOpen)
  const setOpen = useStore((s) => s.setNewProjectOpen)
  const config = useStore((s) => s.config)
  const createProject = useStore((s) => s.createProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset and focus each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
      setBusy(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const projectsRoot = config?.projectsRootPath ?? ''
  const rootSet = projectsRoot.trim().length > 0
  // Sanitize for the on-screen path preview (mirrors the main-process rules).
  const safeName = name.replace(/[<>:"/\\|?* -]/g, '').trim()
  const sep = projectsRoot.includes('/') ? '/' : '\\'

  const close = (): void => setOpen(false)

  const create = async (): Promise<void> => {
    if (!safeName || busy) return
    setBusy(true)
    setError(null)
    try {
      await createProject(safeName)
      setOpen(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-[440px] rounded-lg border border-edge bg-raised p-5 shadow-xl">
        <h2 className="mb-3 text-lg font-semibold text-ink">New Project</h2>

        {!rootSet ? (
          <>
            <p className="mb-4 text-sm text-muted">
              Set a <b>Projects folder</b> in Settings first — that's where new
              projects are created.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                onClick={close}
              >
                Cancel
              </button>
              <button
                className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink hover:opacity-90"
                onClick={() => {
                  close()
                  setSettingsOpen(true)
                }}
              >
                Open Settings
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="block text-sm font-medium text-ink">
              Project name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
                if (e.key === 'Escape') close()
              }}
              placeholder="my-app"
              className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
            <p className="mt-2 break-all text-xs text-muted">
              Will create:{' '}
              <span className="text-ink">
                {projectsRoot}
                {sep}
                {safeName || '<name>'}
              </span>
            </p>
            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
                onClick={close}
              >
                Cancel
              </button>
              <button
                disabled={!safeName || busy}
                className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink hover:opacity-90 disabled:opacity-40"
                onClick={() => void create()}
              >
                {busy ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useStore, formatTime } from '../store'
import { api } from '../lib/api'
import { btn, btnDanger, btnPrimary, label, panel } from '../lib/ui'
import NewProjectModal from '../components/NewProjectModal'

export default function LibraryView() {
  const { projects, settings, refreshProjects, openProject, completeOnboarding } = useStore()
  const [busy, setBusy] = useState<null | 'create' | 'open' | 'folder'>(null)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)

  // Create a new project from a name — makes a fresh folder inside
  // <master>/Projects and opens the editor, where footage is attached.
  async function createNamed(name: string) {
    setError(null)
    setBusy('create')
    try {
      const project = await api.createProject(name)
      await refreshProjects()
      await openProject(project.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
      setNaming(false)
    }
  }

  // Open an existing project the user picks manually (its project.json).
  async function openFromDisk() {
    setError(null)
    const filePath = await api.pickProjectFile()
    if (!filePath) return
    setBusy('open')
    try {
      const project = await api.importProject(filePath)
      await refreshProjects()
      await openProject(project.id)
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(null)
    }
  }

  async function changeFolder() {
    setError(null)
    const dir = await api.pickDirectory()
    if (!dir) return
    setBusy('folder')
    try {
      await completeOnboarding(dir)
      await refreshProjects()
    } catch (err: any) {
      setError(err?.message ?? "Couldn't use that folder — pick a different one.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto overflow-y-auto h-full">
      {/* Master folder + change */}
      <div className={`${panel} bg-raised p-4 mb-5 flex items-center gap-3`}>
        <div className="min-w-0 flex-1">
          <div className={`${label} mb-0.5`}>Projects folder</div>
          <div className="text-xs text-ink/80 font-mono truncate">
            {settings?.projectsDir ?? 'Default location (module data folder)'}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            Projects and Assets subfolders live here.
          </div>
        </div>
        <button className={`${btn} shrink-0`} onClick={changeFolder} disabled={busy !== null}>
          {busy === 'folder' ? 'Changing…' : 'Change Projects Folder'}
        </button>
      </div>

      {/* Primary actions */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold text-ink">Recent projects</h1>
        <div className="flex gap-2">
          <button className={btn} onClick={openFromDisk} disabled={busy !== null}>
            {busy === 'open' ? 'Opening…' : 'Open Project…'}
          </button>
          <button className={btnPrimary} onClick={() => setNaming(true)} disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : '＋ Create New Project'}
          </button>
        </div>
      </div>

      {error && <div className={`${panel} p-4 mb-4 border-danger/50 text-danger text-sm`}>{error}</div>}

      {projects.length === 0 ? (
        <div className={`${panel} p-12 text-center`}>
          <p className="text-muted mb-2">No projects yet.</p>
          <p className="text-sm text-muted">
            <b>Create New Project</b> to start from a source video, or <b>Open Project</b> to load an existing one.
            Your source video is linked in place and read-only — it is never copied or modified, and only the edited
            output is written to the project folder.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <div key={p.id} className={`${panel} p-4 flex items-center gap-4 hover:border-accent/50 transition-colors`}>
              <button className="flex-1 text-left min-w-0" onClick={() => openProject(p.id)}>
                <div className="font-medium text-ink truncate">{p.name}</div>
                <div className="text-xs text-muted mt-1 truncate">
                  {p.sourcePath ? (
                    <>
                      {formatTime(p.durationSec)} · {new Date(p.updatedAt).toLocaleString()} ·{' '}
                      <span className="font-mono">{p.sourcePath}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-warn">No source video yet</span> · {new Date(p.updatedAt).toLocaleString()}
                    </>
                  )}
                </div>
              </button>
              {p.approved && <span className="text-ok text-sm shrink-0">✓ approved</span>}
              <button
                className={`${btnDanger} text-xs shrink-0`}
                onClick={async () => {
                  if (confirm(`Delete project "${p.name}"? The source video is untouched.`)) {
                    await api.deleteProject(p.id)
                    refreshProjects()
                  }
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {naming && (
        <NewProjectModal busy={busy === 'create'} onCancel={() => setNaming(false)} onConfirm={createNamed} />
      )}
    </div>
  )
}

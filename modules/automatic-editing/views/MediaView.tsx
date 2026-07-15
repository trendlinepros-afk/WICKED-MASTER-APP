/**
 * Media pool (Media tab) — import multiple videos or whole folders via the
 * Import button; the folder structure is preserved. Files are referenced IN
 * PLACE — never copied or modified. "Import & Continue" moves to the editor,
 * where clips are numbered into an edit order.
 *
 * NOTE: OS drag-and-drop needs Electron webUtils.getPathForFile, which the
 * WICKED shell preload doesn't expose — dropping files shows a hint to use
 * the Import button instead.
 */
import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { btn, btnPrimary, panel } from '../lib/ui'
import MediaTree from '../components/MediaTree'
import { droppedPaths, DROP_UNAVAILABLE } from '../lib/dnd'

export default function MediaView() {
  const project = useStore((s) => s.project)
  const applyProjectPush = useStore((s) => s.applyProjectPush)
  const setView = useStore((s) => s.setView)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  if (!project) return null

  const media = project.media ?? []

  async function importPaths(paths: string[]) {
    if (!project || paths.length === 0) return
    setBusy(true)
    setError(null)
    try {
      applyProjectPush(await api.importMedia(project.id, paths))
    } catch (err: any) {
      setError(err?.message ?? 'Could not import that media.')
    } finally {
      setBusy(false)
    }
  }

  async function importFiles() {
    setMenuOpen(false)
    await importPaths(await api.pickMediaFiles())
  }

  async function importFolder() {
    setMenuOpen(false)
    const dir = await api.pickMediaFolder()
    if (dir) await importPaths([dir])
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const paths = droppedPaths(e)
    if (paths.length === 0 && e.dataTransfer.files.length > 0) {
      setError(DROP_UNAVAILABLE)
      return
    }
    importPaths(paths)
  }

  async function remove(item: { id: string }) {
    if (!project) return
    applyProjectPush(await api.removeMedia(project.id, item.id))
  }

  return (
    <div className="h-full flex flex-col p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-ink">Media</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button className={btn} onClick={() => setMenuOpen((v) => !v)} disabled={busy}>
              Import ▾
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className={`absolute right-0 mt-1 z-20 ${panel} bg-raised p-1 w-44 shadow-xl`}>
                  <button className="block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-edge/70" onClick={importFiles}>
                    Video files…
                  </button>
                  <button className="block w-full text-left px-3 py-1.5 text-sm rounded hover:bg-edge/70" onClick={importFolder}>
                    Folder…
                  </button>
                </div>
              </>
            )}
          </div>
          <button className={btnPrimary} onClick={() => setView('editor')} disabled={media.length === 0}>
            Import &amp; Continue →
          </button>
        </div>
      </div>
      <p className="text-xs text-muted mb-2">
        Files are linked in place (read-only) — never copied or modified. 💡 Keep media on a local drive; network
        drives can be slow and unreliable.
      </p>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      <div
        className={`${panel} flex-1 min-h-0 overflow-y-auto p-3 transition-colors ${
          dragOver ? 'border-accent bg-accent/5' : ''
        }`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {media.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 pointer-events-none">
            <p className="text-ink/80 mb-1">Import videos or folders</p>
            <p className="text-sm text-muted">Use the Import button above. Folders keep their structure.</p>
          </div>
        ) : (
          <MediaTree media={media} onRemove={remove} />
        )}
      </div>
    </div>
  )
}

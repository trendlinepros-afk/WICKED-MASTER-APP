import { useState } from 'react';
import { useProjectBoardStore } from '../../store/projectBoardStore';

// The left menu of the Project Board: one entry per project, added manually.
// On small screens it renders as an off-canvas drawer.
export function ProjectSidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const projects = useProjectBoardStore((s) => s.projects);
  const activeProjectId = useProjectBoardStore((s) => s.activeProjectId);
  const selectProject = useProjectBoardStore((s) => s.selectProject);
  const createProject = useProjectBoardStore((s) => s.createProject);
  const renameProject = useProjectBoardStore((s) => s.renameProject);
  const deleteProject = useProjectBoardStore((s) => s.deleteProject);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const submitNew = async () => {
    const name = draft.trim();
    setAdding(false);
    setDraft('');
    if (name) await createProject(name);
  };

  const submitRename = async () => {
    const id = renamingId;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (id && name) await renameProject(id, name);
  };

  const confirmDelete = async (id: string, name: string) => {
    if (window.confirm(`Delete "${name}" and its whole board? This can't be undone.`)) {
      await deleteProject(id);
    }
  };

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={onMobileClose} />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-edge bg-surface transition-transform duration-200 md:static md:flex-shrink-0 md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      <div className="p-3">
        <button
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent/90"
        >
          <span className="text-base leading-none">+</span> New Project
        </button>
      </div>

      <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Projects
      </h3>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
        {adding && (
          <input
            autoFocus
            value={draft}
            placeholder="Project name…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitNew}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNew();
              if (e.key === 'Escape') {
                setAdding(false);
                setDraft('');
              }
            }}
            className="mb-1 w-full rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm outline-none"
          />
        )}

        {projects.length === 0 && !adding && (
          <p className="px-2 py-4 text-center text-xs text-muted">
            No projects yet. Every idea — even the ones not ready to build — gets its own board
            here.
          </p>
        )}

        {projects.map((p) =>
          renamingId === p.id ? (
            <input
              key={p.id}
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename();
                if (e.key === 'Escape') setRenamingId(null);
              }}
              className="mb-1 w-full rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm outline-none"
            />
          ) : (
            <div
              key={p.id}
              className={`group mb-1 flex items-center rounded-lg pr-1 ${
                activeProjectId === p.id ? 'bg-raised' : 'hover:bg-raised/60'
              }`}
            >
              <button
                onClick={() => selectProject(p.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm"
              >
                <span>{p.icon}</span>
                <span className="flex-1 truncate">{p.name}</span>
              </button>
              <button
                title="Rename project"
                onClick={() => {
                  setRenamingId(p.id);
                  setRenameDraft(p.name);
                }}
                className="hidden rounded p-1 text-xs text-muted hover:text-ink group-hover:block"
              >
                ✏️
              </button>
              <button
                title="Delete project"
                onClick={() => confirmDelete(p.id, p.name)}
                className="hidden rounded p-1 text-xs text-muted hover:text-ink group-hover:block"
              >
                🗑
              </button>
            </div>
          )
        )}
      </div>
      </aside>
    </>
  );
}

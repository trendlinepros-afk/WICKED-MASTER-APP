import { useEffect, useState } from 'react';
import { useProjectBoardStore } from '../../store/projectBoardStore';
import { ProjectSidebar } from './ProjectSidebar';
import { BoardCanvas } from './BoardCanvas';
import { DataFolderModal } from './DataFolderModal';

// The Project Board — a full-screen overlay with a project list on the left
// and a freeform OneNote-style canvas per project. All data lives in a
// user-mappable folder (see DataFolderModal), separate from the chat database.
export function ProjectBoardApp() {
  const setOpen = useProjectBoardStore((s) => s.setOpen);
  const load = useProjectBoardStore((s) => s.load);
  const flushSave = useProjectBoardStore((s) => s.flushSave);
  const projects = useProjectBoardStore((s) => s.projects);
  const activeProjectId = useProjectBoardStore((s) => s.activeProjectId);
  const board = useProjectBoardStore((s) => s.board);
  const dataFolder = useProjectBoardStore((s) => s.dataFolder);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // On phones the project list is a drawer — close it once a project is picked.
  useEffect(() => {
    setNavOpen(false);
  }, [activeProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Never lose edits when the overlay unmounts.
  useEffect(() => () => void flushSave(), [flushSave]);

  // Escape closes the board when there is no canvas to hand it to (the canvas
  // has its own deselect → close chain).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || folderModalOpen) return;
      if (document.querySelector('[data-pb-modal]')) return;
      if (!activeProjectId || !board) setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeProjectId, board, folderModalOpen, setOpen]);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg text-ink">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-edge bg-surface px-4 py-2">
        <button
          onClick={() => setNavOpen(true)}
          title="Projects"
          className="rounded-md px-2 py-1 text-lg leading-none text-muted hover:text-ink md:hidden"
        >
          ☰
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:text-ink"
        >
          ← Back to WICKED
        </button>
        <div className="flex items-center gap-2">
          <span className="text-lg">📋</span>
          <h1 className="text-sm font-semibold">
            Project Board{activeProject ? ` — ${activeProject.name}` : ''}
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setFolderModalOpen(true)}
            title={dataFolder}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:text-ink"
          >
            🗂 Data folder
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ProjectSidebar mobileOpen={navOpen} onMobileClose={() => setNavOpen(false)} />
        {!activeProject ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <div>
              <div className="mb-3 text-4xl">📋</div>
              <h2 className="mb-1 text-lg font-semibold">No project selected</h2>
              <p className="max-w-sm text-sm text-muted">
                Create a project with “＋ New Project” in the left menu, then drop notes,
                screenshots and drawings anywhere on its board.
              </p>
            </div>
          </div>
        ) : !board ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            Loading board…
          </div>
        ) : (
          <BoardCanvas key={activeProject.id} projectId={activeProject.id} board={board} />
        )}
      </div>

      {folderModalOpen && <DataFolderModal onClose={() => setFolderModalOpen(false)} />}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useProjectBoardStore } from '../../store/projectBoardStore';
import { useUIStore } from '../../store/uiStore';
import { api } from '../../lib/bridge';

// Where Project Board data lives on disk. Point it at a network drive to keep
// every board (notes, drawings, screenshots) backed up outside this machine.
export function DataFolderModal({ onClose }: { onClose: () => void }) {
  const dataFolder = useProjectBoardStore((s) => s.dataFolder);
  const changeDataFolder = useProjectBoardStore((s) => s.changeDataFolder);
  const toast = useUIStore((s) => s.toast);
  const [migrate, setMigrate] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const choose = async () => {
    const folder = await api.pbChooseDataFolder();
    if (!folder || folder === dataFolder) return;
    setBusy(true);
    try {
      await changeDataFolder(folder, migrate);
      toast('Project Board data folder updated', 'success');
      onClose();
    } catch (err) {
      toast(`Couldn't change the data folder: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-pb-modal className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">🗂 Project Board data</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-muted">
            Boards are stored as plain files (notes, drawings and screenshots) in one folder.
            Point it at a network drive and everything is backed up automatically.
          </p>

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Current location
            </div>
            <div className="break-all rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-xs">
              {dataFolder || '…'}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={migrate}
              onChange={(e) => setMigrate(e.target.checked)}
            />
            Copy existing boards to the new folder
          </label>

          <button
            onClick={choose}
            disabled={busy}
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? 'Moving data…' : 'Choose new folder…'}
          </button>
        </div>
      </div>
    </div>
  );
}

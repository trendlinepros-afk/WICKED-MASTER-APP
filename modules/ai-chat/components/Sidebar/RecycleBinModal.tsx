import { useEffect, useState } from 'react';
import type { DeletedChat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useUIStore } from '../../store/uiStore';
import { api } from '../../lib/bridge';

const RETENTION_DAYS = 30;

export function RecycleBinModal({ onClose }: { onClose: () => void }) {
  const loadChats = useChatStore((s) => s.loadChats);
  const toast = useUIStore((s) => s.toast);
  const [items, setItems] = useState<DeletedChat[]>([]);

  const refresh = () => api.getDeletedChats().then(setItems);
  useEffect(() => {
    refresh();
  }, []);

  const daysLeft = (deletedAt: number) =>
    Math.max(0, RETENTION_DAYS - Math.floor((Date.now() - deletedAt) / 86_400_000));

  const restore = async (id: string) => {
    await api.restoreChat(id);
    await loadChats();
    refresh();
    toast('Chat restored', 'success');
  };

  const purge = async (id: string) => {
    await api.purgeChat(id);
    refresh();
    toast('Chat permanently deleted', 'success');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">🗑 Recycle Bin</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-3 text-xs text-muted">
            Deleted chats are kept for {RETENTION_DAYS} days, then removed automatically.
          </p>
          {items.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">The recycle bin is empty.</div>
          ) : (
            <div className="space-y-1.5">
              {items.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{c.title}</div>
                    <div className="text-xs text-muted">{daysLeft(c.deletedAt)} days left</div>
                  </div>
                  <button
                    onClick={() => restore(c.id)}
                    className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-ink"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => purge(c.id)}
                    className="rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                  >
                    Delete forever
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

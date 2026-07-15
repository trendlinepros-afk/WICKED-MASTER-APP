import { useEffect, useState } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { api } from '../../lib/bridge';

export function LinkedChatsPanel({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const chats = useChatStore((s) => s.chats);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.getChatLinks(chat.id).then((ids) => setLinked(new Set(ids)));
  }, [chat.id]);

  const toggle = async (id: string) => {
    const next = new Set(linked);
    if (next.has(id)) {
      next.delete(id);
      await api.removeChatLink(chat.id, id);
    } else {
      next.add(id);
      await api.addChatLink(chat.id, id);
    }
    setLinked(next);
  };

  const candidates = chats.filter(
    (c) => c.id !== chat.id && c.title.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-edge bg-surface p-2 shadow-2xl">
        <div className="px-1 pb-2 text-xs text-muted">
          Link chats to share their context with this conversation.
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          className="mb-2 w-full rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <div className="max-h-64 overflow-y-auto">
          {candidates.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted">No chats</div>
          ) : (
            candidates.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-raised"
              >
                <input
                  type="checkbox"
                  checked={linked.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="accent-accent"
                />
                <span className="truncate">{c.title}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { MessageSearchHit } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { api } from '../../lib/bridge';

// Full-text-ish search across all chats' message bodies.
export function GlobalSearch() {
  const selectChat = useChatStore((s) => s.selectChat);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MessageSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    debounce.current = setTimeout(() => {
      api.searchMessages(query).then(setHits);
    }, 200);
  }, [query]);

  return (
    <div className="relative px-1">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="🔍 Search all chats…"
        className="w-full rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      {open && query.trim() && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-1 right-1 z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-edge bg-surface py-1 shadow-xl">
            {hits.length === 0 ? (
              <div className="px-3 py-3 text-center text-xs text-muted">No matches</div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.messageId}
                  onClick={() => {
                    selectChat(h.chatId);
                    setOpen(false);
                    setQuery('');
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-raised"
                >
                  <div className="truncate text-xs font-medium text-ink">{h.chatTitle}</div>
                  <div className="truncate text-xs text-muted">
                    <span className="text-muted/70">{h.role}: </span>
                    {h.snippet}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

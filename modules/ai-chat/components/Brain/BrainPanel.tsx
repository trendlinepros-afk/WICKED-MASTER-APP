import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { VaultNote } from '../../types';
import { useBrainStore } from '../../store/brainStore';
import { useChatStore } from '../../store/chatStore';
import { useUIStore } from '../../store/uiStore';
import { api } from '../../lib/bridge';

type Tab = 'notes' | 'ideas' | 'search' | 'context';

export function BrainPanel() {
  const notes = useBrainStore((s) => s.notes);
  const loadNotes = useBrainStore((s) => s.loadNotes);
  const search = useBrainStore((s) => s.search);
  const searchResults = useBrainStore((s) => s.searchResults);
  const setPanelOpen = useBrainStore((s) => s.setPanelOpen);
  const activeContext = useBrainStore((s) => s.activeContext);
  const activeChatId = useChatStore((s) => s.activeChatId);

  const [tab, setTab] = useState<Tab>('notes');
  const [selected, setSelected] = useState<VaultNote | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const ideas = useMemo(() => notes.filter((n) => n.category === 'Ideas'), [notes]);
  const byCategory = useMemo(() => {
    const map = new Map<string, VaultNote[]>();
    for (const n of notes) {
      const list = map.get(n.category) ?? [];
      list.push(n);
      map.set(n.category, list);
    }
    return map;
  }, [notes]);

  const injected = activeChatId ? activeContext[activeChatId] ?? [] : [];

  const openExternal = (path: string) => api.openExternal(path);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[360px] flex-col border-l border-edge bg-surface md:static md:h-full md:w-[360px] md:flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="flex items-center gap-2 font-semibold text-warn">🧠 Master Brain</h2>
        <div className="flex items-center gap-1">
          <GitSyncButton />
          <button
            onClick={() => setPanelOpen(false)}
            className="text-muted hover:text-ink"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex border-b border-edge px-2 text-sm">
        <TabBtn active={tab === 'notes'} onClick={() => setTab('notes')} label="📚 Notes" />
        <TabBtn active={tab === 'ideas'} onClick={() => setTab('ideas')} label="💡 Ideas" />
        <TabBtn active={tab === 'search'} onClick={() => setTab('search')} label="🔍 Search" />
        <TabBtn active={tab === 'context'} onClick={() => setTab('context')} label="📎 Context" />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {selected ? (
          <NotePreview note={selected} onBack={() => setSelected(null)} onOpen={openExternal} />
        ) : (
          <>
            {tab === 'notes' && (
              <div className="space-y-3">
                {notes.length === 0 && <Empty text="No notes yet. End & Review a chat to save one." />}
                {Array.from(byCategory.entries()).map(([cat, list]) => (
                  <div key={cat}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {cat}
                    </div>
                    <div className="space-y-1">
                      {list.map((n) => (
                        <NoteRow key={n.path} note={n} onClick={() => setSelected(n)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'ideas' && (
              <div className="grid gap-2">
                {ideas.length === 0 && <Empty text="No ideas captured yet." />}
                {ideas.map((n) => (
                  <button
                    key={n.path}
                    onClick={() => setSelected(n)}
                    className="rounded-xl border border-ok/30 bg-ok/5 p-3 text-left hover:bg-ok/10"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-ok">{n.title}</span>
                      {n.status && (
                        <span className="rounded-full bg-ok/20 px-2 py-0.5 text-[10px] uppercase text-ok">
                          {n.status}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted">{n.body.slice(0, 120)}</p>
                  </button>
                ))}
              </div>
            )}

            {tab === 'search' && (
              <div>
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    search(e.target.value);
                  }}
                  placeholder="Search the vault…"
                  className="mb-3 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <div className="space-y-1">
                  {query && searchResults.length === 0 && <Empty text="No matches." />}
                  {searchResults.map((n) => (
                    <NoteRow key={n.path} note={n} onClick={() => setSelected(n)} />
                  ))}
                </div>
              </div>
            )}

            {tab === 'context' && (
              <div className="space-y-1">
                {injected.length === 0 ? (
                  <Empty text="No notes injected into the current chat's last message." />
                ) : (
                  injected.map((n) => (
                    <button
                      key={n.path}
                      onClick={() => {
                        const note = notes.find((x) => x.path === n.path);
                        if (note) setSelected(note);
                      }}
                      className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-warn hover:bg-warn/10"
                    >
                      🧠 {n.title}
                      <span className="ml-1 text-xs text-muted">{n.path}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 border-b-2 px-1 py-2 text-xs transition ${
        active ? 'border-warn text-warn' : 'border-transparent text-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}

function NoteRow({ note, onClick }: { note: VaultNote; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-raised"
    >
      {note.title}
    </button>
  );
}

function NotePreview({
  note,
  onBack,
  onOpen,
}: {
  note: VaultNote;
  onBack: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted hover:text-ink">
          ← Back
        </button>
        <button
          onClick={() => onOpen(note.path)}
          className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-ink"
        >
          Edit in Obsidian
        </button>
      </div>
      <h3 className="text-base font-semibold">{note.title}</h3>
      <div className="mb-2 flex flex-wrap gap-1">
        {note.tags.map((t) => (
          <span key={t} className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-muted">
            #{t}
          </span>
        ))}
      </div>
      <div className="markdown-body text-sm text-ink">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.body}</ReactMarkdown>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted">{text}</div>;
}

function GitSyncButton() {
  const toast = useUIStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        try {
          const result = await api.vaultGitSync('WICKED vault sync');
          toast(result, 'success');
        } catch (err) {
          toast(`Git sync failed: ${(err as Error).message}`, 'error');
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      title="Commit & push the vault with git (versioning / sync)"
      className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-50"
    >
      {busy ? '…' : '⇅ Sync'}
    </button>
  );
}

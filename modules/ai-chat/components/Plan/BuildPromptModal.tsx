import { useEffect, useRef, useState } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { completeText } from '../../hooks/useChat';
import { BUILD_PROMPT_INSTRUCTION, planNoteMarkdown } from '../../lib/planning';
import { api } from '../../lib/bridge';

// Compiles the current conversation into a single build prompt, then lets the
// user copy it or save it to the Obsidian vault.
export function BuildPromptModal({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const messages = useChatStore((s) => s.messages);
  const settings = useSettingsStore((s) => s.settings);
  const toast = useUIStore((s) => s.toast);

  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const text = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
      })
      .join('\n\n');

    completeText(
      chat.provider,
      chat.modelVersion,
      settings,
      `${BUILD_PROMPT_INSTRUCTION}\n\n=== CONVERSATION ===\n${transcript}`
    )
      .then((res) => setPrompt(res.trim()))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [chat, messages, settings]);

  const saveToBrain = async () => {
    if (!settings.vaultPath) {
      toast('Set a vault folder in Settings first', 'error');
      return;
    }
    try {
      const title = chat.title && chat.title !== 'New Chat' ? chat.title : 'App Plan';
      const path = await api.vaultWriteNote(
        'Projects',
        `${title} build prompt`,
        planNoteMarkdown(`${title} — Build Prompt`, prompt)
      );
      await api.vaultRegenerateIndex();
      toast(`Saved to Brain → ${path}`, 'success');
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="flex items-center gap-2 font-semibold text-accent">📦 Build Prompt</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="py-10 text-center text-sm text-muted">
              Compiling your plan into a build prompt…
            </div>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!loading && !error && (
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="h-[55vh] w-full resize-none rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:text-ink"
          >
            Close
          </button>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(prompt);
                toast('Build prompt copied', 'success');
              } catch {
                toast('Copy failed — select the text and copy manually', 'error');
              }
            }}
            disabled={loading || !!error}
            className="rounded-lg border border-edge px-4 py-2 text-sm hover:bg-raised disabled:opacity-40"
          >
            ⧉ Copy
          </button>
          <button
            onClick={saveToBrain}
            disabled={loading || !!error}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-40"
          >
            🧠 Save to Brain
          </button>
        </div>
      </div>
    </div>
  );
}

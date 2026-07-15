import { useEffect, useState } from 'react';
import type { Chat, PromptTemplate } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useUIStore } from '../../store/uiStore';
import { api } from '../../lib/bridge';

// Edit a chat's system prompt (persona) and manage reusable prompt templates.
export function SystemPromptModal({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const setSystemPrompt = useChatStore((s) => s.setSystemPrompt);
  const toast = useUIStore((s) => s.toast);
  const [value, setValue] = useState(chat.systemPrompt ?? '');
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');

  const loadTemplates = () => api.getTemplates().then(setTemplates);
  useEffect(() => {
    loadTemplates();
  }, []);

  const save = async () => {
    await setSystemPrompt(chat.id, value);
    toast('System prompt saved', 'success');
    onClose();
  };

  const saveAsTemplate = async () => {
    const name = templateName.trim();
    if (!name || !value.trim()) return;
    await api.saveTemplate(name, value);
    setTemplateName('');
    loadTemplates();
    toast(`Template "${name}" saved`, 'success');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">🎭 System Prompt / Persona</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-xs text-muted">
            Sets how the model behaves for this chat. Prepended as a system message on every send.
          </p>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            placeholder="e.g. You are a senior Godot engineer. Be concise and show GDScript examples."
            className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
              Templates
            </div>
            {templates.length === 0 ? (
              <div className="text-xs text-muted/70">No saved templates yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent"
                  >
                    <button onClick={() => setValue(t.body)} title="Use this template">
                      {t.name}
                    </button>
                    <button
                      onClick={async () => {
                        await api.deleteTemplate(t.id);
                        loadTemplates();
                      }}
                      className="hover:text-white"
                      title="Delete template"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Save current as template…"
                className="flex-1 rounded-md border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={saveAsTemplate}
                disabled={!templateName.trim() || !value.trim()}
                className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
              >
                Save template
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={() => setValue('')}
            className="mr-auto rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-ink"
          >
            Clear
          </button>
          <button
            onClick={onClose}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

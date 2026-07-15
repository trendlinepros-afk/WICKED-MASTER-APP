import { useEffect, useRef, useState } from 'react';
import type { Chat, MemoryReview } from '../../types';
import { VAULT_CATEGORIES } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useBrainStore } from '../../store/brainStore';
import { useUIStore } from '../../store/uiStore';
import { useMemoryReview } from '../../hooks/useMemoryReview';
import { IdeaLogBadge } from './IdeaLogBadge';

export function MemoryReviewModal({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const messages = useChatStore((s) => s.messages);
  const settings = useSettingsStore((s) => s.settings);
  const loadNotes = useBrainStore((s) => s.loadNotes);
  const toast = useUIStore((s) => s.toast);
  const { generateReview, saveReview, generating } = useMemoryReview();

  const [review, setReview] = useState<MemoryReview | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [errored, setErrored] = useState<string | null>(null);
  // Generate the summary exactly once when the modal opens — not on every
  // streamed message update (which would fire extra paid summary calls).
  const generatedRef = useRef(false);

  useEffect(() => {
    if (generatedRef.current) return;
    if (!settings.vaultPath) {
      setErrored('Set a vault folder in Settings before saving to your Brain.');
      return;
    }
    const realMessages = messages.filter((m) => m.role !== 'system');
    if (realMessages.length === 0) {
      setErrored('Nothing to summarize yet.');
      return;
    }
    generatedRef.current = true;
    generateReview(chat, messages, settings)
      .then(setReview)
      .catch((err) => setErrored((err as Error).message));
  }, [chat, messages, settings, generateReview]);

  const update = (patch: Partial<MemoryReview>) =>
    setReview((r) => (r ? { ...r, ...patch } : r));

  const onSave = async () => {
    if (!review) return;
    setSaving(true);
    try {
      const { notePath } = await saveReview(chat, review, settings);
      toast(`Saved to Brain → ${notePath}`, 'success');
      loadNotes();
      onClose();
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="flex items-center gap-2 font-semibold text-warn">
            🧠 Add to Memory?
          </h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {errored && <div className="text-sm text-red-400">{errored}</div>}
          {!errored && (generating || !review) && (
            <div className="py-10 text-center text-sm text-muted">
              Summarizing this conversation…
            </div>
          )}

          {review && !errored && (
            <div className="space-y-4">
              <Field label="Summary">
                <textarea
                  value={review.summary}
                  onChange={(e) => update({ summary: e.target.value })}
                  rows={3}
                  className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>

              <Field label="Key Points (one per line)">
                <textarea
                  value={review.keyPoints.join('\n')}
                  onChange={(e) =>
                    update({ keyPoints: e.target.value.split('\n').filter(Boolean) })
                  }
                  rows={4}
                  className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>

              {review.ideas.length > 0 && (
                <div className="rounded-lg border border-ok/30 bg-ok/10 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <IdeaLogBadge count={review.ideas.length} />
                    <span className="text-xs text-muted">
                      Each idea is saved as its own note in 💡 Ideas
                    </span>
                  </div>
                  <textarea
                    value={review.ideas.join('\n')}
                    onChange={(e) =>
                      update({ ideas: e.target.value.split('\n').filter(Boolean) })
                    }
                    rows={3}
                    className="w-full rounded-lg border border-ok/30 bg-raised px-3 py-2 text-sm outline-none focus:border-ok"
                  />
                </div>
              )}

              <Field label="Category">
                <select
                  value={review.category}
                  onChange={(e) => update({ category: e.target.value })}
                  className="rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  {VAULT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Tags">
                <div className="flex flex-wrap gap-2">
                  {review.tags.map((tag, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent"
                    >
                      {tag}
                      <button
                        onClick={() =>
                          update({ tags: review.tags.filter((_, idx) => idx !== i) })
                        }
                        className="hover:text-white"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && tagInput.trim()) {
                        update({ tags: [...review.tags, tagInput.trim()] });
                        setTagInput('');
                      }
                    }}
                    placeholder="+ tag"
                    className="w-20 rounded-full border border-edge bg-raised px-2 py-0.5 text-xs outline-none focus:border-accent"
                  />
                </div>
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:text-ink"
          >
            ✗ Skip
          </button>
          <button
            onClick={onSave}
            disabled={!review || saving || !!errored}
            className="rounded-lg bg-ok px-4 py-2 text-sm font-medium text-white hover:bg-ok/90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : '✅ Add to Brain'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

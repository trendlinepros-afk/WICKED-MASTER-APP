import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import { useBrainStore } from '../store/brainStore';
import { useUIStore } from '../store/uiStore';
import { useMemoryReview } from './useMemoryReview';
import { api } from '../lib/bridge';

// Periodically commit chats to the memory vault on a schedule. Skips chats that
// are opted out (noMemory) or have no new activity since their last commit, and
// re-commits previously-saved chats that have gained new messages.
export function useAutoMemory() {
  const settings = useSettingsStore((s) => s.settings);
  const loadChats = useChatStore((s) => s.loadChats);
  const loadNotes = useBrainStore((s) => s.loadNotes);
  const toast = useUIStore((s) => s.toast);
  const { generateReview, saveReview } = useMemoryReview();
  const runningRef = useRef(false);

  const { autoMemoryEnabled, autoMemoryIntervalMinutes, vaultPath } = settings;

  useEffect(() => {
    if (!autoMemoryEnabled || !vaultPath) return;
    const intervalMs = Math.max(5, autoMemoryIntervalMinutes) * 60_000;

    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const chats = await api.getChats();
        let committed = 0;
        for (const chat of chats) {
          if (chat.noMemory) continue;
          // Only chats with activity since their last commit.
          if (chat.updatedAt <= chat.lastCommittedAt) continue;
          const messages = await api.getMessages(chat.id);
          if (messages.filter((m) => m.role !== 'system').length === 0) continue;
          try {
            const review = await generateReview(chat, messages, settings);
            await saveReview(chat, review, settings);
            await api.setChatCommitted(chat.id, Date.now());
            committed++;
          } catch (err) {
            console.warn(`Auto-memory: failed to commit "${chat.title}"`, err);
          }
        }
        if (committed > 0) {
          toast(`Auto-saved ${committed} chat${committed === 1 ? '' : 's'} to memory`, 'success');
          await loadChats();
          await loadNotes();
        }
      } finally {
        runningRef.current = false;
      }
    };

    const id = setInterval(run, intervalMs);
    return () => clearInterval(id);
  }, [
    autoMemoryEnabled,
    autoMemoryIntervalMinutes,
    vaultPath,
    settings,
    generateReview,
    saveReview,
    loadChats,
    loadNotes,
    toast,
  ]);
}

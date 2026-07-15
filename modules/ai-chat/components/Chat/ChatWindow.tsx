import { useState } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useAgentStore } from '../../store/agentStore';
import { useUIStore } from '../../store/uiStore';
import { ModelSelector } from '../ModelSelector/ModelSelector';
import { MessageList } from './MessageList';
import { InputArea } from './InputArea';
import { LinkedChatsPanel } from '../LinkedChats/LinkedChatsPanel';
import { VaultContextBadge } from '../Brain/VaultContextBadge';
import { MemoryReviewModal } from '../Brain/MemoryReviewModal';
import { SuggestionBanner } from './SuggestionBanner';
import { SystemPromptModal } from './SystemPromptModal';
import { BuildPromptModal } from '../Plan/BuildPromptModal';
import { UsageMeter } from './UsageMeter';

export function ChatWindow() {
  const activeChatId = useChatStore((s) => s.activeChatId);
  const chats = useChatStore((s) => s.chats);
  const setNoMemory = useChatStore((s) => s.setNoMemory);
  const setAgentPersona = useChatStore((s) => s.setAgentPersona);
  const personas = useAgentStore((s) => s.personas);
  const toast = useUIStore((s) => s.toast);
  const vaultPath = useSettingsStore((s) => s.settings.vaultPath);
  const [linkOpen, setLinkOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);

  const chat = chats.find((c) => c.id === activeChatId) ?? null;

  if (!chat) {
    return (
      <div className="flex flex-1 flex-col">
        {/* Port note: the standalone theme toggle lived here — the shell owns the theme now. */}
        <div className="flex items-center justify-between border-b border-edge bg-surface px-4 py-2 md:hidden">
          <MobileMenuButton />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <div className="text-5xl">🔮</div>
          <h2 className="mt-4 text-xl font-semibold">One window. Every model. One memory.</h2>
          <p className="mt-2 max-w-sm text-sm text-muted">
            Create a new chat to get started. Connect an Obsidian vault to give every model a shared
            long-term memory — or skip it and just chat.
          </p>
          {!vaultPath && (
            <p className="mt-3 text-xs text-warn">
              Tip: choose an Obsidian vault in Settings ⚙️ to turn on memory (optional).
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ModelSelector chat={chat} />

      {/* Chat sub-header: title, link, end & review */}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface px-4 py-2">
        <MobileMenuButton />
        <h2 className="min-w-[8rem] flex-1 truncate text-sm font-medium">{chat.title}</h2>
        {personas.length > 0 && (
          <select
            value={chat.agentPersonaId ?? ''}
            onChange={(e) => setAgentPersona(chat.id, e.target.value || null)}
            title="Answer as a brain persona (grounded in its documents)"
            className={`max-w-[11rem] truncate rounded-md border px-2 py-1 text-sm outline-none ${
              chat.agentPersonaId
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-edge bg-raised text-muted'
            }`}
          >
            <option value="">🧠 No persona</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar} {p.name}
              </option>
            ))}
          </select>
        )}
        <UsageMeter chat={chat} />
        <button
          onClick={() => {
            const excluded = !chat.noMemory;
            setNoMemory(chat.id, excluded);
            toast(
              excluded
                ? 'Memory OFF for this chat — it will be skipped by memory saves'
                : 'Memory ON for this chat — it will be included in memory saves',
              'info'
            );
          }}
          title={
            chat.noMemory
              ? 'Memory is OFF for this chat (excluded from saves) — click to turn it back on. To save the conversation now, use "Save to memory".'
              : 'Memory is ON for this chat. Click to exclude it from memory saves. To save the conversation now, use "Save to memory".'
          }
          className={`rounded-md px-2 py-1 text-sm hover:bg-raised ${
            chat.noMemory ? 'text-red-400' : 'text-muted hover:text-ink'
          }`}
        >
          {chat.noMemory ? '🚫 Memory: Off' : '💾 Memory: On'}
        </button>
        <VaultContextBadge chatId={chat.id} />
        <button
          onClick={() => setPersonaOpen(true)}
          title="Edit this chat's system prompt / persona"
          className={`rounded-md px-2 py-1 text-sm hover:bg-raised hover:text-ink ${
            chat.systemPrompt ? 'text-accent' : 'text-muted'
          }`}
        >
          🎭 Persona
        </button>
        <button
          onClick={() => setBuildOpen(true)}
          title="Compile this conversation into a build prompt"
          className="rounded-md border border-accent/30 px-2 py-1 text-sm text-accent hover:bg-accent/10"
        >
          📦 Build Prompt
        </button>
        <div className="relative">
          <button
            onClick={() => setLinkOpen((v) => !v)}
            title="Link other chats for cross-chat context"
            className="rounded-md px-2 py-1 text-sm text-muted hover:bg-raised hover:text-ink"
          >
            🔗 Link
          </button>
          {linkOpen && <LinkedChatsPanel chat={chat} onClose={() => setLinkOpen(false)} />}
        </div>
        <button
          onClick={() => setReviewOpen(true)}
          title="Summarize this conversation and save it to your Obsidian vault"
          className="rounded-md border border-warn/30 px-2 py-1 text-sm text-warn hover:bg-warn/10"
        >
          💾 Save to memory
        </button>
      </div>

      <SuggestionBanner chat={chat} />
      <MessageList chat={chat} />
      <InputArea chat={chat} />

      {reviewOpen && <MemoryReviewModal chat={chat} onClose={() => setReviewOpen(false)} />}
      {personaOpen && <SystemPromptModal chat={chat} onClose={() => setPersonaOpen(false)} />}
      {buildOpen && <BuildPromptModal chat={chat} onClose={() => setBuildOpen(false)} />}
    </div>
  );
}

// Opens the sidebar drawer — only exists on small screens (e.g. the web
// portal on a phone), where the sidebar is hidden by default.
function MobileMenuButton() {
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  return (
    <button
      onClick={() => setMobileNavOpen(true)}
      title="Menu"
      className="rounded-md px-2 py-1 text-lg leading-none text-muted hover:text-ink md:hidden"
    >
      ☰
    </button>
  );
}

import { useEffect, useState } from 'react';
import type { AgentPersona } from '../../types';
import { useAgentStore } from '../../store/agentStore';
import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { completeText } from '../../hooks/useChat';
import { api } from '../../lib/bridge';

// Manager for vault-backed "brain" personas: create one from an Obsidian folder,
// edit it, delete it, or start a new chat that answers as that brain.
export function AgentPersonaModal({ onClose }: { onClose: () => void }) {
  const personas = useAgentStore((s) => s.personas);
  const load = useAgentStore((s) => s.load);
  const remove = useAgentStore((s) => s.remove);
  const [editing, setEditing] = useState<AgentPersona | 'new' | null>(null);

  useEffect(() => {
    load();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [load, onClose, editing]);

  if (editing) {
    return (
      <PersonaEditor persona={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">🧠 Personas</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          <p className="text-xs text-muted">
            Build a persona from an Obsidian folder of documents about a person. New chats with that
            persona selected answer <strong>as that person</strong>, grounded in all of their
            documents.
          </p>
          {personas.length === 0 && (
            <p className="py-6 text-center text-sm text-muted">
              No personas yet. Create one from a brain folder.
            </p>
          )}
          {personas.map((p) => (
            <PersonaRow key={p.id} persona={p} onEdit={() => setEditing(p)} onDelete={() => remove(p.id)} onClose={onClose} />
          ))}
        </div>

        <div className="flex justify-end border-t border-edge px-5 py-3">
          <button
            onClick={() => setEditing('new')}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            + New persona
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonaRow({
  persona,
  onEdit,
  onDelete,
  onClose,
}: {
  persona: AgentPersona;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const createChat = useChatStore((s) => s.createChat);
  const setAgentPersona = useChatStore((s) => s.setAgentPersona);
  const settings = useSettingsStore((s) => s.settings);
  const toast = useUIStore((s) => s.toast);

  const startChat = async () => {
    const chat = await createChat(settings.defaultProvider, settings.defaultModelVersion);
    await setAgentPersona(chat.id, persona.id);
    toast(`New chat as ${persona.name}`, 'success');
    onClose();
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2">
      <span className="text-lg">{persona.avatar}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{persona.name}</div>
        <div className="truncate text-xs text-muted">{persona.vaultPath || 'No folder set'}</div>
      </div>
      <button
        onClick={startChat}
        className="rounded-md bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent/90"
      >
        💬 New chat
      </button>
      <button onClick={onEdit} className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink">
        Edit
      </button>
      <button
        onClick={() => {
          if (confirm(`Delete persona "${persona.name}"?`)) onDelete();
        }}
        className="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
      >
        Delete
      </button>
    </div>
  );
}

function PersonaEditor({
  persona,
  onClose,
}: {
  persona: AgentPersona | null;
  onClose: () => void;
}) {
  const create = useAgentStore((s) => s.create);
  const update = useAgentStore((s) => s.update);
  const settings = useSettingsStore((s) => s.settings);
  const toast = useUIStore((s) => s.toast);

  const [name, setName] = useState(persona?.name ?? '');
  const [avatar, setAvatar] = useState(persona?.avatar ?? '🧠');
  const [systemPrompt, setSystemPrompt] = useState(persona?.systemPrompt ?? '');
  const [vaultPath, setVaultPath] = useState(persona?.vaultPath ?? '');
  const [generating, setGenerating] = useState(false);

  const pickFolder = async () => {
    const p = await api.openVaultFolderDialog();
    if (p) setVaultPath(p);
  };

  const generate = async () => {
    if (!vaultPath) {
      toast('Choose the brain folder first', 'error');
      return;
    }
    setGenerating(true);
    try {
      const { fileCount, sample } = await api.brainFolderDigest(vaultPath);
      if (fileCount === 0) {
        toast('No documents found in that folder', 'error');
        return;
      }
      const prompt =
        `You are creating an AI "brain" persona from a person's knowledge base. Below are ` +
        `documents from/about this person (${fileCount} files).\n\nDOCUMENTS:\n${sample}\n\n` +
        `Return ONLY a JSON object with exactly these keys:\n` +
        `- "name": the person's name (or a fitting name for this brain)\n` +
        `- "avatar": a single emoji representing them\n` +
        `- "systemPrompt": a detailed prompt (150-300 words) written in second person ("You are ...") ` +
        `instructing an AI to fully embody this person — their expertise, worldview, frameworks, and ` +
        `communication style — and to answer every question AS them, grounded strictly in their ` +
        `knowledge base.\nReturn only the JSON, no prose or code fences.`;
      const raw = await completeText(
        settings.defaultProvider,
        settings.defaultModelVersion,
        settings,
        prompt
      );
      const folderName = vaultPath.split(/[\\/]/).filter(Boolean).pop() || 'Persona';
      try {
        const json = raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
        const parsed = JSON.parse(json) as {
          name?: string;
          avatar?: string;
          systemPrompt?: string;
        };
        setName(parsed.name || folderName);
        if (parsed.avatar) setAvatar(parsed.avatar.slice(0, 2));
        setSystemPrompt(parsed.systemPrompt || raw.trim());
        toast('Persona drafted from the brain — review and save', 'success');
      } catch {
        // Model didn't return clean JSON — still use its text as the instructions.
        if (!name) setName(folderName);
        setSystemPrompt(raw.trim());
        toast('Drafted from the brain — review the instructions below', 'info');
      }
    } catch (err) {
      toast(`Couldn't reach the model: ${(err as Error).message}`, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!name.trim()) {
      toast('Give the persona a name', 'error');
      return;
    }
    if (!vaultPath) {
      toast('Choose the brain folder', 'error');
      return;
    }
    if (persona) {
      await update(persona.id, { name, avatar, systemPrompt, vaultPath });
      toast('Persona saved', 'success');
    } else {
      await create({ name, avatar, systemPrompt, vaultPath });
      toast('Persona created', 'success');
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">{persona ? 'Edit persona' : 'New persona'}</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs text-muted">Brain folder (Obsidian)</label>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={vaultPath || 'No folder chosen'}
                className="flex-1 truncate rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-muted"
              />
              <button
                onClick={pickFolder}
                className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90"
              >
                {vaultPath ? 'Change…' : 'Choose folder'}
              </button>
            </div>
            <button
              onClick={generate}
              disabled={generating || !vaultPath}
              className="mt-2 rounded-lg border border-accent/40 px-3 py-1.5 text-sm text-accent hover:bg-accent/10 disabled:opacity-50"
            >
              {generating ? 'Reading the brain…' : '✨ Auto-create persona from folder'}
            </button>
          </div>

          <div className="flex gap-2">
            <div>
              <label className="mb-1 block text-xs text-muted">Emoji</label>
              <input
                value={avatar}
                onChange={(e) => setAvatar(e.target.value.slice(0, 2))}
                className="w-14 rounded-lg border border-edge bg-raised px-2 py-2 text-center text-lg outline-none focus:border-accent"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-muted">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alex Hormozi"
                className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted">
              Persona instructions (how the AI embodies them)
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={9}
              placeholder="You are … Answer every question as them, grounded in their knowledge base."
              className="w-full resize-y rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <p className="mt-1 text-xs text-muted">
              Chats using this persona answer as them and pull the most relevant documents from the
              folder above on every question.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:text-ink"
          >
            Back
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            {persona ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

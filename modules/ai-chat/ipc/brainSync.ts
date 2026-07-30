import * as db from './db';
import type { AgentPersona, Message } from '../types';
import {
  deleteChat as brainDeleteChat,
  deletePersonaFolder,
  importPersonaFolder,
  isInsidePersonas,
  saveChat as brainSaveChat,
  type AppLike,
  type SimpleMsg,
} from '../../the-brain/lib/brainStore';

/**
 * Mirrors Wicked AI Chat into The Brain — the app's local markdown vault that
 * travels with Backup & Cloud Sync.
 *
 *  - Every chat is saved under Chats/Wicked AI Chat/ and updated as it grows;
 *    deleting a chat deletes its note too.
 *  - Agent personas' brain documents are copied into Personas/<name>/ and the
 *    persona is re-pointed there, so personas live IN the app (and sync) instead
 *    of only on a local C:\ Obsidian folder.
 *
 * All calls are best-effort: a Brain failure must never break chat or personas.
 */

const SOURCE = 'Wicked AI Chat';

/** Flatten a message's content parts into markdown text. */
function partsToText(content: Message['content']): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const p of content) {
    if (p.type === 'text' && p.text) out.push(p.text);
    else if (p.type === 'image_url') out.push('_[image]_');
    else if (p.type === 'file') out.push(`_[file: ${p.name ?? 'attachment'}]_`);
  }
  return out.join('\n\n').trim();
}

/** Write (or update/rename) a chat's note in The Brain. No-op for empty chats. */
export function syncChatToBrain(app: AppLike, chatId: string): void {
  try {
    const chat = db.getChats().find((c) => c.id === chatId);
    if (!chat) return;
    const msgs = db.getMessages(chatId).filter((m) => m.role !== 'system');
    if (msgs.length === 0) return;
    const messages: SimpleMsg[] = msgs.map((m) => ({
      role: m.role,
      text: partsToText(m.content),
      ts: m.createdAt,
      sub: m.role === 'assistant' && m.modelVersion ? m.modelVersion : undefined,
    }));
    brainSaveChat(app, {
      source: SOURCE,
      id: chat.id,
      title: chat.title,
      messages,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    });
  } catch {
    /* Brain is optional */
  }
}

export function removeChatFromBrain(app: AppLike, chatId: string): void {
  try {
    brainDeleteChat(app, SOURCE, chatId);
  } catch {
    /* Brain is optional */
  }
}

/**
 * Bring a persona's grounding documents into the vault and re-point it there.
 * Returns the (possibly updated) persona. If already in-vault, does nothing.
 */
export function syncPersonaToBrain(app: AppLike, persona: AgentPersona): AgentPersona {
  try {
    if (persona.vaultPath && isInsidePersonas(app, persona.vaultPath)) return persona;
    const dest = importPersonaFolder(app, persona.name, persona.vaultPath || '');
    if (dest && dest !== persona.vaultPath) {
      db.agentUpdatePersona(persona.id, { vaultPath: dest });
      return { ...persona, vaultPath: dest };
    }
    return persona;
  } catch {
    return persona;
  }
}

export function removePersonaFromBrain(app: AppLike, persona: AgentPersona | null): void {
  if (!persona) return;
  try {
    deletePersonaFolder(app, persona.name);
  } catch {
    /* Brain is optional */
  }
}

/** One-time backfill of every existing chat + persona into The Brain. */
export function portAllToBrain(app: AppLike): void {
  try {
    for (const c of db.getChats()) syncChatToBrain(app, c.id);
  } catch {
    /* ignore */
  }
  try {
    for (const p of db.agentGetPersonas()) syncPersonaToBrain(app, p);
  } catch {
    /* ignore */
  }
}

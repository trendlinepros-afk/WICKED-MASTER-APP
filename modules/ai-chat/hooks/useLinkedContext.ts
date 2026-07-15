import { useCallback } from 'react';
import type { Chat, Message } from '../types';
import { api } from '../lib/bridge';

function partsToText(content: Message['content']): string {
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
}

export function useLinkedContext() {
  // Builds a single system-message text block from all linked chats' histories.
  const buildLinkedContext = useCallback(
    async (chatId: string, allChats: Chat[]): Promise<string | null> => {
      const linkedIds = await api.getChatLinks(chatId);
      if (linkedIds.length === 0) return null;

      const sections: string[] = [];
      for (const id of linkedIds) {
        const chat = allChats.find((c) => c.id === id);
        const messages = await api.getMessages(id);
        if (messages.length === 0) continue;
        const transcript = messages
          .filter((m) => m.role !== 'system')
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${partsToText(m.content)}`)
          .join('\n');
        sections.push(`--- Linked Chat: ${chat?.title ?? id} ---\n${transcript}`);
      }
      if (sections.length === 0) return null;

      return `=== Linked Chat Context ===\nContext from other conversations the user has linked to this one:\n\n${sections.join(
        '\n\n'
      )}\n=== End Linked Context ===`;
    },
    []
  );

  return { buildLinkedContext };
}

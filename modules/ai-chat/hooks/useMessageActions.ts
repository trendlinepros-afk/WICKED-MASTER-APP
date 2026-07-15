import { useCallback } from 'react';
import type { Chat, ContentPart, Message } from '../types';
import { useChatStore } from '../store/chatStore';
import { useUIStore } from '../store/uiStore';
import { useSend } from './useSend';
import { api } from '../lib/bridge';

export function useMessageActions(chat: Chat) {
  // Single useSend instance — useSend()/useChat() now share one streaming
  // controller via the stream store, but we still avoid double-instantiation.
  const { send, regenerate } = useSend();
  const removeMessage = useChatStore((s) => s.removeMessage);
  const reloadMessages = useChatStore((s) => s.reloadMessages);
  const loadChats = useChatStore((s) => s.loadChats);
  const selectChat = useChatStore((s) => s.selectChat);
  const toast = useUIStore((s) => s.toast);

  // Delete a single message.
  const deleteMessage = useCallback(
    (message: Message) => removeMessage(message.id),
    [removeMessage]
  );

  // Regenerate an assistant reply: drop it (and anything after) then re-run.
  const regenerateFrom = useCallback(
    async (assistant: Message) => {
      await api.deleteMessagesFrom(chat.id, assistant.createdAt);
      await reloadMessages(chat.id);
      await regenerate(chat);
    },
    [chat, reloadMessages, regenerate]
  );

  // Edit a user message: drop it and everything after, then resend new text.
  const editAndResend = useCallback(
    async (userMessage: Message, newText: string) => {
      await api.deleteMessagesFrom(chat.id, userMessage.createdAt);
      await reloadMessages(chat.id);
      // Preserve any non-text parts (e.g. attachments) from the original message.
      const nonText = userMessage.content.filter((p) => p.type !== 'text');
      const parts: ContentPart[] = [{ type: 'text', text: newText }, ...nonText];
      await send(chat, parts);
    },
    [chat, reloadMessages, send]
  );

  // Fork the conversation into a new chat up to and including this message.
  const branchFrom = useCallback(
    async (message: Message) => {
      const newChat = await api.branchChat(chat.id, message.createdAt);
      if (!newChat) return;
      await loadChats();
      await selectChat(newChat.id);
      toast(`Branched to "${newChat.title}"`, 'success');
    },
    [chat, loadChats, selectChat, toast]
  );

  return { deleteMessage, regenerateFrom, editAndResend, branchFrom };
}

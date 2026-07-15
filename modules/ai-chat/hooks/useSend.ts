import { useCallback, useRef } from 'react';
import type { Chat, ContentPart, Message } from '../types';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useBrainStore } from '../store/brainStore';
import { useUIStore } from '../store/uiStore';
import { useChat, generateImage, completeText } from './useChat';
import { useVaultSearch } from './useVaultSearch';
import { useLinkedContext } from './useLinkedContext';
import { isImageRequest } from '../lib/suggestModel';
import { api } from '../lib/bridge';

// Cap how much raw chat history we send each turn — bounds cost and avoids
// context-window overflow on long chats. System/context messages are added
// on top of this and are not counted here.
const MAX_HISTORY_MESSAGES = 24;

function makeMessage(chatId: string, role: Message['role'], content: ContentPart[]): Message {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chatId,
    role,
    content,
    createdAt: Date.now(),
  };
}

function trimHistory(history: Message[]): Message[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history;
  return history.slice(history.length - MAX_HISTORY_MESSAGES);
}

// Strip the junk models tend to wrap a generated title in (quotes, a "Title:"
// preface, markdown, trailing punctuation, stray newlines).
function cleanTitle(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*(?:chat\s+)?title\s*[:\-–]\s*/i, '')
    .replace(/^["'`*“”]+|["'`*“”]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
}

export function useSend() {
  const { sendMessage, stop, isStreaming } = useChat();
  const { buildBrainContext } = useVaultSearch();
  const { buildLinkedContext } = useLinkedContext();

  const settings = useSettingsStore((s) => s.settings);
  const chats = useChatStore((s) => s.chats);
  const messages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateLastAssistant = useChatStore((s) => s.updateLastAssistant);
  const renameChat = useChatStore((s) => s.renameChat);
  const brainEnabled = useChatStore((s) => s.brainEnabled);
  const setActiveContext = useBrainStore((s) => s.setActiveContext);
  const loadNotes = useBrainStore((s) => s.loadNotes);
  const toast = useUIStore((s) => s.toast);

  // Throttle React state updates while streaming.
  const bufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build the leading system/context messages: per-chat system prompt, then
  // Brain vault context, then linked-chat context.
  const buildContext = useCallback(
    async (chat: Chat, historyForSearch: Message[]): Promise<Message[]> => {
      const context: Message[] = [];

      if (chat.systemPrompt && chat.systemPrompt.trim()) {
        context.push(makeMessage(chat.id, 'system', [{ type: 'text', text: chat.systemPrompt }]));
      }

      // A bound agent persona ("brain") takes over context: embody the person and
      // ground answers in that persona's own vault folder, not the global Brain.
      const persona = chat.agentPersonaId
        ? (await api.agentGetPersonas()).find((p) => p.id === chat.agentPersonaId)
        : undefined;

      if (persona) {
        if (persona.systemPrompt.trim()) {
          context.push(makeMessage(chat.id, 'system', [{ type: 'text', text: persona.systemPrompt }]));
        }
        try {
          const query =
            [...historyForSearch]
              .reverse()
              .find((m) => m.role === 'user')
              ?.content.find((p) => p.type === 'text')?.text ?? persona.name;
          const docs = await api.brainFolderSearch(persona.vaultPath, query, 6);
          if (docs.length > 0) {
            const kb =
              `Knowledge base for ${persona.name} — the documents that make up this brain. Answer ` +
              `strictly grounded in them, as ${persona.name} would. If something isn't covered, say ` +
              `so rather than inventing it.\n\n` +
              docs.map((d) => `# ${d.title}\n${d.body}`).join('\n\n---\n\n');
            context.push(makeMessage(chat.id, 'system', [{ type: 'text', text: kb }]));
          }
        } catch (err) {
          console.warn('Brain persona context failed:', err);
        }
      } else if (brainEnabled[chat.id] ?? true) {
        try {
          const { systemText, injected } = await buildBrainContext(historyForSearch, settings);
          setActiveContext(chat.id, injected);
          if (systemText) {
            context.push(makeMessage(chat.id, 'system', [{ type: 'text', text: systemText }]));
          }
        } catch (err) {
          console.warn('Brain context failed:', err);
        }
      }

      try {
        const linkedText = await buildLinkedContext(chat.id, chats);
        if (linkedText) {
          context.push(makeMessage(chat.id, 'system', [{ type: 'text', text: linkedText }]));
        }
      } catch (err) {
        console.warn('Linked context failed:', err);
      }

      return context;
    },
    [brainEnabled, buildBrainContext, buildLinkedContext, chats, settings, setActiveContext]
  );

  // Stream an assistant reply for an already-assembled message array, persisting
  // it and (optionally) auto-titling the chat.
  const streamReply = useCallback(
    async (chat: Chat, assembled: Message[], autoTitleFrom?: string) => {
      const isActive = () => useChatStore.getState().activeChatId === chat.id;

      const assistantMsg: Message = {
        ...makeMessage(chat.id, 'assistant', [{ type: 'text', text: '' }]),
        provider: chat.provider,
        modelVersion: chat.modelVersion,
      };
      addMessage(assistantMsg);

      bufferRef.current = '';
      flushTimerRef.current = setInterval(() => {
        if (isActive()) updateLastAssistant([{ type: 'text', text: bufferRef.current }]);
      }, 50);

      let finalText = '';
      try {
        finalText = await sendMessage({
          provider: chat.provider,
          modelVersion: chat.modelVersion,
          settings,
          messages: assembled,
          onToken: (full) => {
            bufferRef.current = full;
          },
        });
      } catch (err) {
        finalText = bufferRef.current || `⚠️ ${(err as Error).message}`;
        toast((err as Error).message, 'error');
      } finally {
        if (flushTimerRef.current) clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const finalContent: ContentPart[] = [{ type: 'text', text: finalText }];
      if (isActive()) updateLastAssistant(finalContent);
      await api.saveMessage({
        chatId: chat.id,
        role: 'assistant',
        content: finalContent,
        provider: chat.provider,
        modelVersion: chat.modelVersion,
      });
      // Re-sync from the DB so the store holds real row ids/timestamps (needed
      // for delete / regenerate / branch to target the right rows).
      await useChatStore.getState().reloadMessages(chat.id);

      // Auto-name a brand-new chat from its first exchange (like Gemini/ChatGPT).
      // Always lands on a real title: if the model returns nothing usable, derive
      // one from the first user message instead of leaving it "New Chat".
      const needsTitle = chat.title === 'New Chat' || !chat.title;
      const seed = (autoTitleFrom ?? '').trim();
      const reply = finalText && !finalText.startsWith('⚠️') ? finalText : '';
      if (needsTitle && (seed || reply)) {
        let title = '';
        try {
          const convo = `User: ${seed.slice(0, 500)}${reply ? `\nAssistant: ${reply.slice(0, 500)}` : ''}`;
          const titlePrompt =
            `Create a short, specific title (3 to 6 words) summarizing this conversation. ` +
            `Reply with ONLY the title text — no quotes, no preface, no trailing punctuation.\n\n${convo}`;
          title = cleanTitle(
            await completeText(chat.provider, chat.modelVersion, settings, titlePrompt)
          ).slice(0, 60);
        } catch {
          title = '';
        }
        // Fallback: first few words of the user's message (or the reply).
        if (!title) {
          title = cleanTitle(seed || reply)
            .split(/\s+/)
            .slice(0, 8)
            .join(' ')
            .slice(0, 60);
        }
        if (title) await renameChat(chat.id, title);
      }

      loadNotes();
    },
    [addMessage, updateLastAssistant, sendMessage, settings, toast, renameChat, loadNotes]
  );

  // Generate an image (Imagen :predict) and post it as an assistant message;
  // surface failures as an in-chat assistant message too.
  const runImageGen = useCallback(
    async (chat: Chat, promptText: string) => {
      try {
        // Runs in the main process with the Gemini key from the shell vault.
        const { url, model } = await generateImage(chat.modelVersion, promptText);
        const content: ContentPart[] = [{ type: 'image_url', image_url: { url } }];
        addMessage({ ...makeMessage(chat.id, 'assistant', content), provider: 'gemini', modelVersion: model });
        await api.saveMessage({ chatId: chat.id, role: 'assistant', content, provider: 'gemini', modelVersion: model });
      } catch (err) {
        const msg = (err as Error).message || 'Image generation failed';
        const content: ContentPart[] = [{ type: 'text', text: `⚠️ Image generation failed: ${msg}` }];
        addMessage({ ...makeMessage(chat.id, 'assistant', content), provider: 'gemini' });
        await api.saveMessage({ chatId: chat.id, role: 'assistant', content, provider: 'gemini' });
        toast(msg, 'error');
      }
      await useChatStore.getState().reloadMessages(chat.id);
    },
    [addMessage, toast]
  );

  const send = useCallback(
    async (chat: Chat, parts: ContentPart[]) => {
      const userText = parts.find((p) => p.type === 'text')?.text ?? '';
      const store = useChatStore.getState();

      const userMsg = makeMessage(chat.id, 'user', parts);
      addMessage(userMsg);
      await api.saveMessage({ chatId: chat.id, role: 'user', content: parts });

      // Read image mode from live state (a stale snapshot was sending image
      // requests through the text endpoint and 404ing on Imagen).
      const imageMode =
        chat.provider === 'gemini' &&
        (chat.modelVersion.startsWith('imagen') || (store.imageGenMode[chat.id] ?? false));

      if (imageMode) {
        await runImageGen(chat, userText);
        return;
      }

      // If it reads like an image request, offer to generate it (in-chat Yes/No)
      // rather than replying with a text description.
      if (userText.trim() && isImageRequest(userText)) {
        store.setImageOffer(chat.id, userText);
        return;
      }

      const history = [...messages, userMsg];
      const context = await buildContext(chat, history);
      const assembled = [...context, ...trimHistory(history)];
      await streamReply(chat, assembled, userText.trim() ? userText : undefined);
    },
    [addMessage, messages, buildContext, streamReply, runImageGen]
  );

  // Re-run the model against the current history (which must end with a user
  // message). Used by regenerate / edit after trailing messages are removed.
  const regenerate = useCallback(
    async (chat: Chat) => {
      const history = useChatStore.getState().messages.filter((m) => m.role !== 'system');
      if (history.length === 0) return;
      const context = await buildContext(chat, history);
      const assembled = [...context, ...trimHistory(history)];
      // Still let a never-titled chat get named (e.g. after declining an image offer).
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      const seed = lastUser?.content.find((p) => p.type === 'text')?.text;
      await streamReply(chat, assembled, seed);
    },
    [buildContext, streamReply]
  );

  // Accept an in-chat image offer → switch to Imagen and generate.
  const confirmImageOffer = useCallback(
    async (chat: Chat, prompt: string) => {
      const store = useChatStore.getState();
      store.setImageOffer(chat.id, null);
      const model = 'gemini-2.0-flash-preview-image-generation';
      await store.setChatModel(chat.id, 'gemini', model);
      store.setImageGen(chat.id, true);
      await runImageGen({ ...chat, provider: 'gemini', modelVersion: model }, prompt);
    },
    [runImageGen]
  );

  // Decline → reply with a normal text answer to the prompt instead.
  const declineImageOffer = useCallback(
    async (chat: Chat) => {
      useChatStore.getState().setImageOffer(chat.id, null);
      await regenerate(chat);
    },
    [regenerate]
  );

  return { send, regenerate, confirmImageOffer, declineImageOffer, stop, isStreaming };
}

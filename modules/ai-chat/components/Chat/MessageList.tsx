import { useEffect, useRef } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { Message } from './Message';
import { ImageOfferBubble } from './ImageOfferBubble';

export function MessageList({ chat }: { chat: Chat }) {
  const messages = useChatStore((s) => s.messages);
  const offer = useChatStore((s) => s.pendingImageOffer[chat.id]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when near the bottom (don't yank the user up while reading).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, offer]);

  const visible = messages.filter((m) => m.role !== 'system');

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-6">
        {visible.length === 0 ? (
          <div className="mt-20 text-center text-sm text-muted">
            Send a message to start the conversation.
          </div>
        ) : (
          visible.map((m) => <Message key={m.id} message={m} chat={chat} />)
        )}
        <ImageOfferBubble chat={chat} />
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

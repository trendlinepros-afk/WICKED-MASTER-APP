import { useMemo, useState } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { suggestModel } from '../../lib/suggestModel';
import { providerColor } from '../ModelSelector/modelConfig';

// After the first user message, suggest a better-fit (non-image) model. Image
// requests are handled in-chat by the image offer, not here.
export function SuggestionBanner({ chat }: { chat: Chat }) {
  const messages = useChatStore((s) => s.messages);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const firstUser = useMemo(() => messages.find((m) => m.role === 'user'), [messages]);
  const suggestion = useMemo(
    () => (firstUser ? suggestModel(firstUser.content) : null),
    [firstUser]
  );
  const assistantCount = messages.filter((m) => m.role === 'assistant').length;

  if (!firstUser || assistantCount > 1 || !suggestion) return null;
  if (suggestion.modelVersion.startsWith('imagen')) return null; // handled in-chat
  if (suggestion.provider === chat.provider && suggestion.modelVersion === chat.modelVersion) {
    return null;
  }
  if (dismissed === chat.id) return null;

  return (
    <div className="mx-auto mt-3 flex w-full max-w-3xl items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
      <span
        className="h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: providerColor(suggestion.provider) }}
      />
      <span className="flex-1 text-ink">
        <span className="text-muted">Suggested model:</span> {suggestion.reason}
      </span>
      <button
        onClick={() => {
          setChatModel(chat.id, suggestion.provider, suggestion.modelVersion);
          setDismissed(chat.id);
        }}
        className="flex-shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90"
      >
        Switch to {suggestion.label}
      </button>
      <button
        onClick={() => setDismissed(chat.id)}
        className="flex-shrink-0 text-muted hover:text-ink"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

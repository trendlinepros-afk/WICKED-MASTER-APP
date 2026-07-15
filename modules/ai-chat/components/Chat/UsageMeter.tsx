import { useMemo } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { estimateUsage, formatCost, formatTokens } from '../../lib/pricing';

// Compact estimated token/cost indicator for the active chat.
export function UsageMeter({ chat }: { chat: Chat }) {
  const messages = useChatStore((s) => s.messages);
  const usage = useMemo(
    () => estimateUsage(messages, chat.provider, chat.modelVersion),
    [messages, chat.provider, chat.modelVersion]
  );

  if (messages.filter((m) => m.role !== 'system').length === 0) return null;

  return (
    <span
      title="Estimated tokens and cost for this chat (rough, char-based). Providers bill exactly."
      className="whitespace-nowrap text-xs text-muted"
    >
      ~{formatTokens(usage.tokens)} tok{' '}
      {usage.local ? (
        <span className="text-ok">· local</span>
      ) : usage.priced ? (
        <>· est. {formatCost(usage.cost)}</>
      ) : (
        <>· est. n/a</>
      )}
    </span>
  );
}

import { useEffect, useState } from 'react';
import { api } from '../../lib/bridge';

export function LinkedChatsBadge({ chatId }: { chatId: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    api.getChatLinks(chatId).then((ids) => setCount(ids.length));
  }, [chatId]);

  if (count === 0) return null;

  return (
    <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">
      🔗 {count} linked
    </span>
  );
}

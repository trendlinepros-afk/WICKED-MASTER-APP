import { useState } from 'react';
import type { Chat } from '../../types';
import { useChatStore } from '../../store/chatStore';
import { ChatListItem } from './ChatListItem';
import { DND_CHAT } from '../../lib/folderTree';

// Group the un-filed chats by recency so the most recent are easy to find.
function groupByRecency(chats: Chat[]): { label: string; chats: Chat[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  const today: Chat[] = [];
  const yesterday: Chat[] = [];
  const older: Chat[] = [];
  for (const c of chats) {
    if (c.updatedAt >= startOfToday) today.push(c);
    else if (c.updatedAt >= startOfYesterday) yesterday.push(c);
    else older.push(c);
  }
  return [
    { label: 'Today', chats: today },
    { label: 'Yesterday', chats: yesterday },
    { label: 'Older', chats: older },
  ].filter((g) => g.chats.length > 0);
}

export function UncategorizedList() {
  const chats = useChatStore((s) => s.chats);
  const moveChat = useChatStore((s) => s.moveChat);
  const [dragOver, setDragOver] = useState(false);

  // chats are already sorted by updatedAt DESC from the DB.
  const uncategorized = chats.filter((c) => !c.folderId);
  const groups = groupByRecency(uncategorized);

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_CHAT)) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const chatId = e.dataTransfer.getData(DND_CHAT);
        if (chatId) moveChat(chatId, null); // back to uncategorized
      }}
      className={`mb-3 rounded-md ${dragOver ? 'ring-1 ring-accent bg-accent/5' : ''}`}
    >
      {uncategorized.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted/60">No chats yet</div>
      ) : (
        groups.map((group) => (
          <div key={group.label} className="mb-2">
            <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
              {group.label}
            </div>
            <div className="space-y-0.5">
              {group.chats.map((chat) => (
                <ChatListItem key={chat.id} chat={chat} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

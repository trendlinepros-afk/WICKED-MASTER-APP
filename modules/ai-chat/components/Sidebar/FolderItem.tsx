import { useState } from 'react';
import type { Folder } from '../../types';
import { useFolderStore } from '../../store/folderStore';
import { useChatStore } from '../../store/chatStore';
import { ChatListItem } from './ChatListItem';
import { DND_CHAT, DND_FOLDER, childrenOf } from '../../lib/folderTree';

export function FolderItem({ folder, depth = 0 }: { folder: Folder; depth?: number }) {
  const expanded = useFolderStore((s) => s.expanded[folder.id] ?? false);
  const toggle = useFolderStore((s) => s.toggleExpanded);
  const setExpanded = useFolderStore((s) => s.setExpanded);
  const renameFolder = useFolderStore((s) => s.renameFolder);
  const deleteFolder = useFolderStore((s) => s.deleteFolder);
  const createFolder = useFolderStore((s) => s.createFolder);
  const moveFolder = useFolderStore((s) => s.moveFolder);
  const folders = useFolderStore((s) => s.folders);
  const chats = useChatStore((s) => s.chats);
  const moveChat = useChatStore((s) => s.moveChat);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [addingSub, setAddingSub] = useState(false);
  const [subDraft, setSubDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const subFolders = childrenOf(folders, folder.id);
  const folderChats = chats.filter((c) => c.folderId === folder.id);
  const count = folderChats.length + subFolders.length;

  const submitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== folder.name) renameFolder(folder.id, trimmed);
    setRenaming(false);
  };

  const submitSub = () => {
    const trimmed = subDraft.trim();
    if (trimmed) createFolder(trimmed, folder.id);
    setSubDraft('');
    setAddingSub(false);
  };

  // Accept a dropped chat (move into this folder) or folder (re-parent).
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const chatId = e.dataTransfer.getData(DND_CHAT);
    if (chatId) {
      moveChat(chatId, folder.id);
      setExpanded(folder.id, true);
      return;
    }
    const folderId = e.dataTransfer.getData(DND_FOLDER);
    if (folderId && folderId !== folder.id) {
      moveFolder(folderId, folder.id);
      setExpanded(folder.id, true);
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DND_CHAT) || e.dataTransfer.types.includes(DND_FOLDER)) {
      e.preventDefault();
      setDragOver(true);
    }
  };

  return (
    <div onDragOver={onDragOver} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <div
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DND_FOLDER, folder.id);
          e.dataTransfer.effectAllowed = 'move';
          e.stopPropagation();
        }}
        className={`group flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-raised ${
          dragOver ? 'ring-1 ring-accent bg-accent/10' : ''
        }`}
      >
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="w-full rounded border border-accent bg-raised px-1.5 py-0.5 text-sm outline-none"
          />
        ) : (
          <>
            <button
              onClick={() => toggle(folder.id)}
              className="flex flex-1 items-center gap-1.5 text-left text-sm text-ink"
            >
              <span className="text-muted">{expanded ? '▾' : '▸'}</span>
              <span>📁</span>
              <span className="truncate">{folder.name}</span>
              <span className="text-xs text-muted">{count || ''}</span>
            </button>
            <span
              role="button"
              title="New sub-folder"
              onClick={() => {
                setSubDraft('');
                setAddingSub(true);
                setExpanded(folder.id, true);
              }}
              className="opacity-0 transition group-hover:opacity-100 px-1 text-muted hover:text-ink"
            >
              ＋
            </span>
            <span
              role="button"
              title="Rename"
              onClick={() => {
                setDraft(folder.name);
                setRenaming(true);
              }}
              className="opacity-0 transition group-hover:opacity-100 px-1 text-muted hover:text-ink"
            >
              ✎
            </span>
            <span
              role="button"
              title="Delete folder (chats move to Uncategorized; sub-folders are removed)"
              onClick={() => deleteFolder(folder.id)}
              className="opacity-0 transition group-hover:opacity-100 px-1 text-muted hover:text-red-400"
            >
              🗑
            </span>
          </>
        )}
      </div>

      {expanded && (
        <div className="ml-4 space-y-0.5 border-l border-edge pl-2">
          {addingSub && (
            <input
              autoFocus
              value={subDraft}
              placeholder="Sub-folder name"
              onChange={(e) => setSubDraft(e.target.value)}
              onBlur={submitSub}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSub();
                if (e.key === 'Escape') setAddingSub(false);
              }}
              className="w-full rounded border border-accent bg-raised px-1.5 py-0.5 text-sm outline-none"
            />
          )}
          {subFolders.map((sub) => (
            <FolderItem key={sub.id} folder={sub} depth={depth + 1} />
          ))}
          {folderChats.map((chat) => (
            <ChatListItem key={chat.id} chat={chat} />
          ))}
          {count === 0 && !addingSub && (
            <div className="px-2 py-1 text-xs text-muted/60">Empty</div>
          )}
        </div>
      )}
    </div>
  );
}

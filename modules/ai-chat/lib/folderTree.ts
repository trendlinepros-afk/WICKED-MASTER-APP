import type { Folder } from '../types';

// drag-and-drop payload types (Chromium custom MIME types).
export const DND_CHAT = 'application/x-wicked-chat';
export const DND_FOLDER = 'application/x-wicked-folder';

export interface FolderNode {
  folder: Folder;
  depth: number;
}

// Folders whose parent is `parentId` (null = top level), in creation order.
export function childrenOf(folders: Folder[], parentId: string | null): Folder[] {
  return folders.filter((f) => (f.parentId ?? null) === parentId);
}

// Depth-first flattening of the folder tree, for the "move to folder" menu.
export function flattenFolders(folders: Folder[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of childrenOf(folders, parentId)) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

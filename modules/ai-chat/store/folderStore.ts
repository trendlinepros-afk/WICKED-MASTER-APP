import { create } from 'zustand';
import type { Folder } from '../types';
import { api } from '../lib/bridge';

interface FolderState {
  folders: Folder[];
  expanded: Record<string, boolean>;
  load: () => Promise<void>;
  createFolder: (name: string, parentId?: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, value: boolean) => void;
}

export const useFolderStore = create<FolderState>((set, get) => ({
  folders: [],
  expanded: {},
  load: async () => {
    const folders = await api.getFolders();
    set({ folders });
  },
  createFolder: async (name, parentId = null) => {
    const folder = await api.createFolder(name, parentId);
    set({
      folders: [...get().folders, folder],
      expanded: {
        ...get().expanded,
        [folder.id]: true,
        // Ensure the parent is open so the new sub-folder is visible.
        ...(parentId ? { [parentId]: true } : {}),
      },
    });
    return folder;
  },
  renameFolder: async (id, name) => {
    await api.renameFolder(id, name);
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name } : f)) });
  },
  moveFolder: async (id, parentId) => {
    // Guard against dropping a folder onto itself or one of its descendants.
    if (parentId === id) return;
    const folders = get().folders;
    const byId = new Map(folders.map((f) => [f.id, f.parentId]));
    let cursor = parentId;
    while (cursor) {
      if (cursor === id) return;
      cursor = byId.get(cursor) ?? null;
    }
    await api.moveFolder(id, parentId);
    set({ folders: folders.map((f) => (f.id === id ? { ...f, parentId } : f)) });
  },
  deleteFolder: async (id) => {
    await api.deleteFolder(id);
    // Drop the folder and any descendants from local state.
    const folders = get().folders;
    const toRemove = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && toRemove.has(f.parentId) && !toRemove.has(f.id)) {
          toRemove.add(f.id);
          grew = true;
        }
      }
    }
    set({ folders: folders.filter((f) => !toRemove.has(f.id)) });
  },
  toggleExpanded: (id) => set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  setExpanded: (id, value) => set({ expanded: { ...get().expanded, [id]: value } }),
}));

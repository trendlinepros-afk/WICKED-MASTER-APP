import { create } from 'zustand'

/** Transient shell UI state shared by the sidebar and home screen. */
interface ShellUiState {
  /** right-click context menu for a module, or null */
  menu: { id: string; x: number; y: number } | null
  /** module id currently being edited (name/description), or null */
  editing: string | null
  /** module id being dragged for reordering / filing, or null */
  dragId: string | null
  /** folder create/rename dialog state, or null */
  folderEdit: { mode: 'create'; moduleId?: string } | { mode: 'rename'; groupId: string } | null

  openMenu: (id: string, x: number, y: number) => void
  closeMenu: () => void
  openEdit: (id: string) => void
  closeEdit: () => void
  setDragId: (id: string | null) => void
  /** open the New Folder dialog; pass a module id to file it there on create */
  openFolderCreate: (moduleId?: string) => void
  openFolderRename: (groupId: string) => void
  closeFolderEdit: () => void
}

export const useShellUi = create<ShellUiState>((set) => ({
  menu: null,
  editing: null,
  dragId: null,
  folderEdit: null,
  openMenu: (id, x, y) => set({ menu: { id, x, y } }),
  closeMenu: () => set({ menu: null }),
  openEdit: (id) => set({ editing: id, menu: null }),
  closeEdit: () => set({ editing: null }),
  setDragId: (id) => set({ dragId: id }),
  openFolderCreate: (moduleId) => set({ folderEdit: { mode: 'create', moduleId }, menu: null }),
  openFolderRename: (groupId) => set({ folderEdit: { mode: 'rename', groupId }, menu: null }),
  closeFolderEdit: () => set({ folderEdit: null })
}))

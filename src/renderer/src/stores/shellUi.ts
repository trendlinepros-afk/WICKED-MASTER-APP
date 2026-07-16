import { create } from 'zustand'

/** Transient shell UI state shared by the sidebar and home screen. */
interface ShellUiState {
  /** right-click context menu for a module, or null */
  menu: { id: string; x: number; y: number } | null
  /** module id currently being edited (name/description), or null */
  editing: string | null
  /** module id being dragged for reordering, or null */
  dragId: string | null

  openMenu: (id: string, x: number, y: number) => void
  closeMenu: () => void
  openEdit: (id: string) => void
  closeEdit: () => void
  setDragId: (id: string | null) => void
}

export const useShellUi = create<ShellUiState>((set) => ({
  menu: null,
  editing: null,
  dragId: null,
  openMenu: (id, x, y) => set({ menu: { id, x, y } }),
  closeMenu: () => set({ menu: null }),
  openEdit: (id) => set({ editing: id, menu: null }),
  closeEdit: () => set({ editing: null }),
  setDragId: (id) => set({ dragId: id })
}))

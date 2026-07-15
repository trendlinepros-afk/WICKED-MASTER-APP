import { create } from 'zustand';
import type { BoardData, Project } from '../types';
import { api } from '../lib/bridge';

// The Project Board: a list of projects, each backed by a freeform canvas
// (board.json + image assets) stored in a user-mappable data folder. Edits are
// autosaved on a short debounce; switching projects or closing flushes first
// so nothing is lost.

const SAVE_DEBOUNCE_MS = 800;

interface ProjectBoardState {
  open: boolean;
  projects: Project[];
  activeProjectId: string | null;
  board: BoardData | null;
  dataFolder: string;

  setOpen: (open: boolean) => void;
  load: () => Promise<void>;
  createProject: (name: string, icon?: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  selectProject: (id: string | null) => Promise<void>;
  // Apply a mutation to the current board. `commit` (default true) schedules a
  // save — pass false for high-frequency updates mid-drag and commit on release.
  updateBoard: (mutate: (board: BoardData) => BoardData, commit?: boolean) => void;
  flushSave: () => Promise<void>;
  changeDataFolder: (folder: string, migrate: boolean) => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useProjectBoardStore = create<ProjectBoardState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flushSave(), SAVE_DEBOUNCE_MS);
  };

  return {
    open: false,
    projects: [],
    activeProjectId: null,
    board: null,
    dataFolder: '',

    setOpen: (open) => {
      if (!open) void get().flushSave();
      set({ open });
    },

    load: async () => {
      const [projects, dataFolder] = await Promise.all([
        api.pbGetProjects(),
        api.pbGetDataFolder(),
      ]);
      set({ projects, dataFolder });
      // Keep the selection when it still exists; otherwise open the first project.
      const { activeProjectId } = get();
      if (activeProjectId && !projects.some((p) => p.id === activeProjectId)) {
        await get().selectProject(projects[0]?.id ?? null);
      } else if (!activeProjectId && projects.length > 0) {
        await get().selectProject(projects[0].id);
      }
    },

    createProject: async (name, icon) => {
      const project = await api.pbCreateProject(name, icon);
      set({ projects: [...get().projects, project] });
      await get().selectProject(project.id);
    },

    renameProject: async (id, name) => {
      await api.pbRenameProject(id, name);
      set({ projects: get().projects.map((p) => (p.id === id ? { ...p, name } : p)) });
    },

    deleteProject: async (id) => {
      if (get().activeProjectId === id) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        set({ activeProjectId: null, board: null });
      }
      await api.pbDeleteProject(id);
      const projects = get().projects.filter((p) => p.id !== id);
      set({ projects });
      if (!get().activeProjectId && projects.length > 0) {
        await get().selectProject(projects[0].id);
      }
    },

    selectProject: async (id) => {
      await get().flushSave();
      if (!id) {
        set({ activeProjectId: null, board: null });
        return;
      }
      set({ activeProjectId: id, board: null });
      const board = await api.pbLoadBoard(id);
      // Ignore the result if the user already switched away again.
      if (get().activeProjectId === id) set({ board });
    },

    updateBoard: (mutate, commit = true) => {
      const { board } = get();
      if (!board) return;
      set({ board: mutate(board) });
      if (commit) scheduleSave();
    },

    flushSave: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { activeProjectId, board } = get();
      if (!activeProjectId || !board) return;
      await api.pbSaveBoard(activeProjectId, { ...board, updatedAt: Date.now() });
    },

    changeDataFolder: async (folder, migrate) => {
      await get().flushSave();
      await api.pbSetDataFolder(folder, migrate);
      set({ activeProjectId: null, board: null });
      await get().load();
    },
  };
});

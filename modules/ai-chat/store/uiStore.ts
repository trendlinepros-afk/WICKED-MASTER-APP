import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface UIState {
  toasts: Toast[];
  settingsOpen: boolean;
  mobileNavOpen: boolean; // the main sidebar drawer on small screens
  toast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
  setSettingsOpen: (open: boolean) => void;
  setMobileNavOpen: (open: boolean) => void;
}

let counter = 0;

export const useUIStore = create<UIState>((set, get) => ({
  toasts: [],
  settingsOpen: false,
  mobileNavOpen: false,
  toast: (message, kind = 'info') => {
    const id = ++counter;
    set({ toasts: [...get().toasts, { id, message, kind }] });
    setTimeout(() => get().dismissToast(id), 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
}));

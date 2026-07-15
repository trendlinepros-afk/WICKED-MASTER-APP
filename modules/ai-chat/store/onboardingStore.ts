import { create } from 'zustand';

const STORAGE_KEY = 'wicked-onboarded';

interface OnboardingState {
  open: boolean;
  init: () => void; // show automatically on first launch
  start: () => void; // replay from Settings
  finish: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  open: false,
  init: () => {
    let done = false;
    try {
      done = localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      /* ignore */
    }
    if (!done) set({ open: true });
  },
  start: () => set({ open: true }),
  finish: () => {
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      /* ignore */
    }
    set({ open: false });
  },
}));

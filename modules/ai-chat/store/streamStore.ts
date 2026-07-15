import { create } from 'zustand';

// Shared streaming state + a single abort controller, so every component
// (the input box and per-message regenerate/edit) reflects one stream and the
// Stop button can abort whichever request is in flight.
interface StreamState {
  isStreaming: boolean;
  setStreaming: (v: boolean) => void;
}

export const useStreamStore = create<StreamState>((set) => ({
  isStreaming: false,
  setStreaming: (v) => set({ isStreaming: v }),
}));

let currentAbort: AbortController | null = null;

export function beginStream(): AbortController {
  currentAbort?.abort();
  currentAbort = new AbortController();
  useStreamStore.getState().setStreaming(true);
  return currentAbort;
}

export function endStream(controller: AbortController): void {
  if (currentAbort === controller) {
    currentAbort = null;
    useStreamStore.getState().setStreaming(false);
  }
}

export function abortCurrentStream(): void {
  currentAbort?.abort();
  currentAbort = null;
  useStreamStore.getState().setStreaming(false);
}

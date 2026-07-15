import { create } from 'zustand';
import { SHELL_IPC } from '@shared/types';
import type { ApiKeyStatus } from '../types';
import { api } from '../lib/bridge';

/**
 * Presence booleans for the shell's central API key vault (Settings → API
 * Keys). Key VALUES never reach the renderer — this store only knows whether a
 * provider key is set, for UI gating ("voice needs an OpenAI key…").
 *
 * On the desktop the shell broadcasts SHELL_IPC.apiKeysChanged after any
 * change; in the LAN portal (no push events) we just load once. The status
 * itself comes from the module's own mirrored channel so the portal can serve
 * it too.
 */
interface KeysState {
  status: ApiKeyStatus;
  loaded: boolean;
  load: () => Promise<void>;
  /** subscribe to shell "keys changed" pushes; returns an unsubscribe fn */
  listen: () => () => void;
}

export const useKeysStore = create<KeysState>((set) => ({
  status: {},
  loaded: false,
  load: async () => {
    try {
      set({ status: await api.apiKeysStatus(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  listen: () =>
    window.wicked.on(SHELL_IPC.apiKeysChanged, (...args: unknown[]) => {
      const status = args[0] as ApiKeyStatus | undefined;
      if (status && typeof status === 'object') set({ status, loaded: true });
    }),
}));

/** Convenience selector: is a provider's key present in the shell vault? */
export function hasApiKey(provider: string): boolean {
  return useKeysStore.getState().status[provider] === true;
}

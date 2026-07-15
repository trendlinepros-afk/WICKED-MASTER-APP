import { create } from 'zustand';
import type { Settings } from '../types';
import { api } from '../lib/bridge';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (partial: Partial<Settings>) => Promise<void>;
}

const EMPTY: Settings = {
  vaultPath: '',
  defaultProvider: 'openai',
  defaultModelVersion: 'gpt-4o',
  semanticIndexingEnabled: true,
  ollamaBaseUrl: 'http://localhost:11434',
  autoMemoryEnabled: false,
  autoMemoryIntervalMinutes: 30,
  projectBoardPath: '',
  // Port note: the LAN portal ships OFF by default inside the WICKED suite.
  webPortalEnabled: false,
  webPortalPort: 8967,
  sttModel: 'gpt-4o-mini-transcribe',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'alloy',
  dataRootPath: '',
  comfyUrl: 'http://127.0.0.1:8188',
  comfyCheckpoint: '',
  comfyModelFamily: '',
  comfyWorkflow: '',
  comfyLaunchPath: '',
  fluxGymPath: '',
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: EMPTY,
  loaded: false,
  load: async () => {
    const settings = await api.getSettings();
    set({ settings, loaded: true });
  },
  save: async (partial) => {
    await api.saveSettings(partial);
    set({ settings: { ...get().settings, ...partial } });
  },
}));

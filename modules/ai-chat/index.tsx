import { useEffect } from 'react';
import './styles.css';
import { Sidebar } from './components/Sidebar/Sidebar';
import { ChatWindow } from './components/Chat/ChatWindow';
import { BrainPanel } from './components/Brain/BrainPanel';
import { SettingsModal } from './components/Settings/SettingsModal';
import { ProjectBoardApp } from './components/ProjectBoard/ProjectBoardApp';
import { useProjectBoardStore } from './store/projectBoardStore';
import { AgentPersonaModal } from './components/Persona/AgentPersonaModal';
import { OnboardingModal } from './components/Onboarding/OnboardingModal';
import { Toaster } from './components/Toaster';
import { useSettingsStore } from './store/settingsStore';
import { useChatStore } from './store/chatStore';
import { useFolderStore } from './store/folderStore';
import { useBrainStore } from './store/brainStore';
import { useUIStore } from './store/uiStore';
import { useKeysStore } from './store/keysStore';
import { useOnboardingStore } from './store/onboardingStore';
import { useAgentStore } from './store/agentStore';
import { useAutoMemory } from './hooks/useAutoMemory';

/**
 * Wicked AI Chat — module entry (port of the standalone app's App.tsx).
 *
 * Port notes:
 *  - The standalone theme store/toggle is gone; the shell owns light/dark
 *    (Tailwind `dark:` + the shell tokens the palette was remapped to).
 *  - The updater UI (UpdateChecker) is gone; the shell owns updates.
 *  - Global key handlers (Ctrl+B brain panel, Esc closes settings) bind on
 *    mount and unbind on unmount, so they only exist while this module is the
 *    active route.
 */
export default function AiChat(): React.JSX.Element {
  const loadSettings = useSettingsStore((s) => s.load);
  const loadChats = useChatStore((s) => s.loadChats);
  const loadFolders = useFolderStore((s) => s.load);
  const loadNotes = useBrainStore((s) => s.loadNotes);
  const loadPersonas = useAgentStore((s) => s.load);
  const personasOpen = useAgentStore((s) => s.managerOpen);
  const setPersonasOpen = useAgentStore((s) => s.setManagerOpen);
  const toggleBrainPanel = useBrainStore((s) => s.togglePanel);
  const panelOpen = useBrainStore((s) => s.panelOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const projectBoardOpen = useProjectBoardStore((s) => s.open);
  const loadKeys = useKeysStore((s) => s.load);
  const listenKeys = useKeysStore((s) => s.listen);
  const initOnboarding = useOnboardingStore((s) => s.init);

  // Scheduled auto-commit of chats to the memory vault.
  useAutoMemory();

  useEffect(() => {
    initOnboarding();
    void loadKeys();
    loadSettings();
    loadChats();
    loadFolders();
    loadNotes();
    loadPersonas();
    // Central key vault presence updates (shell Settings → API Keys).
    return listenKeys();
  }, [
    initOnboarding,
    loadKeys,
    listenKeys,
    loadSettings,
    loadChats,
    loadFolders,
    loadNotes,
    loadPersonas,
  ]);

  // Module-scoped keyboard shortcuts — added on mount, removed on unmount so
  // they never leak into other WICKED modules.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBrainPanel();
      }
      if (e.key === 'Escape') {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleBrainPanel, setSettingsOpen]);

  return (
    <div className="ai-chat-root flex h-full w-full overflow-hidden bg-bg text-ink">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatWindow />
      </main>
      {panelOpen && <BrainPanel />}
      <SettingsModal />
      {projectBoardOpen && <ProjectBoardApp />}
      {personasOpen && <AgentPersonaModal onClose={() => setPersonasOpen(false)} />}
      <OnboardingModal />
      <Toaster />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { UncategorizedList } from './UncategorizedList';
import { FolderList } from './FolderList';
import { NewChatButton } from './NewChatButton';
import { NewFolderButton } from './NewFolderButton';
import { GlobalSearch } from './GlobalSearch';
import { RecycleBinModal } from './RecycleBinModal';
import { useBrainStore } from '../../store/brainStore';
import { useUIStore } from '../../store/uiStore';
import { useAgentStore } from '../../store/agentStore';
import { useProjectBoardStore } from '../../store/projectBoardStore';
import { useChatStore } from '../../store/chatStore';

export function Sidebar() {
  const toggleBrain = useBrainStore((s) => s.togglePanel);
  const openProjectBoard = useProjectBoardStore((s) => s.setOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const openPersonas = useAgentStore((s) => s.setManagerOpen);
  const mobileNavOpen = useUIStore((s) => s.mobileNavOpen);
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const [binOpen, setBinOpen] = useState(false);

  // On phones the sidebar is a drawer — close it once a chat is picked.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeChatId, setMobileNavOpen]);

  return (
    <>
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-edge bg-surface transition-transform duration-200 md:static md:h-full md:flex-shrink-0 md:translate-x-0 ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      <div className="flex items-center justify-between px-4 py-3.5">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span>🔮</span>
          <span>WICKED</span>
        </h1>
        <button
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          className="rounded p-1.5 text-muted hover:bg-raised hover:text-ink"
        >
          ⚙️
        </button>
      </div>

      <div className="space-y-2 px-3">
        <NewChatButton />
        <button
          onClick={() => openPersonas(true)}
          className="flex w-full items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:bg-raised hover:text-ink"
        >
          🧠 Personas
        </button>
        <GlobalSearch />
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-2">
        <FolderList />
        <UncategorizedList />
      </div>

      <div className="border-t border-edge px-3 py-2.5">
        <NewFolderButton />
        <div className="mt-2 flex gap-2">
          <button
            onClick={toggleBrain}
            className="flex flex-1 items-center justify-between rounded-lg px-3 py-2 text-sm text-warn hover:bg-warn/10"
          >
            <span className="flex items-center gap-2">🧠 Brain Panel</span>
            <span>→</span>
          </button>
          <button
            onClick={() => setBinOpen(true)}
            title="Recycle bin"
            className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-raised hover:text-ink"
          >
            🗑
          </button>
        </div>
        <button
          onClick={() => openProjectBoard(true)}
          className="mt-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-accent hover:bg-accent/10"
        >
          <span className="flex items-center gap-2">📋 Project Board</span>
          <span>→</span>
        </button>
      </div>

        {binOpen && <RecycleBinModal onClose={() => setBinOpen(false)} />}
      </aside>
    </>
  );
}

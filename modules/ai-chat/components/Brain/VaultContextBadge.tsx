import { useBrainStore } from '../../store/brainStore';
import type { InjectedNote } from '../../store/brainStore';

const EMPTY: InjectedNote[] = [];

export function VaultContextBadge({ chatId }: { chatId: string }) {
  // Select the raw value (default to a STABLE empty array) — returning a fresh
  // `[]` from the selector would change the snapshot every render and loop.
  const injected = useBrainStore((s) => s.activeContext[chatId] ?? EMPTY);
  const openPanel = useBrainStore((s) => s.setPanelOpen);

  if (injected.length === 0) return null;

  return (
    <button
      onClick={() => openPanel(true)}
      title={injected.map((n) => n.title).join(', ')}
      className="flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn hover:bg-warn/25"
    >
      🧠 {injected.length} {injected.length === 1 ? 'note' : 'notes'} injected
    </button>
  );
}

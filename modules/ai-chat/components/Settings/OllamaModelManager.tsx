import { useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  OLLAMA_CATALOG,
  listOllamaModels,
  pullOllamaModel,
  type CatalogModel,
} from '../../lib/ollama';

// Browse the curated catalog, see what's installed, download models with
// progress, and pull arbitrary models by name.
export function OllamaModelManager({
  baseUrl,
  onClose,
  onSelect,
}: {
  baseUrl: string;
  onClose: () => void;
  onSelect?: (model: string) => void;
}) {
  const toast = useUIStore((s) => s.toast);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Record<string, { frac: number; status: string }>>({});
  const [customName, setCustomName] = useState('');

  const refresh = () =>
    listOllamaModels(baseUrl).then((models) =>
      setInstalled(new Set(models.map((m) => m.id)))
    );

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  const isInstalled = (id: string) =>
    installed.has(id) || installed.has(`${id}:latest`) || [...installed].some((m) => m.startsWith(`${id}:`));

  const download = async (id: string) => {
    setProgress((p) => ({ ...p, [id]: { frac: 0, status: 'starting' } }));
    try {
      await pullOllamaModel(baseUrl, id, (frac, status) =>
        setProgress((p) => ({ ...p, [id]: { frac, status } }))
      );
      toast(`Downloaded ${id}`, 'success');
      await refresh();
    } catch (err) {
      toast(`Download failed: ${(err as Error).message}`, 'error');
    } finally {
      setProgress((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  };

  const row = (m: CatalogModel) => {
    const prog = progress[m.id];
    const installedNow = isInstalled(m.id);
    return (
      <div key={m.id} className="rounded-lg border border-edge bg-raised p-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink">{m.label}</span>
          <span className="text-xs text-muted">{m.size}</span>
          <div className="flex-1" />
          {installedNow ? (
            <>
              <span className="text-xs text-ok">✓ Installed</span>
              {onSelect && (
                <button
                  onClick={() => onSelect(m.id)}
                  className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent/90"
                >
                  Use
                </button>
              )}
            </>
          ) : prog ? (
            <span className="text-xs text-muted">
              {prog.status} {prog.frac > 0 ? `${Math.round(prog.frac * 100)}%` : ''}
            </span>
          ) : (
            <button
              onClick={() => download(m.id)}
              className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-ink"
            >
              ⤓ Download
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">{m.goodAt}</p>
        {prog && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-edge">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.round(prog.frac * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">🦙 Ollama Models</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4">
          {OLLAMA_CATALOG.map(row)}

          <div className="mt-3 flex gap-2 border-t border-edge pt-3">
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Pull any model by name (e.g. llama3.1:70b)"
              className="flex-1 rounded-md border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={() => {
                if (customName.trim()) download(customName.trim());
                setCustomName('');
              }}
              disabled={!customName.trim()}
              className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
            >
              ⤓ Pull
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

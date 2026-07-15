import { useEffect, useState } from 'react';
import type { Chat, Provider } from '../../types';
import { MODEL_CONFIG, PROVIDERS, defaultVersionFor, type ModelVersion } from './modelConfig';
import { useChatStore } from '../../store/chatStore';
import { useBrainStore } from '../../store/brainStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useKeysStore } from '../../store/keysStore';
import { listOllamaModels, listRunningOllamaModels, setOllamaLoaded } from '../../lib/ollama';
import { listChatModels, listImageModels } from '../../lib/models';
import { useUIStore } from '../../store/uiStore';

export function ModelSelector({ chat }: { chat: Chat }) {
  const setChatModel = useChatStore((s) => s.setChatModel);
  const brainEnabled = useChatStore((s) => s.brainEnabled[chat.id] ?? true);
  const toggleBrain = useChatStore((s) => s.toggleBrain);
  const imageGen = useChatStore((s) => s.imageGenMode[chat.id] ?? false);
  const setImageGen = useChatStore((s) => s.setImageGen);
  const togglePanel = useBrainStore((s) => s.togglePanel);
  const settings = useSettingsStore((s) => s.settings);
  const keyStatus = useKeysStore((s) => s.status);
  const hasGeminiKey = keyStatus['gemini'] === true;
  const ollamaBaseUrl = settings.ollamaBaseUrl;
  const toast = useUIStore((s) => s.toast);
  const [ollamaModels, setOllamaModels] = useState<ModelVersion[]>([]);
  const [liveModels, setLiveModels] = useState<ModelVersion[]>([]);
  const [liveImageModels, setLiveImageModels] = useState<ModelVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadingBusy, setLoadingBusy] = useState(false);

  const cfg = MODEL_CONFIG[chat.provider];

  // For API providers, list the models the key can actually call (so new
  // models appear automatically). Falls back to the hardcoded defaults on error.
  useEffect(() => {
    if (chat.provider === 'ollama') return;
    setLiveModels([]);
    setLiveImageModels([]);
    let cancelled = false;
    listChatModels(chat.provider)
      .then((models) => {
        if (!cancelled && models.length > 0) setLiveModels(models);
      })
      .catch(() => {});
    if (chat.provider === 'gemini' && hasGeminiKey) {
      listImageModels()
        .then((models) => {
          if (!cancelled && models.length > 0) setLiveImageModels(models);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.provider, keyStatus]);

  // For Ollama, list the models actually installed on the local server.
  useEffect(() => {
    if (chat.provider !== 'ollama') return;
    let cancelled = false;
    listOllamaModels(ollamaBaseUrl).then((models) => {
      if (!cancelled && models.length > 0) setOllamaModels(models);
    });
    return () => {
      cancelled = true;
    };
  }, [chat.provider, ollamaBaseUrl]);

  // Track whether the selected Ollama model is currently resident in memory.
  useEffect(() => {
    if (chat.provider !== 'ollama') return;
    let cancelled = false;
    const check = () =>
      listRunningOllamaModels(ollamaBaseUrl).then((running) => {
        if (!cancelled)
          setLoaded(running.some((m) => m === chat.modelVersion || m.startsWith(`${chat.modelVersion}:`)));
      });
    check();
    const t = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [chat.provider, chat.modelVersion, ollamaBaseUrl]);

  const toggleLoaded = async () => {
    setLoadingBusy(true);
    try {
      await setOllamaLoaded(ollamaBaseUrl, chat.modelVersion, !loaded);
      setLoaded(!loaded);
      toast(!loaded ? `Loaded ${chat.modelVersion}` : `Unloaded ${chat.modelVersion}`, 'success');
    } catch (err) {
      toast(`Ollama: ${(err as Error).message}`, 'error');
    } finally {
      setLoadingBusy(false);
    }
  };

  const onProvider = (provider: Provider) => {
    const version = defaultVersionFor(provider);
    setChatModel(chat.id, provider, version);
    // Always reset image-gen on a provider switch — defaultVersionFor returns a
    // text model, so leaving imageGen on would mismatch the selected model.
    setImageGen(chat.id, false);
  };

  const baseVersions =
    chat.provider === 'ollama'
      ? ollamaModels.length > 0
        ? ollamaModels
        : cfg.versions
      : liveModels.length > 0
        ? liveModels
        : cfg.versions;
  const imageVersions =
    liveImageModels.length > 0 ? liveImageModels : cfg.imageGenVersions ?? [];
  const versions = imageGen && imageVersions.length > 0 ? imageVersions : baseVersions;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-edge bg-surface px-4 py-2 text-sm">
      {/* Provider pill */}
      <div className="relative">
        <select
          value={chat.provider}
          onChange={(e) => onProvider(e.target.value as Provider)}
          className="cursor-pointer appearance-none rounded-full px-3 py-1 pr-7 font-medium text-white outline-none"
          style={{ backgroundColor: cfg.color }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p} className="bg-surface text-ink">
              {MODEL_CONFIG[p].label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-white">
          ▾
        </span>
      </div>

      {/* Version dropdown */}
      <select
        value={chat.modelVersion}
        onChange={(e) => setChatModel(chat.id, chat.provider, e.target.value)}
        className="cursor-pointer rounded-lg border border-edge bg-raised px-3 py-1 outline-none focus:border-accent"
      >
        {(versions.some((v) => v.id === chat.modelVersion)
          ? versions
          : [{ id: chat.modelVersion, label: chat.modelVersion }, ...versions]
        ).map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>

      {/* Ollama load/unload toggle */}
      {chat.provider === 'ollama' && (
        <button
          onClick={toggleLoaded}
          disabled={loadingBusy}
          title={loaded ? 'Model is resident in memory — click to unload' : 'Load model into memory'}
          className={`rounded-lg px-3 py-1 transition disabled:opacity-50 ${
            loaded
              ? 'bg-ok/20 text-ok ring-1 ring-ok/40'
              : 'border border-edge text-muted hover:text-ink'
          }`}
        >
          {loadingBusy ? '…' : loaded ? '⏏ Loaded' : '▶ Load'}
        </button>
      )}

      <div className="flex-1" />

      {/* Image Gen toggle — Gemini only */}
      {chat.provider === 'gemini' && (
        <button
          onClick={() => {
            const next = !imageGen;
            setImageGen(chat.id, next);
            const ver = next
              ? imageVersions[0]?.id ?? cfg.imageGenVersions![0].id
              : defaultVersionFor('gemini');
            setChatModel(chat.id, 'gemini', ver);
          }}
          className={`rounded-lg px-3 py-1 transition ${
            imageGen
              ? 'bg-blue-500 text-white'
              : 'border border-edge text-muted hover:text-ink'
          }`}
        >
          🎨 Image Gen
        </button>
      )}

      {/* Brain toggle */}
      <button
        onClick={() => toggleBrain(chat.id)}
        onDoubleClick={togglePanel}
        title="Toggle Master Brain context (double-click to open panel)"
        className={`rounded-lg px-3 py-1 font-medium transition ${
          brainEnabled
            ? 'bg-warn/20 text-warn animate-brain-pulse ring-1 ring-warn/50'
            : 'border border-edge text-muted hover:text-ink'
        }`}
      >
        🧠 Brain {brainEnabled ? 'ON' : 'OFF'}
      </button>
      {/* Port note: the standalone light/dark toggle sat here — the WICKED shell owns the theme now. */}
    </div>
  );
}

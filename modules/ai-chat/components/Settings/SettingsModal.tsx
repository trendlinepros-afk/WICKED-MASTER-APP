import { useEffect, useState } from 'react';
import type { DataLocations, PortalStatus, Provider, Settings } from '../../types';
import { useSettingsStore } from '../../store/settingsStore';
import { useKeysStore } from '../../store/keysStore';
import { useUIStore } from '../../store/uiStore';
import { useOnboardingStore } from '../../store/onboardingStore';
import { MODEL_CONFIG, PROVIDERS, defaultVersionFor } from '../ModelSelector/modelConfig';
import { McpServerSettings } from './McpServerSettings';
import { TTS_VOICES } from '../../lib/voice';
import { OllamaModelManager } from './OllamaModelManager';
import { listOllamaModels } from '../../lib/ollama';
import { api } from '../../lib/bridge';

export function SettingsModal() {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const toast = useUIStore((s) => s.toast);
  const settings = useSettingsStore((s) => s.settings);
  const save = useSettingsStore((s) => s.save);
  const startOnboarding = useOnboardingStore((s) => s.start);

  const [draft, setDraft] = useState<Settings>(settings);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  if (!open) return null;

  const update = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  const onSave = async () => {
    await save(draft);
    toast('Settings saved', 'success');
    setOpen(false);
  };

  const pickVault = async () => {
    const path = await api.openVaultFolderDialog();
    if (path) update({ vaultPath: path });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 className="font-semibold">⚙️ Settings</h2>
          <button onClick={() => setOpen(false)} className="text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
          {/* API keys live in the shell's central vault — presence only here. */}
          <Section title="API Keys">
            <ApiKeysStatusView />
          </Section>

          {/* Memory (Obsidian) */}
          <Section title="Memory (Obsidian vault)">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={draft.vaultPath || 'No memory — running without a vault'}
                className="flex-1 truncate rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-muted"
              />
              <button
                onClick={pickVault}
                className="rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90"
              >
                {draft.vaultPath ? 'Change…' : 'Choose vault folder'}
              </button>
              {draft.vaultPath && (
                <button
                  onClick={() => update({ vaultPath: '' })}
                  title="Turn memory off"
                  className="rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-ink"
                >
                  Disable
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              Memory is stored as markdown notes inside an <strong>Obsidian vault</strong> (a{' '}
              <code>WickedBrain/</code> folder is created in it). Choose your Obsidian vault folder to
              enable memory, or leave it unset to use WICKED without any long-term memory. New to
              Obsidian? Install it from{' '}
              <button
                className="text-accent underline"
                onClick={() => api.openExternal('https://obsidian.md')}
              >
                obsidian.md
              </button>
              , create a vault, then point WICKED at that folder.
            </p>
          </Section>

          {/* Defaults */}
          <Section title="Defaults">
            <div className="flex gap-2">
              <select
                value={draft.defaultProvider}
                onChange={(e) => {
                  const provider = e.target.value as Provider;
                  update({
                    defaultProvider: provider,
                    defaultModelVersion: defaultVersionFor(provider),
                  });
                }}
                className="flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {MODEL_CONFIG[p].label}
                  </option>
                ))}
              </select>
              <select
                value={draft.defaultModelVersion}
                onChange={(e) => update({ defaultModelVersion: e.target.value })}
                className="flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
              >
                {MODEL_CONFIG[draft.defaultProvider].versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          </Section>

          {/* Brain */}
          <Section title="Brain">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.semanticIndexingEnabled}
                onChange={(e) => update({ semanticIndexingEnabled: e.target.checked })}
                className="accent-warn"
              />
              Enable semantic indexing (requires an OpenAI key for embeddings)
            </label>
            <p className="mt-1 text-xs text-muted">
              When off, the Brain uses keyword search only — useful if you have no OpenAI key.
            </p>
          </Section>

          {/* Scheduled memory */}
          <Section title="Scheduled memory">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.autoMemoryEnabled}
                onChange={(e) => update({ autoMemoryEnabled: e.target.checked })}
                className="accent-warn"
              />
              Automatically commit chats to memory on a schedule
            </label>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-muted">Run every</span>
              <select
                value={draft.autoMemoryIntervalMinutes}
                onChange={(e) => update({ autoMemoryIntervalMinutes: Number(e.target.value) })}
                disabled={!draft.autoMemoryEnabled}
                className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-50"
              >
                {[15, 30, 60, 120, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-1 text-xs text-muted">
              Saves every chat with new activity to your vault (updating existing notes in place),
              and re-saves previously-stored chats that gained new messages. Chats marked
              <strong> “Don't save to memory” </strong> in their header are skipped. Requires a vault
              and an API key for each chat's model.
            </p>
          </Section>

          {/* Ollama (local LLM) */}
          <Section title="Ollama (local LLM)">
            <div className="flex items-center gap-2">
              <input
                value={draft.ollamaBaseUrl}
                onChange={(e) => update({ ollamaBaseUrl: e.target.value })}
                placeholder="http://localhost:11434"
                className="flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={async () => {
                  const models = await listOllamaModels(draft.ollamaBaseUrl);
                  if (models.length > 0)
                    toast(`Ollama reachable — ${models.length} model(s) installed`, 'success');
                  else toast('No Ollama server reachable at that URL', 'error');
                }}
                className="rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-ink"
              >
                Test
              </button>
              <button
                onClick={() => setManagerOpen(true)}
                className="rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90"
              >
                Manage models
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">
              Run models locally with no API key or usage cost. Install{' '}
              <button
                className="text-accent underline"
                onClick={() => api.openExternal('https://ollama.com')}
              >
                Ollama
              </button>
              , then pick <strong>Ollama (local)</strong> in the model bar — your installed models
              load automatically.
            </p>
          </Section>

          {/* Voice (dictation, calls, read-aloud) */}
          <Section title="Voice">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm text-muted">Voice</label>
              <select
                value={draft.ttsVoice}
                onChange={(e) => update({ ttsVoice: e.target.value })}
                className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
              >
                {TTS_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <label className="ml-2 text-sm text-muted">Speech</label>
              <select
                value={draft.ttsModel}
                onChange={(e) => update({ ttsModel: e.target.value })}
                className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="gpt-4o-mini-tts">gpt-4o-mini-tts (best)</option>
                <option value="tts-1">tts-1 (fastest)</option>
                <option value="tts-1-hd">tts-1-hd</option>
              </select>
              <label className="ml-2 text-sm text-muted">Hearing</label>
              <select
                value={draft.sttModel}
                onChange={(e) => update({ sttModel: e.target.value })}
                className="rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
              >
                <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe (best)</option>
                <option value="gpt-4o-transcribe">gpt-4o-transcribe</option>
                <option value="whisper-1">whisper-1</option>
              </select>
            </div>
            <p className="mt-1 text-xs text-muted">
              Powers the 🎤 dictation and 📱 voice-call buttons in the chat input and the 🔊 Speak
              button under messages. Uses your OpenAI API key (a few cents per hour of talking).
            </p>
          </Section>

          {/* Web portal (LAN browser access) — OFF by default in the suite */}
          <Section title="Web portal (browser access)">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.webPortalEnabled}
                onChange={(e) => update({ webPortalEnabled: e.target.checked })}
              />
              Serve the AI chat to browsers on your local network while WICKED is running (off by
              default)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.webPortalPort}
                onChange={(e) => update({ webPortalPort: Number(e.target.value) || 0 })}
                className="w-28 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">Changes apply when you save.</span>
            </div>
            <PortalStatusView />
            <p className="mt-1 text-xs text-muted">
              Anyone with the link (it includes an access token) can use the AI chat and its data,
              so only open it on devices you trust. API keys themselves never leave this PC — the
              portal proxies model calls through the desktop app. If another device can't connect,
              allow WICKED through Windows Defender Firewall when prompted.
            </p>
          </Section>

          {/* Data root & backups */}
          <Section title="Data & backup">
            <DataRootView />
          </Section>

          {/* MCP servers */}
          <Section title="MCP Servers (tool use)">
            <McpServerSettings />
          </Section>

          {/* Help */}
          <Section title="Help">
            <button
              onClick={() => {
                setOpen(false);
                startOnboarding();
              }}
              className="rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-ink"
            >
              ▶ Replay welcome tour
            </button>
          </Section>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-5 py-3">
          <button
            onClick={() => setOpen(false)}
            className="rounded-lg border border-edge px-4 py-2 text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Save
          </button>
        </div>
      </div>

      {managerOpen && (
        <OllamaModelManager baseUrl={draft.ollamaBaseUrl} onClose={() => setManagerOpen(false)} />
      )}
    </div>
  );
}

// Every place the app stores data, plus one-click consolidation of all
// file-based stores into a single root (e.g. a network share for backup).
function DataRootView() {
  const toast = useUIStore((s) => s.toast);
  const load = useSettingsStore((s) => s.load);
  const [loc, setLoc] = useState<DataLocations | null>(null);
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api.dataGetLocations().then((l) => {
      setLoc(l);
      setRoot((r) => r || l.dataRootPath);
    });
  useEffect(() => {
    refresh();
  }, []);

  const consolidate = async () => {
    const target = root.trim();
    if (!target) return;
    if (
      !window.confirm(
        `Copy the Obsidian vault and Project Boards into:\n\n${target}\n\nOriginals are left in place, and database backups start going there. Continue?`
      )
    )
      return;
    setBusy(true);
    try {
      const actions = await api.dataConsolidate(target);
      toast('Data consolidated — see Settings for new locations', 'success');
      window.alert(`Done:\n\n• ${actions.join('\n• ')}`);
      await load();
      await refresh();
    } catch (err) {
      toast(`Consolidation failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string) => (
    <div className="flex gap-2 text-xs">
      <span className="w-32 flex-shrink-0 text-muted">{label}</span>
      <span className="break-all font-mono">{value || '—'}</span>
    </div>
  );

  return (
    <div className="space-y-2">
      {loc && (
        <div className="space-y-1 rounded-lg border border-edge bg-raised px-3 py-2">
          {row('Chat database', loc.dbPath + ' (local)')}
          {row('Obsidian vault', loc.vaultPath)}
          {row('Project Boards', loc.projectBoardPath)}
          {row(
            'Last DB backup',
            loc.lastBackupAt ? new Date(loc.lastBackupAt).toLocaleString() : 'never'
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder={'\\\\server\\share\\Wicked AI Desktop APP'}
          className="flex-1 rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
        <button
          onClick={consolidate}
          disabled={busy || !root.trim()}
          className="rounded-lg bg-accent px-3 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {busy ? 'Copying…' : 'Consolidate here'}
        </button>
      </div>
      <p className="text-xs text-muted">
        Moves all file-based data (vaults, boards) under one folder — point it at a network share
        and everything is in one backed-up place. The live chat database stays on this PC (SQLite
        corrupts on network drives) but a copy is written to the share's <code>Backups</code>{' '}
        folder on every launch and every 6 hours. After consolidating, re-open the vault in
        Obsidian from its new location.
      </p>
    </div>
  );
}


// Live state of the LAN web portal: whether it's serving and the link(s) to
// open on another device. Reflects saved settings, not the unsaved draft.
function PortalStatusView() {
  const toast = useUIStore((s) => s.toast);
  const [status, setStatus] = useState<PortalStatus | null>(null);

  const refresh = () => api.portalGetStatus().then(setStatus);
  useEffect(() => {
    refresh();
  }, []);

  if (!status) return null;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Portal link copied', 'success');
    } catch {
      toast('Copy failed — select the link text instead', 'error');
    }
  };

  return (
    <div className="rounded-lg border border-edge bg-raised px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">
          {status.running
            ? `Running on port ${status.port}`
            : status.enabled
              ? `Not running${status.error ? ` — ${status.error}` : ''}`
            : 'Off'}
        </span>
        <button
          onClick={refresh}
          className="text-xs text-muted hover:text-ink"
          title="Refresh status"
        >
          ⟳ Refresh
        </button>
      </div>
      {status.running &&
        status.urls.map((url) => (
          <div key={url} className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 truncate text-xs">{url}</code>
            <button
              onClick={() => copy(url)}
              className="rounded border border-edge px-2 py-0.5 text-xs text-muted hover:text-ink"
            >
              Copy
            </button>
          </div>
        ))}
      {status.running && (
        <p className="mt-1.5 text-xs text-muted">
          Open a link on any device on the same network. The token is remembered per browser
          after the first visit. Use the <strong>https://</strong> link on phones for voice
          features — accept the certificate warning once.
        </p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// Port note: the standalone app stored provider keys in its own encrypted
// sqlite settings. In the WICKED suite keys live ONCE in the shell's central
// vault (Settings → API Keys); this module only shows set/not-set badges and
// never sees the values.
const KEY_PROVIDERS: { id: string; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'deepseek', label: 'DeepSeek' },
];

function ApiKeysStatusView() {
  const status = useKeysStore((s) => s.status);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {KEY_PROVIDERS.map((p) => {
          const set = status[p.id] === true;
          return (
            <span
              key={p.id}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                set ? 'border-ok/40 bg-ok/10 text-ok' : 'border-edge bg-raised text-muted'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${set ? 'bg-ok' : 'bg-edge'}`} />
              {p.label}: {set ? 'key set' : 'not set'}
            </span>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        Provider API keys are managed once for the whole suite in{' '}
        <strong>WICKED Settings → API Keys</strong> (the gear in the activity bar). They are stored
        encrypted in the shell and never shown to this module — only these set/not-set indicators.
        Local services that need no key (Ollama, ComfyUI) are configured below.
      </p>
    </div>
  );
}

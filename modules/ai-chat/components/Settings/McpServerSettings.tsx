import { useEffect, useState } from 'react';
import type { McpServerConfig } from '../../types';
import { useUIStore } from '../../store/uiStore';
import { api } from '../../lib/bridge';

function newServer(): McpServerConfig {
  return {
    id: `srv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    command: '',
    args: [],
    enabled: true,
  };
}

export function McpServerSettings() {
  const toast = useUIStore((s) => s.toast);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    api.mcpGetServers().then(setServers);
  }, []);

  const persist = async (next: McpServerConfig[]) => {
    setServers(next);
    await api.mcpSaveServers(next);
  };

  const update = (id: string, patch: Partial<McpServerConfig>) => {
    // Editing the command/args invalidates any live connection — drop it so the
    // next Test / tool call re-spawns with the new config instead of the stale process.
    if (patch.command !== undefined || patch.args !== undefined) {
      void api.mcpDisconnect(id);
    }
    persist(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const remove = async (id: string) => {
    await api.mcpDisconnect(id);
    persist(servers.filter((s) => s.id !== id));
  };

  const test = async (server: McpServerConfig) => {
    setTesting(server.id);
    try {
      const res = await api.mcpTestServer(server);
      if (res.ok) toast(`Connected — ${res.tools} tool(s) available`, 'success');
      else toast(`Connection failed: ${res.error}`, 'error');
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Connect MCP servers (e.g. a Godot editor server) so OpenAI &amp; DeepSeek can call their
        tools to read and write your project. Each server is launched as a local command.
      </p>

      {servers.map((server) => (
        <div key={server.id} className="rounded-lg border border-edge bg-raised p-3">
          <div className="mb-2 flex items-center gap-2">
            <input
              value={server.name}
              onChange={(e) => update(server.id, { name: e.target.value })}
              placeholder="Name (e.g. Godot)"
              className="flex-1 rounded-md border border-edge bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={server.enabled}
                onChange={(e) => update(server.id, { enabled: e.target.checked })}
                className="accent-accent"
              />
              On
            </label>
            <button
              onClick={() => remove(server.id)}
              className="text-muted hover:text-red-400"
              title="Remove"
            >
              🗑
            </button>
          </div>
          <div className="flex gap-2">
            <input
              value={server.command}
              onChange={(e) => update(server.id, { command: e.target.value })}
              placeholder="Command (e.g. npx)"
              className="w-32 rounded-md border border-edge bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <input
              value={server.args.join(' ')}
              onChange={(e) =>
                update(server.id, { args: e.target.value.split(' ').filter(Boolean) })
              }
              placeholder="Args (e.g. -y godot-mcp)"
              className="flex-1 rounded-md border border-edge bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={() => test(server)}
              disabled={testing === server.id || !server.command}
              className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-40"
            >
              {testing === server.id ? '…' : 'Test'}
            </button>
          </div>
        </div>
      ))}

      <button
        onClick={() => persist([...servers, newServer()])}
        className="rounded-lg border border-dashed border-edge px-3 py-2 text-sm text-muted hover:text-ink"
      >
        + Add MCP server
      </button>
    </div>
  );
}

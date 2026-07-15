import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as db from './db';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string; // e.g. "npx" or an absolute path to a binary
  args: string[]; // e.g. ["-y", "godot-mcp"]
  enabled: boolean;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string; // bare tool name as exposed by the server
  qualifiedName: string; // `${serverId}__${name}` — collision-safe id used with the LLM
  description: string;
  inputSchema: Record<string, unknown>;
}

const SETTINGS_KEY = 'mcpServers';

interface LiveConnection {
  client: Client;
  transport: StdioClientTransport;
}

const connections = new Map<string, LiveConnection>();

export function getServers(): McpServerConfig[] {
  try {
    const raw = db.getSettingRaw(SETTINGS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    return [];
  }
}

export function saveServers(servers: McpServerConfig[]): void {
  db.setSettingRaw(SETTINGS_KEY, JSON.stringify(servers));
}

async function ensureConnected(server: McpServerConfig): Promise<Client> {
  const existing = connections.get(server.id);
  if (existing) return existing.client;

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: process.env as Record<string, string>,
  });
  const client = new Client(
    { name: 'wicked-ai-chat', version: '1.0.42' },
    { capabilities: {} }
  );
  await client.connect(transport);
  connections.set(server.id, { client, transport });
  return client;
}

export async function disconnect(serverId: string): Promise<void> {
  const conn = connections.get(serverId);
  if (!conn) return;
  try {
    await conn.client.close();
  } catch {
    /* ignore */
  }
  connections.delete(serverId);
}

export async function disconnectAll(): Promise<void> {
  for (const id of [...connections.keys()]) await disconnect(id);
}

// Connect to every enabled server and collect all exposed tools.
export async function listAllTools(): Promise<McpToolInfo[]> {
  const servers = getServers().filter((s) => s.enabled);
  const out: McpToolInfo[] = [];
  for (const server of servers) {
    try {
      const client = await ensureConnected(server);
      const { tools } = await client.listTools();
      for (const t of tools) {
        out.push({
          serverId: server.id,
          serverName: server.name,
          name: t.name,
          qualifiedName: `${server.id}__${t.name}`,
          description: t.description ?? '',
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
        });
      }
    } catch (err) {
      console.warn(`[mcp] failed to list tools for ${server.name}:`, (err as Error).message);
    }
  }
  return out;
}

export async function callTool(
  qualifiedName: string,
  args: Record<string, unknown>
): Promise<string> {
  const sepIndex = qualifiedName.indexOf('__');
  if (sepIndex === -1) throw new Error(`Invalid tool name: ${qualifiedName}`);
  const serverId = qualifiedName.slice(0, sepIndex);
  const toolName = qualifiedName.slice(sepIndex + 2);

  const server = getServers().find((s) => s.id === serverId);
  if (!server) throw new Error(`Unknown MCP server: ${serverId}`);

  const client = await ensureConnected(server);
  const result = await client.callTool({ name: toolName, arguments: args });

  // MCP content blocks → plain text for the model.
  const content = (result.content as Array<{ type: string; text?: string }>) ?? [];
  const text = content
    .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`))
    .join('\n');
  return text || '(tool returned no textual content)';
}

// Quick connectivity probe used by the settings UI.
export async function testServer(server: McpServerConfig): Promise<{ ok: boolean; tools: number; error?: string }> {
  try {
    const client = await ensureConnected(server);
    const { tools } = await client.listTools();
    return { ok: true, tools: tools.length };
  } catch (err) {
    await disconnect(server.id);
    return { ok: false, tools: 0, error: (err as Error).message };
  }
}

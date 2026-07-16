import express, { type Express, type Request, type Response } from 'express'
import type { Server } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpModuleContext, McpRegister, McpToolDef } from '@shared/mcp'
import { getApiKey } from '../api-keys'
import { invokeChannel } from './channel-registry'
import { requiresConfirmation, requiresCredential } from './gate'

/**
 * WICKED MCP server. Reuses DevPad's proven approach — a localhost-only Express
 * host with Host/Origin guards and a start/stop/status lifecycle — but serves
 * the REAL MCP protocol (JSON-RPC over Streamable HTTP) via the official SDK,
 * so any MCP client (Claude Desktop, Claude Code) can discover and call the
 * tools. The endpoint is http://localhost:<MCP_PORT>/mcp.
 *
 * The tool list is built at startup by scanning every module's mcp.ts — adding
 * a module's mcp.ts is the only step needed to expose its tools.
 */
export const MCP_PORT = 3737 // WICKED suite (DevPad standalone used 3727)

// Build-time scan of module MCP definitions.
const mcpModules = import.meta.glob<{ default: McpRegister }>('@modules/*/mcp.ts', { eager: true })

let server: Server | null = null
let enabled = false

export interface McpToolInfo {
  module: string
  name: string
  description: string
  destructive: boolean
}

let lastTools: McpToolInfo[] = []

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  toolCount: number
  tools: McpToolInfo[]
}

export function getMcpStatus(): McpStatus {
  return {
    enabled,
    running: server !== null,
    port: MCP_PORT,
    url: `http://localhost:${MCP_PORT}/mcp`,
    toolCount: lastTools.length,
    tools: lastTools
  }
}

function moduleIdFromPath(path: string): string {
  const m = path.match(/modules\/([^/]+)\/mcp\.ts$/)
  return m ? m[1] : path
}

/** Render a tool's return value (result or withhold object) as MCP text content. */
function toContent(value: unknown): { content: { type: 'text'; text: string }[] } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }] }
}

/** Build a fresh McpServer with every module's tools registered. */
function buildMcpServer(): McpServer {
  const mcp = new McpServer(
    { name: 'wicked', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Tools for the WICKED desktop suite. Each tool is named <module-id>__<action> and ' +
        'drives the same function as the corresponding app UI. Destructive tools require a ' +
        'second call with "confirm": true. Tools needing a credential return the credential ' +
        'name; supply it explicitly to proceed.'
    }
  )

  const tools: McpToolInfo[] = []

  for (const [path, mod] of Object.entries(mcpModules)) {
    const moduleId = moduleIdFromPath(path)
    const ctx: McpModuleContext = {
      moduleId,
      invoke: (channel, ...args) => invokeChannel(channel, ...args),
      hasApiKey: (provider) => getApiKey(provider) !== null,
      confirm: requiresConfirmation,
      credential: requiresCredential
    }

    let defs: McpToolDef[]
    try {
      defs = mod.default(ctx)
    } catch (err) {
      console.error(`[mcp] module ${moduleId} failed to build tools`, err)
      continue
    }

    for (const def of defs) {
      // Enforce the naming rule so a stray tool can't collide across modules.
      if (!def.name.startsWith(`${moduleId}__`)) {
        console.error(`[mcp] tool "${def.name}" in ${moduleId} must be named ${moduleId}__<action> — skipped`)
        continue
      }
      mcp.registerTool(
        def.name,
        {
          description: def.description,
          inputSchema: def.inputSchema,
          annotations: { destructiveHint: Boolean(def.destructive) }
        },
        async (args: Record<string, unknown>) => {
          try {
            const result = await def.handler(args ?? {}, ctx)
            return toContent(result)
          } catch (err) {
            return {
              content: [
                { type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
              ],
              isError: true
            }
          }
        }
      )
      tools.push({
        module: moduleId,
        name: def.name,
        description: def.description,
        destructive: Boolean(def.destructive)
      })
    }
  }

  lastTools = tools.sort((a, b) => a.name.localeCompare(b.name))
  return mcp
}

function buildApp(): Express {
  const app = express()
  app.use(express.json({ limit: '25mb' }))

  // Localhost trust boundary. Local MCP clients never send an Origin header;
  // web pages always do — rejecting any Origin blocks drive-by requests from a
  // browser tab. The Host allowlist blocks DNS-rebinding.
  app.use((req, res, next) => {
    const host = String(req.headers.host ?? '')
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) {
      res.status(403).json({ error: 'Forbidden host.' })
      return
    }
    if (req.headers.origin) {
      res.status(403).json({ error: 'Browser origins are not allowed.' })
      return
    }
    next()
  })

  // Stateless Streamable HTTP: a fresh server+transport per request, with no
  // session tracking (sessionIdGenerator: undefined). Simple and robust for a
  // local tool server — every POST is self-contained.
  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const mcp = buildMcpServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close()
        mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      console.error('[mcp] request error', err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal MCP error' })
    }
  })

  // GET/DELETE without a session are not supported in stateless mode.
  const noSession = (_req: Request, res: Response): void => {
    res.status(405).json({ error: 'Method not allowed. POST JSON-RPC to /mcp.' })
  }
  app.get('/mcp', noSession)
  app.delete('/mcp', noSession)

  // Convenience: a plain-text status page for humans/debugging.
  app.get('/status', (_req, res) => res.json(getMcpStatus()))

  return app
}

export function startMcpServer(): Promise<McpStatus> {
  enabled = true
  // Build once up front so the tool list is populated even before first request.
  buildMcpServer()
  return new Promise((resolve) => {
    if (server) return resolve(getMcpStatus())
    const app = buildApp()
    server = app.listen(MCP_PORT, '127.0.0.1', () => {
      console.log(`[mcp] WICKED MCP server on http://localhost:${MCP_PORT}/mcp (${lastTools.length} tools)`)
      resolve(getMcpStatus())
    })
    server.on('error', (err) => {
      console.error('[mcp] listen error', err)
      server = null
      enabled = false
      resolve(getMcpStatus())
    })
  })
}

export function stopMcpServer(): Promise<McpStatus> {
  enabled = false
  return new Promise((resolve) => {
    if (!server) return resolve(getMcpStatus())
    server.close(() => {
      server = null
      console.log('[mcp] stopped')
      resolve(getMcpStatus())
    })
  })
}

export function setMcpEnabled(value: boolean): Promise<McpStatus> {
  return value ? startMcpServer() : stopMcpServer()
}

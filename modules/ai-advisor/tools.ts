import { z } from 'zod'
import { getApiKey } from '../../src/main/api-keys'
import { invokeChannel } from '../../src/main/mcp/channel-registry'
import { requiresConfirmation, requiresCredential } from '../../src/main/mcp/gate'
import type { McpModuleContext, McpRegister, McpToolDef } from '@shared/mcp'
import { toolLabel } from './types'

/**
 * Collects the MCP tools of every module in the "stocks" group and hands them to
 * the advisor's agent loop. We reuse each module's own mcp.ts handlers (the same
 * ones the localhost MCP server exposes), so there is one source of truth and the
 * advisor always sees live data.
 *
 * Safety: the advisor is READ-ONLY. Destructive tools and any obvious mutation
 * (create/update/remove/import/…) are filtered out. Paid X/Twitter tools are
 * allowed but flagged so the agent loop can ask the user before spending money.
 */

interface Manifest {
  id?: string
  group?: { id?: string }
}

const mcpModules = import.meta.glob<{ default: McpRegister }>('@modules/*/mcp.ts', { eager: true })
const manifests = import.meta.glob<Manifest>('@modules/*/module.json', { eager: true, import: 'default' })

/** Tools that hit the paid X/Twitter API — each call must be user-approved. */
export const PAID_X_TOOLS = new Set(['find-trades__trending', 'find-trades__mentions'])

/** Mutation tools we keep OUT of the advisor's reach (it reads, it doesn't write). */
const MUTATION_RE = /__(clear|remove|delete|create|update|import|save|set|write|add)\b/

function moduleIdFromPath(path: string): string {
  const m = /modules\/([^/]+)\//.exec(path)
  return m ? m[1] : ''
}

export interface AdvisorTool {
  def: McpToolDef
  ctx: McpModuleContext
  moduleId: string
  label: string
  jsonSchema: Record<string, unknown>
  paidX: boolean
}

let cache: AdvisorTool[] | null = null

function makeCtx(moduleId: string): McpModuleContext {
  return {
    moduleId,
    invoke: (channel, ...args) => invokeChannel(channel, ...args),
    hasApiKey: (provider) => getApiKey(provider) !== null,
    confirm: requiresConfirmation,
    credential: requiresCredential
  }
}

/** Zod raw shape → JSON Schema object for the Anthropic `tools` param. */
function schemaFor(def: McpToolDef): Record<string, unknown> {
  try {
    const js = z.toJSONSchema(z.object(def.inputSchema ?? {})) as Record<string, unknown>
    if (js && js.type === 'object') {
      delete (js as Record<string, unknown>)['$schema']
      if (!js.properties) js.properties = {}
      return js
    }
  } catch {
    /* fall through to a permissive object schema */
  }
  return { type: 'object', properties: {} }
}

/** Every read-only tool from stocks-group modules (excludes self + mutations + destructive). */
export function stocksTools(): AdvisorTool[] {
  if (cache) return cache
  const stocksIds = new Set<string>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (manifest && manifest.group?.id === 'stocks') stocksIds.add(moduleIdFromPath(path))
  }
  const out: AdvisorTool[] = []
  for (const [path, mod] of Object.entries(mcpModules)) {
    const id = moduleIdFromPath(path)
    if (id === 'ai-advisor' || !stocksIds.has(id)) continue
    const ctx = makeCtx(id)
    let defs: McpToolDef[] = []
    try {
      defs = mod.default(ctx) ?? []
    } catch {
      defs = []
    }
    for (const def of defs) {
      if (def.destructive || MUTATION_RE.test(def.name)) continue
      out.push({
        def,
        ctx,
        moduleId: id,
        label: toolLabel(def.name),
        jsonSchema: schemaFor(def),
        paidX: PAID_X_TOOLS.has(def.name)
      })
    }
  }
  cache = out
  return out
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s
}

export interface ToolRunResult {
  text: string
  status: 'ok' | 'error'
}

/** Execute a tool via its own mcp.ts handler; normalize the result to text. */
export async function runTool(tool: AdvisorTool, input: unknown): Promise<ToolRunResult> {
  try {
    const r = await tool.def.handler((input ?? {}) as Record<string, unknown>, tool.ctx)
    if (r && typeof r === 'object' && 'status' in r) {
      const s = (r as { status?: string }).status
      if (s === 'confirmation-required' || s === 'credential-required')
        return { text: `This tool is not available to the advisor (${s}).`, status: 'error' }
    }
    const text = typeof r === 'string' ? r : JSON.stringify(r)
    const ok = !(r && typeof r === 'object' && (r as { ok?: boolean }).ok === false)
    // Cap generously: computed summaries are tiny, but a full trade/execution list
    // must not be clipped so hard the agent only sees a fraction of the data.
    return { text: truncate(text, 24000), status: ok ? 'ok' : 'error' }
  } catch (e) {
    return { text: `Error: ${e instanceof Error ? e.message : String(e)}`, status: 'error' }
  }
}

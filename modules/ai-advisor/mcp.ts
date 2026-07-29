import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for AI ADVISOR — read-only access to its saved conversations. The
 * advisor's own agent/chat is intentionally NOT exposed on MCP (it already runs
 * Claude with the stocks tools; nesting it under MCP would be circular), so the
 * useful external surface is just listing and reading the stored chats.
 */
const ID = 'ai-advisor'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list-chats`,
      description: 'List the AI Advisor saved conversations (id, title, last-updated, message count). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list`)
    },
    {
      name: `${ID}__get-chat`,
      description: 'Read one saved AI Advisor conversation in full (all messages). Read-only.',
      inputSchema: { id: z.string().describe('Conversation id from ai-advisor__list-chats.') },
      handler: (args) => ctx.invoke(`${ID}:get`, args.id)
    }
  ]
}

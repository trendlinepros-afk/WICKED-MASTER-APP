import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for THE BRAIN — read-only. Lets an agent list, read and search the
 * app's local markdown memory vault (notes + auto-saved chats + persona docs).
 * Writing/deleting stays a deliberate action in the tool UI, so no mutation
 * tools are exposed here.
 */
const ID = 'the-brain'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list`,
      description:
        'List the folder/file tree of The Brain — the app\'s local markdown memory vault (notes, auto-saved AI chats under Chats/, persona documents under Personas/, imported files). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:tree`)
    },
    {
      name: `${ID}__read`,
      description: 'Read one note from The Brain by its vault-relative path (e.g. "Chats/AI Advisor/My chat.md"). Read-only.',
      inputSchema: { path: z.string().describe('Vault-relative path to the .md file, as returned by the-brain__list or __search.') },
      handler: (args) => ctx.invoke(`${ID}:read`, args.path)
    },
    {
      name: `${ID}__search`,
      description:
        'Keyword-search The Brain and return the most relevant notes (path, title, excerpt). Use this to recall past chats, personas or notes before answering. Read-only.',
      inputSchema: { query: z.string().describe('What to look for, e.g. "risk rules for NVDA".') },
      handler: (args) => ctx.invoke(`${ID}:search`, args.query)
    }
  ]
}

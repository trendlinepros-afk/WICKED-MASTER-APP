import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for EVENT VIEWER. Every tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no collection, AI or export logic
 * is duplicated here. Collection and export are read-only / user-directed; the
 * AI health report calls DeepSeek and is gated on a caller-supplied credential
 * so the MCP path never silently uses the shell's stored vault key.
 */
const ID = 'event-viewer'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__collect`,
      description:
        'Collect and de-duplicate Windows event-log entries from the selected logs, levels and time window. Read-only: reads the event logs, changes nothing. Security is filtered by audit-failure keyword (level filter ignored); the other logs are filtered by the given levels. Times are ISO-8601 and `from` must be before `to`.',
      inputSchema: {
        logs: z
          .array(z.enum(['Application', 'System', 'Security', 'Setup']))
          .describe('Which Windows logs to read. At least one is required.'),
        levels: z
          .array(z.number().int())
          .describe('Event levels to include: 1=Critical, 2=Error, 3=Warning, 4=Information. Required unless only the Security log is selected.'),
        fromIso: z.string().describe('Start of the window, ISO-8601 (e.g. "2026-07-15T00:00:00Z").'),
        toIso: z.string().describe('End of the window, ISO-8601. Must be after fromIso.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:collect`, {
          logs: args.logs,
          levels: args.levels,
          fromIso: args.fromIso,
          toIso: args.toIso
        })
    },
    {
      name: `${ID}__ai-report`,
      description:
        'Run one exchange of the AI health-report chat over a collected event digest. Sends the given chat messages to DeepSeek and returns its analysis. Requires the DeepSeek API key: supply it via `credential` — the MCP path never auto-uses the stored vault key. Read-only (no local changes).',
      inputSchema: {
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string()
            })
          )
          .describe(
            'The multi-turn chat so far. Typically a leading system message carrying the event-log digest, then user/assistant turns.'
          ),
        credential: z
          .string()
          .optional()
          .describe('DeepSeek API key. Required on the MCP path; the stored vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('DeepSeek API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:ai-complete`, args.messages)
      }
    },
    {
      name: `${ID}__cancel`,
      description:
        'Cancel the event collection currently running and/or the in-flight AI analysis request, if any. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    },
    {
      name: `${ID}__export-report`,
      description:
        'Save the given Markdown health report to a file the user picks in a Save dialog. The user chooses the path, so this is non-destructive (no silent overwrite).',
      inputSchema: {
        markdown: z.string().describe('The report Markdown to save.')
      },
      handler: (args) => ctx.invoke(`${ID}:export-report`, args.markdown)
    }
  ]
}

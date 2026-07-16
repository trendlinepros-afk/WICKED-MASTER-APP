import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for 365 EMAIL CLEANUP. Every tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no Outlook or AI logic is
 * duplicated here. All Outlook work is done through classic-Outlook COM
 * automation driven by PowerShell from the main process.
 *
 * Read-only tools (connect, list-folders, scan, list-rules, history) run freely.
 * The bulk cleanup and undo tools MOVE mail, so they are gated through the shared
 * confirmation gate. The AI draft tool needs a provider key and is gated on a
 * caller-supplied credential so the MCP path never silently uses the vault key.
 */
const ID = '365-email-cleanup'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__connect`,
      description:
        'Attach to the running (or a new) classic Outlook desktop session under the current user and report the account name, the Inbox subfolder names, and the inbox item count. Read-only. Fails clearly if classic Outlook is not available.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:connect`)
    },
    {
      name: `${ID}__list-folders`,
      description: 'List the subfolder names directly under the Outlook Inbox (the available filing targets). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-folders`)
    },
    {
      name: `${ID}__scan`,
      description:
        'Scan the most recent inbox messages and return their metadata (entryId, subject, sender name, resolved SMTP address, received time, and whether they carry a bulk/List-Unsubscribe header). Read-only: reads the inbox, moves nothing. Group and route these client-side to plan a cleanup.',
      inputSchema: {
        max: z
          .number()
          .int()
          .optional()
          .describe('Maximum messages to read (default 500, capped at 2000).')
      },
      handler: (args) => ctx.invoke(`${ID}:scan`, args.max ?? 500)
    },
    {
      name: `${ID}__list-rules`,
      description:
        'Return the saved routing rules: sender-address routes, domain routes, and subject-pattern routes (each maps to a destination folder, or "" for keep-in-inbox). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:routes-load`)
    },
    {
      name: `${ID}__history`,
      description: 'List the recorded cleanup runs (each an undoable batch of moved emails with sender, subject and destination folder). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:history`)
    },
    {
      name: `${ID}__create-folder`,
      description:
        'Create (or ensure) a subfolder under the Inbox by name, and return the updated folder list. Creating an empty folder is trivially reversible.',
      inputSchema: {
        name: z.string().describe('Folder name to create under the Inbox.')
      },
      handler: (args) => ctx.invoke(`${ID}:create-folder`, args.name)
    },
    {
      name: `${ID}__cleanup`,
      description:
        'Move inbox emails in bulk into their target folders and remember the sender→folder rules. Destructive: this physically relocates mail in Outlook (nothing is deleted; the batch is undoable). `moves` is a list of { folder, entryIds } (entryIds come from scan); `learn` is an optional list of { entry, target } sender/domain rules to remember.',
      destructive: true,
      inputSchema: {
        moves: z
          .array(
            z.object({
              folder: z.string().describe('Destination Inbox subfolder name (created if missing).'),
              entryIds: z.array(z.string()).describe('Outlook EntryIDs of the messages to move (from scan).')
            })
          )
          .describe('The folder→emails moves to perform.'),
        learn: z
          .array(
            z.object({
              entry: z.string().describe('Sender address (bob@x.com) or domain (x.com / @x.com).'),
              target: z.string().describe('Destination folder name, or "" to keep in inbox.')
            })
          )
          .optional()
          .describe('Sender/domain rules to remember for future scans.'),
        confirm: z.boolean().optional().describe('Set true to actually perform the moves.')
      },
      handler: (args) => {
        const moves = Array.isArray(args.moves) ? (args.moves as { folder: string; entryIds: string[] }[]) : []
        const total = moves.reduce((n, m) => n + (Array.isArray(m.entryIds) ? m.entryIds.length : 0), 0)
        const folders = moves.map((m) => m.folder).join(', ')
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Move ${total} inbox email(s) into folder(s): ${folders || '(none)'}. ` +
            'This relocates mail in Outlook (nothing is deleted; the batch can be undone).'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:cleanup`, { moves, learn: args.learn ?? [] })
      }
    },
    {
      name: `${ID}__undo`,
      description:
        'Undo the most recent cleanup run by moving those emails back to the folders they came from. Destructive: it relocates mail in Outlook (restoring the prior state).',
      destructive: true,
      inputSchema: {
        confirm: z.boolean().optional().describe('Set true to perform the undo.')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Undo the last cleanup: move that batch of emails back to their original folders in Outlook.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:undo`)
      }
    },
    {
      name: `${ID}__draft-reply`,
      description:
        'Draft an AI reply for one inbox message and save it to the Outlook Drafts folder (nothing is sent). Sends the message body to Gemini 2.5 Flash (falling back to DeepSeek). Requires a provider API key: supply it via `credential` — the MCP path never auto-uses the stored vault key.',
      inputSchema: {
        entryId: z.string().describe('Outlook EntryID of the message to reply to (from scan).'),
        subject: z.string().optional().describe('Message subject (context for the reply).'),
        fromName: z.string().optional().describe('Sender display name (context).'),
        fromEmail: z.string().optional().describe('Sender email address (context).'),
        tone: z.string().optional().describe('Reply tone, e.g. "warm and professional" (default).'),
        provider: z
          .enum(['gemini', 'deepseek'])
          .optional()
          .describe('Which provider the supplied credential is for (default gemini).'),
        credential: z
          .string()
          .optional()
          .describe('Gemini or DeepSeek API key. Required on the MCP path; the stored vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('a Gemini or DeepSeek API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:draft-reply`, {
          entryId: args.entryId,
          subject: args.subject,
          fromName: args.fromName,
          fromEmail: args.fromEmail,
          tone: args.tone,
          keyOverride: { provider: (args.provider as string) || 'gemini', key: args.credential }
        })
      }
    },
    {
      name: `${ID}__cancel`,
      description: 'Cancel the Outlook operation and/or the in-flight AI draft request currently running, if any. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    }
  ]
}

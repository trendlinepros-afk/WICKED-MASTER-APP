import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for 365 EMAIL CLEANUP. Each tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no launch logic is duplicated here.
 *
 * `launch` opens the standalone Outlook-COM cleanup app. Launching the app is
 * non-destructive on its own (it only opens the tool; the user drives Outlook
 * from there), so no confirmation gate is used. Note: the launched app drives the
 * user's Outlook via COM automation.
 */
const ID = '365-email-cleanup'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report the resolved InboxCleanup.exe path and whether that file exists on disk. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__launch`,
      description:
        'Launch the standalone 365 Email Cleanup app (InboxCleanup.exe). The launched app drives ' +
        "the user's Outlook via COM automation; opening it is non-destructive.",
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:launch`)
    }
  ]
}

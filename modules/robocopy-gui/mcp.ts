import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for ROBOCOPY GUI. Each tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no copy logic is duplicated here.
 * `start-copy` is destructive and routed through the shared confirmation gate.
 */
const ID = 'robocopy-gui'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__probe`,
      description:
        'Check whether robocopy.exe is available and whether a copy is currently running. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:probe`)
    },
    {
      name: `${ID}__list-profiles`,
      description: 'List saved robocopy job profiles (name, file, last-modified). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:profiles-list`)
    },
    {
      name: `${ID}__load-profile`,
      description:
        'Load a saved job profile by its file name (from list-profiles) and return its source, destination and flags. Read-only.',
      inputSchema: {
        file: z.string().describe('Profile file name, e.g. "nightly-backup.rcjob.json"')
      },
      handler: (args) => ctx.invoke(`${ID}:profile-load`, args.file)
    },
    {
      name: `${ID}__start-copy`,
      description:
        'Run a robocopy job from source to destination with the given flags. This copies, overwrites, and (with /MIR or /MOVE) can delete files — destructive. Use listOnly:true for a no-op dry run (/L). Streams progress to the app window.',
      destructive: true,
      inputSchema: {
        source: z.string().describe('Source folder path'),
        destination: z.string().describe('Destination folder path'),
        flags: z
          .string()
          .optional()
          .describe('Robocopy flags, e.g. "/E /MT:8 /R:2 /W:5". Defaults to "/E".'),
        listOnly: z
          .boolean()
          .optional()
          .describe('If true, append /L for a dry run that changes nothing.'),
        confirm: z.boolean().optional().describe('Set true to actually execute (see confirmation).')
      },
      handler: (args) => {
        const source = String(args.source ?? '')
        const destination = String(args.destination ?? '')
        const flags = String(args.flags ?? '/E').trim()
        const listOnly = args.listOnly === true
        const argString = `"${source}" "${destination}" ${flags}${listOnly ? ' /L' : ''}`.trim()

        // Dry runs change nothing; real runs pass through the confirmation gate.
        if (!listOnly) {
          const gate = ctx.confirm(
            args.confirm as boolean | undefined,
            `Run robocopy: copy "${source}" -> "${destination}" with flags "${flags}". ` +
              'This can overwrite or (with /MIR or /MOVE) delete files in the destination.'
          )
          if (gate) return gate
        }
        return ctx.invoke(`${ID}:run`, argString)
      }
    },
    {
      name: `${ID}__cancel`,
      description: 'Cancel the robocopy job currently running (if any).',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    }
  ]
}

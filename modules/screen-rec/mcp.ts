import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for SCREENREC. Each delegates to the same main-process channel
 * the UI uses (ipc.ts). Starting a recording captures the user's screen and
 * rendering closes the session, so both go through the confirmation gate;
 * discarding deletes clips and is marked destructive.
 */
const ID = 'screen-rec'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description: 'Recorder state (idle / picking / recording …), the open session’s clips and total length, and any render in progress. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__screens`,
      description: 'Connected monitors (number, name, resolution), the default screen and the capture area used on each. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:screens`)
    },
    {
      name: `${ID}__history`,
      description: 'Videos rendered on this PC: file path, length, clip count, size. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:history`)
    },
    {
      name: `${ID}__record`,
      description:
        'Same as pressing the record hotkey: when idle it starts a clip (straight away on the default screen, otherwise the on-screen picker appears for the user); when recording it stops and saves the clip. Starting captures the user’s screen — requires confirm:true.',
      inputSchema: { confirm: z.boolean().optional() },
      handler: async (args) => {
        const st = (await ctx.invoke(`${ID}:state`)) as { phase?: string }
        if (st?.phase === 'idle') {
          const gate = ctx.confirm(args.confirm as boolean | undefined, 'Start recording the user’s screen (and microphone) into the current ScreenRec session.')
          if (gate) return gate
        }
        return ctx.invoke(`${ID}:record-toggle`)
      }
    },
    {
      name: `${ID}__render`,
      description:
        'Complete the session: join every included clip into one 1920×1080 MP4 using the saved render settings (music track and its dB level, voice level, fps, fit/fill). Runs in the background — poll screen-rec__status. Closes the session when done. Requires confirm:true.',
      destructive: true,
      inputSchema: {
        fileName: z.string().optional().describe('Output name without .mp4; default "ScreenRec <date time>"'),
        musicDb: z.number().min(-40).max(0).optional().describe('Music level in dB (only if a track is set)'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, 'Render every included clip of the open ScreenRec session into one MP4 in the finished-videos folder and close the session (raw clips are deleted afterwards only if that setting is on).')
        if (gate) return gate
        const prefs = typeof args.musicDb === 'number' ? { musicDb: args.musicDb } : {}
        return ctx.invoke(`${ID}:render`, { prefs, fileName: args.fileName ?? '' })
      }
    },
    {
      name: `${ID}__discard-session`,
      description: 'Delete every clip of the open session (files included) without rendering. Requires confirm:true.',
      destructive: true,
      inputSchema: { confirm: z.boolean().optional() },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, 'Permanently delete all clips in the open ScreenRec session and their files.')
        if (gate) return gate
        return ctx.invoke(`${ID}:session-discard`, { deleteFiles: true })
      }
    }
  ]
}

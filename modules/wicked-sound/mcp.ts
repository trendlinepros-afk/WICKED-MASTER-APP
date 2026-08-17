import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'
import type { SoundStatus } from './types'

/**
 * MCP tools for WICKED SOUND. Each tool delegates to the SAME main-process
 * channels the module UI calls (see ipc.ts) — no logic is duplicated here.
 * Changing the mix or power is loud but harmless and instantly reversible
 * (power off = passthrough), so no destructive gating is needed. Nothing here
 * touches credentials.
 */
const ID = 'wicked-sound'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Current WICKED Sound state: whether the Equalizer APO engine is installed, power on/off, the active ' +
        'mix, the targeted output device, Auto mode, all mixes and device links. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__set-power`,
      description:
        'Turn the system EQ on or off. Off writes a passthrough config (audio is untouched). ' +
        'Requires Equalizer APO to be installed.',
      inputSchema: { on: z.boolean().describe('true = EQ active, false = passthrough') },
      handler: (args) => ctx.invoke(`${ID}:set`, { power: args.on === true })
    },
    {
      name: `${ID}__apply-mix`,
      description:
        'Activate a mix (EQ profile) by name — e.g. "YouTube", "Music", "Movie", "Flat" or a custom mix — and ' +
        'power the EQ on. The mix applies to the currently selected output.',
      inputSchema: {
        name: z.string().describe('Mix name (case-insensitive), e.g. "Music" or "YouTube".')
      },
      handler: async (args) => {
        const st = (await ctx.invoke(`${ID}:status`)) as SoundStatus
        const want = String(args.name ?? '').trim().toLowerCase()
        const hit = st.settings.profiles.find((p) => p.name.toLowerCase() === want || p.id === want)
        if (!hit) {
          return {
            ok: false,
            error: `No mix named "${args.name}". Available: ${st.settings.profiles.map((p) => p.name).join(', ')}`
          }
        }
        return ctx.invoke(`${ID}:set`, { activeProfileId: hit.id, power: true })
      }
    }
  ]
}

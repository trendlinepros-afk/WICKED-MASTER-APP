import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'
import type { Library, PlayerSnapshot } from './shared/types'

/**
 * MCP tools for the MUSIC PLAYER. Playback runs in the RENDERER (so it
 * survives route changes), so main only holds the engine's last reported
 * snapshot and relays commands to it — these tools delegate to those same
 * channels (see ipc.ts). Until the tool has been opened once, the engine
 * isn't loaded and control returns a friendly error. Nothing destructive.
 */
const ID = 'music-player'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'What the Music Player is doing: current track (title/artist), play state, position/duration, ' +
        'shuffle/repeat, queue length — plus the library root and track count. Read-only.',
      inputSchema: {},
      handler: async () => {
        const snap = (await ctx.invoke(`${ID}:snapshot`)) as { snapshot: PlayerSnapshot | null }
        const st = await ctx.invoke(`${ID}:status`)
        return { ...(typeof st === 'object' ? st : {}), nowPlaying: snap.snapshot }
      }
    },
    {
      name: `${ID}__control`,
      description:
        'Control playback: play, pause, toggle, next, prev. Requires the Music Player to have been opened ' +
        'once this session (the engine lives in the app window).',
      inputSchema: { action: z.enum(['play', 'pause', 'toggle', 'next', 'prev']).describe('Transport action.') },
      handler: (args) => ctx.invoke(`${ID}:command`, { cmd: args.action })
    },
    {
      name: `${ID}__playlists`,
      description: 'List the saved playlists (name + track count). Read-only.',
      inputSchema: {},
      handler: async () => {
        const res = (await ctx.invoke(`${ID}:playlists-get`)) as { playlists?: { name: string; trackIds: string[] }[] }
        return { ok: true, playlists: (res.playlists ?? []).map((p) => ({ name: p.name, tracks: p.trackIds.length })) }
      }
    },
    {
      name: `${ID}__search`,
      description: 'Search the scanned music library by song title or artist. Read-only.',
      inputSchema: { query: z.string().describe('Text matched against title and artist.') },
      handler: async (args) => {
        const res = (await ctx.invoke(`${ID}:library`)) as { library?: Library | null }
        const q = String(args.query ?? '').trim().toLowerCase()
        if (!res.library) return { ok: false, error: 'No library scanned yet — open the Music Player and pick your folder.' }
        if (!q) return { ok: false, error: 'Give me something to search for.' }
        const hits = res.library.tracks
          .filter((t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
          .slice(0, 25)
          .map((t) => ({ id: t.id, title: t.title, artist: t.artist }))
        return { ok: true, hits }
      }
    }
  ]
}

import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for YT DOWNLOADER. Probe/status are read-only; download writes
 * (potentially many, large) files to disk and can run for a long time, so it is
 * gated through the shared confirmation gate. All work delegates to the same IPC
 * channels the UI uses (yt-dlp + bundled ffmpeg in the main process).
 */
const ID = 'yt-downloader'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report downloader readiness: whether yt-dlp is installed (and its version, and if it looks stale), whether ffmpeg is available, and the current download folder. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__probe`,
      description:
        'Read a YouTube URL and report whether it is a single video or a playlist, its title, uploader, and (for playlists) the number of videos. Read-only. Installs yt-dlp first if needed.',
      inputSchema: {
        url: z.string().describe('A YouTube video or playlist URL (https://…).')
      },
      handler: (args) => ctx.invoke(`${ID}:probe`, args.url)
    },
    {
      name: `${ID}__download`,
      description:
        'Download a YouTube video or an entire playlist to the configured folder at the chosen quality. Destructive: it writes files to disk and, for playlists, can run for a very long time and use significant bandwidth/space. quality is one of best|2160|1440|1080|720|480|360|audio (audio = MP3). Set isPlaylist true to grab the whole playlist. Requires confirmation.',
      destructive: true,
      inputSchema: {
        url: z.string().describe('YouTube video or playlist URL.'),
        quality: z
          .enum(['best', '2160', '1440', '1080', '720', '480', '360', 'audio'])
          .describe('Target quality (video height) or "audio" for MP3.'),
        isPlaylist: z.boolean().optional().describe('True to download the whole playlist, not just one video.'),
        confirm: z.boolean().optional().describe('Set true to actually start the download.')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Download ${args.isPlaylist ? 'the entire playlist' : 'the video'} at ${String(args.quality)} quality to the configured folder. This writes files to disk and may take a long time / a lot of space for playlists.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:download`, {
          url: args.url,
          quality: args.quality,
          isPlaylist: args.isPlaylist === true
        })
      }
    },
    {
      name: `${ID}__update`,
      description:
        'Update yt-dlp to the latest release (recommended if downloads start failing — YouTube changes break stale copies). Downloads the newest binary.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:update`)
    },
    {
      name: `${ID}__cancel`,
      description: 'Cancel the download currently running, if any. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    }
  ]
}

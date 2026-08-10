import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for TOTAL CHANNEL DOWNLOADER. Probe/status are read-only; the
 * download writes potentially hundreds of large files and can run for hours,
 * so it is confirm-gated. All work delegates to the module's IPC channels.
 */
const ID = 'yt-channel-downloader'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report readiness: whether yt-dlp and ffmpeg are available, the shared download folder, and whether a channel download is currently running. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__probe`,
      description:
        "Read a YouTube channel URL (@handle, /channel/UC…, /c/…, /user/…) and report the channel name and how many long-form videos its Videos tab holds (Shorts, community posts and live streams are excluded). Read-only. Installs yt-dlp first if needed.",
      inputSchema: {
        url: z.string().describe('YouTube channel URL or @handle.')
      },
      handler: (args) => ctx.invoke(`${ID}:probe`, { url: args.url })
    },
    {
      name: `${ID}__download`,
      description:
        "Download a creator's ENTIRE long-form library (channel Videos tab: no Shorts/posts/streams) oldest → newest, numbered in that order, then optionally stitch everything into ONE movie in chronological order. Destructive: writes many large files, can run for HOURS and use a lot of disk and bandwidth. quality is a video tier (best|2160|1440|1080|720|480|360). Requires confirmation.",
      destructive: true,
      inputSchema: {
        url: z.string().describe('YouTube channel URL or @handle.'),
        quality: z
          .enum(['best', '2160', '1440', '1080', '720', '480', '360'])
          .optional()
          .describe('Video quality tier (default 1080).'),
        combine: z
          .boolean()
          .optional()
          .describe('Stitch all videos into one chronological movie after downloading (default true).'),
        channel: z.string().optional().describe('Channel name used to title the stitched movie.'),
        confirm: z.boolean().optional().describe('Set true to actually start.')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Download an entire YouTube channel (every long-form video, oldest to newest) and optionally stitch it into one movie. This can run for hours and consume a lot of disk space and bandwidth.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:download`, {
          url: args.url,
          quality: args.quality ?? '1080',
          combine: args.combine !== false,
          channel: args.channel
        })
      }
    },
    {
      name: `${ID}__cancel`,
      description: 'Cancel the channel download currently running, if any. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    }
  ]
}

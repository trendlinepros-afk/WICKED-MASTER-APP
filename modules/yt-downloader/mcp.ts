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
        'Read a YouTube or YouTube Music URL and report: whether it is a single video/track or a playlist, its title, uploader/artist, item count, whether it is a music.youtube.com link (isMusic), the playlist kind (album | mix | playlist | library), and whether the URL carries BOTH a track and a list (canChooseSingle — in which case pick with isPlaylist on download). Read-only. Installs yt-dlp first if needed.',
      inputSchema: {
        url: z.string().describe('A YouTube or YouTube Music video/track/playlist/album URL (https://…).')
      },
      handler: (args) => ctx.invoke(`${ID}:probe`, args.url)
    },
    {
      name: `${ID}__download`,
      description:
        'Download a YouTube / YouTube Music video, track, playlist or album to the configured folder at the chosen quality. Destructive: it writes files to disk and, for playlists, can run for a very long time and use significant bandwidth/space. quality is one of best|2160|1440|1080|720|480|360|audio|audio-native — "audio" = MP3 320k and "audio-native" = original opus/m4a (no re-encode); both embed artist/album tags and cover art. Set isPlaylist true to grab the whole playlist/album, false to take only the single track/video (important for YouTube Music song links, which usually carry an endless auto-radio list). Requires confirmation.',
      destructive: true,
      inputSchema: {
        url: z.string().describe('YouTube or YouTube Music video/track/playlist/album URL.'),
        quality: z
          .enum(['best', '2160', '1440', '1080', '720', '480', '360', 'audio', 'audio-native'])
          .describe('Target quality (video height), "audio" (MP3) or "audio-native" (original audio).'),
        isPlaylist: z
          .boolean()
          .optional()
          .describe('True = whole playlist/album; false = just the single track/video from a track+list URL.'),
        combine: z
          .boolean()
          .optional()
          .describe('After a playlist VIDEO download, shuffle the clips and stitch them into a single movie file (re-encodes; needs ffmpeg). Ignored for single videos and audio downloads.'),
        title: z.string().optional().describe('Optional title used to name the combined movie file.'),
        confirm: z.boolean().optional().describe('Set true to actually start the download.')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Download ${args.isPlaylist ? 'the entire playlist' : 'the video'} at ${String(args.quality)} quality to the configured folder${args.combine ? ', then combine the clips into one movie' : ''}. This writes files to disk and may take a long time / a lot of space for playlists.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:download`, {
          url: args.url,
          quality: args.quality,
          isPlaylist: args.isPlaylist === true,
          combine: args.combine === true,
          title: args.title
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
      description:
        'Cancel running downloads (up to 3 can run at once; this cancels all of them). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:cancel`)
    }
  ]
}

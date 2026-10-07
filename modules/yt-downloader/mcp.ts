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
        'Report downloader readiness: whether yt-dlp is installed (and its version, and if it looks stale), whether ffmpeg is available, the current download folder, and whether Google Drive is connected (googleDrive — needed for download toDrive). Read-only.',
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
        'Download a YouTube / YouTube Music video, track, playlist or album to the configured folder at the chosen quality. Destructive: it writes files to disk and, for playlists, can run for a very long time and use significant bandwidth/space. quality is one of best|2160|1440|1080|720|480|360|audio|audio-native — "audio" = MP3 320k and "audio-native" = original opus/m4a (no re-encode); both embed artist/album tags and cover art. Set isPlaylist true to grab the whole playlist/album, false to take only the single track/video (important for YouTube Music song links, which usually carry an endless auto-radio list). Set toDrive true to save to Google Drive instead (via File Vault; WICKED Vault/YouTube Downloads — each file uploads as it finishes and nothing is kept locally); check yt-downloader__status first if unsure Drive is connected. Requires confirmation.',
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
          .describe('After a playlist VIDEO download, stitch the clips into a single movie file (re-encodes; needs ffmpeg). Ignored for single videos and audio downloads.'),
        randomize: z
          .boolean()
          .optional()
          .describe('Stitch in RANDOM order (default false = oldest → newest / playlist order). File names stay numbered oldest-first either way.'),
        title: z.string().optional().describe('Optional title used to name the combined movie file.'),
        skipDuplicates: z
          .boolean()
          .optional()
          .describe('Music: skip songs already downloaded before (same video, or the same song under another video) — default: the app setting, normally on. See yt-downloader__downloaded-songs.'),
        fixTags: z
          .boolean()
          .optional()
          .describe('Audio only: look each song up on MusicBrainz and fill missing/wrong title, artist, album, release date, track # and genre (default: the app setting, normally on). Songs it cannot identify wait in yt-downloader__songs-needing-info.'),
        officialArt: z
          .boolean()
          .optional()
          .describe('With fixTags: replace the YouTube thumbnail with the official album cover from the Cover Art Archive (default: the app setting, normally on).'),
        toDrive: z
          .boolean()
          .optional()
          .describe('Upload to Google Drive (WICKED Vault/YouTube Downloads, via File Vault) instead of keeping files on this PC. Needs Google Drive connected in File Vault.'),
        confirm: z.boolean().optional().describe('Set true to actually start the download.')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Download ${args.isPlaylist ? 'the entire playlist' : 'the video'} at ${String(args.quality)} quality ${args.toDrive ? 'to Google Drive (WICKED Vault/YouTube Downloads)' : 'to the configured folder'}${args.combine ? ', then combine the clips into one movie' : ''}. This writes files ${args.toDrive ? 'to your Drive' : 'to disk'} and may take a long time / a lot of space for playlists.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:download`, {
          url: args.url,
          quality: args.quality,
          isPlaylist: args.isPlaylist === true,
          combine: args.combine === true,
          shuffle: args.randomize === true,
          toDrive: args.toDrive === true,
          fixTags: typeof args.fixTags === 'boolean' ? args.fixTags : undefined,
          skipDuplicates: typeof args.skipDuplicates === 'boolean' ? args.skipDuplicates : undefined,
          officialArt: typeof args.officialArt === 'boolean' ? args.officialArt : undefined,
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
    },
    {
      name: `${ID}__downloaded-songs`,
      description:
        'The list of songs already downloaded (from any playlist, to this PC or Google Drive, on any of the user’s PCs — it travels with Backup / Cloud Sync and is shared live through Google Drive) — what music downloads skip as duplicates. Each has the video id, the title/artist it is saved as, the original YouTube name, playlist, where it lives and when. Optional search query. Read-only.',
      inputSchema: {
        query: z.string().optional().describe('Search title, artist, album, original name, playlist or file name.'),
        limit: z.number().int().min(1).max(500).optional()
      },
      handler: (args) => ctx.invoke(`${ID}:library-list`, { query: args.query ?? '', limit: args.limit ?? 50 })
    },
    {
      name: `${ID}__forget-downloaded-songs`,
      description:
        'Remove songs from the downloaded-songs list so they can be downloaded again (files are NOT deleted). Pass video ids, or all=true for the whole list. Requires confirmation.',
      destructive: true,
      inputSchema: {
        videoIds: z.array(z.string()).optional(),
        all: z.boolean().optional(),
        confirm: z.boolean().optional().describe('Set true to proceed.')
      },
      handler: (args) => {
        const ids = Array.isArray(args.videoIds) ? (args.videoIds as string[]) : []
        const gate = ctx.confirm(args.confirm as boolean | undefined, args.all ? 'Forget EVERY downloaded song, so any of them can be downloaded again (files stay).' : `Forget ${ids.length} downloaded song(s) so they can be downloaded again (files stay).`)
        if (gate) return gate
        return ctx.invoke(`${ID}:library-forget`, args.all ? { all: true } : { videoIds: ids })
      }
    },
    {
      name: `${ID}__delete-downloaded-songs`,
      description:
        'Delete downloaded songs: each file goes to the Recycle Bin (this PC) or Google Drive’s trash, and the song leaves the downloaded-songs list (so it could be downloaded again). Video ids come from __downloaded-songs. Songs still uploading / waiting for song info are refused. Destructive. Requires confirmation.',
      destructive: true,
      inputSchema: {
        videoIds: z.array(z.string()).min(1),
        confirm: z.boolean().optional().describe('Set true to delete.')
      },
      handler: (args) => {
        const ids = args.videoIds as string[]
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Delete ${ids.length} downloaded song file(s) (to the Recycle Bin / Google Drive trash) and remove them from the downloaded-songs list.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:library-delete`, { videoIds: ids })
      }
    },
    {
      name: `${ID}__songs-needing-info`,
      description:
        'List downloaded songs that MusicBrainz could not identify and that are missing info — each with an id, file name, its current tags and cleaned-up guesses. Songs from a "Download to Google Drive" job are held (not uploaded) until saved. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:review-list`)
    },
    {
      name: `${ID}__search-song-info`,
      description:
        'Search MusicBrainz for a held song (or any title/artist) and return ranked candidates (title, artist, album, release date, track, releaseId, confidence). Nothing is written. Read-only.',
      inputSchema: {
        id: z.string().optional().describe('Held song id (from __songs-needing-info) — its duration improves ranking.'),
        title: z.string().describe('Song title to search for.'),
        artist: z.string().optional().describe('Artist, if known.')
      },
      handler: (args) => ctx.invoke(`${ID}:review-search`, { id: args.id, title: args.title, artist: args.artist ?? '' })
    },
    {
      name: `${ID}__save-song-info`,
      description:
        'Write the given details into a held song file (title and artist required; empty fields are left as they are) and finish it — a Google Drive song is then uploaded and removed from this PC. Optionally use a MusicBrainz release cover (releaseId/releaseGroupId from __search-song-info). Destructive: rewrites the file’s tags. Requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Held song id from __songs-needing-info.'),
        title: z.string(),
        artist: z.string(),
        album: z.string().optional(),
        albumArtist: z.string().optional(),
        date: z.string().optional().describe('YYYY or YYYY-MM-DD'),
        track: z.string().optional().describe('"3" or "3/12"'),
        genre: z.string().optional(),
        releaseId: z.string().optional().describe('Use this release’s official cover art.'),
        releaseGroupId: z.string().optional(),
        confirm: z.boolean().optional().describe('Set true to write the tags.')
      },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Write "${String(args.title)}" by ${String(args.artist)} into the held song's tags${args.releaseId ? ' with the release cover' : ''}, then finish it (upload if it is a Google Drive download).`)
        if (gate) return gate
        return ctx.invoke(`${ID}:review-save`, {
          id: args.id,
          tags: { title: args.title, artist: args.artist, album: args.album, albumArtist: args.albumArtist, date: args.date, track: args.track, genre: args.genre },
          art: args.releaseId ? { kind: 'release', releaseId: args.releaseId, releaseGroupId: args.releaseGroupId ?? '' } : { kind: 'keep' }
        })
      }
    },
    {
      name: `${ID}__save-songs-as-is`,
      description:
        'Finish held songs WITHOUT changing their tags ("ignore") — the given ids, or every held song if none are given. Google Drive songs are uploaded and removed from this PC. Requires confirmation.',
      destructive: true,
      inputSchema: {
        ids: z.array(z.string()).optional().describe('Held song ids; omit for all.'),
        confirm: z.boolean().optional().describe('Set true to proceed.')
      },
      handler: (args) => {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Save ${ids ? `${ids.length} held song(s)` : 'every held song'} as is (no tag changes); Google Drive songs are uploaded.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:review-ignore`, { ids })
      }
    }
  ]
}

# YouTube Downloader

Paste a **YouTube** or **YouTube Music** URL — video, track, playlist or album —
pick a quality, and download to a folder you choose. Built on **yt-dlp** (the
standard downloader) plus the suite's bundled **ffmpeg** (for merging separate
video+audio streams and writing tags/cover art).

## YouTube Music

`music.youtube.com` links are served by the same yt-dlp extractor as regular
YouTube, so tracks, albums (`list=OLAK5uy_…`), playlists and radio mixes all
work. Three music-specific behaviors are worth knowing (`parseYtUrl` in
`ipc/ytdlp.ts` classifies the URL):

- **Track-vs-list disambiguation.** Clicking a song in YT Music gives you
  `watch?v=<track>&list=RDAMVM<track>` — the track *plus* an auto-generated radio
  mix. yt-dlp's default for a `v`+`list` URL is to take the **playlist**, so a
  naive download grabs the whole radio instead of the one song. The module detects
  this, probes both, and shows an explicit **"Just this track" / "Whole
  album·playlist·mix"** choice. Default: the whole thing for albums/playlists,
  **just the track** for radio mixes (those are effectively endless).
- **Music files get real tags.** The two audio presets embed `--embed-metadata`
  (artist/album/title) **and cover art** (`--embed-thumbnail`, converted to JPEG
  because YouTube serves WebP, which many taggers/players won't read). Without
  this, downloads land in a music library as untitled, art-less files. Audio
  filenames also lead with the artist, and album downloads get their own folder
  (`%(playlist_title,album,uploader)s`, with left-to-right fallbacks so missing
  tags degrade gracefully instead of writing "NA").
- **Personal library lists aren't supported.** `list=LM` (Liked Music) / `LL…`
  need a signed-in session, so the module says so up front rather than failing
  mid-download. Open the album/playlist itself and use its share link.

### Setting: "Audio only for YouTube Music links"

A persisted module preference (**on by default** — a `music.youtube.com` link is a
song, so pulling video is almost never what you want):

- The URL is classified **client-side as you type/paste** (`lib/url.ts` is shared
  by main and renderer, so no network round-trip is needed) — the quality switches
  to your chosen music format immediately, before you click Check or Download.
- **Music format** picker sits next to the toggle: MP3 or original. Changing it
  re-applies to the current link.
- **Per-link override**: video tiers are dimmed for a music link but still
  clickable — clicking one is a deliberate override for that link only (a badge
  appears with one click to go back). Pasting a new URL resets the override;
  picking a *different audio* preset is not treated as an override.
- Turning the setting on while a music link is loaded applies it right away;
  turning it off leaves your current selection alone rather than jumping back to
  video.
- Stored via the shell store (`yt-downloader.musicAudioOnly` /
  `.musicFormat`), so it survives restarts and is covered by Backup & Restore.
- The setting is a **UI preference only** — MCP callers pass an explicit
  `quality`, which is always honored as given.

## How it works

- **yt-dlp is managed, not bundled.** YouTube changes constantly and yt-dlp ships
  fixes almost weekly, so a pinned copy would rot. On first use the module
  downloads the latest yt-dlp release into
  `userData/modules/yt-downloader/bin/` (~20 MB) and offers an **Update** button
  (highlighted when the copy looks stale). `ipc/ytdlp.ts` owns this.
- **FFmpeg** comes from `ffmpeg-static` (asar-unpacked in a packaged build), passed
  to yt-dlp via `--ffmpeg-location`.
- **Check** (`probe`) runs `yt-dlp -J --flat-playlist` to detect video vs playlist,
  title, uploader and video count — fast metadata only, with a 90s cap.
- **Download** spawns yt-dlp and streams progress (via `--progress-template`) to
  the UI. It is a long-lived child process with **NO timeout**, so multi-hour
  playlist downloads run to completion. **Up to 3 downloads run concurrently** —
  each is a tracked job (`jobId`) whose progress events are tagged, rendered as
  its own status card in the right-hand column, and cancellable independently
  (cancel with no jobId kills all, which is what the MCP tool does). The setup
  form resets when a job starts so the next one can be queued immediately.
- **Combine order.** The playlist stitch is oldest → newest (playlist order) by
  default; the "Randomize export" sub-checkbox (persisted, only shown when
  combining is on) shuffles the stitch instead. File names are always numbered
  in playlist order (`%(playlist_index)04d` — 4 digits so 1000+-item playlists
  sort correctly) regardless of stitch order, and normalization runs at 60fps
  so high-frame-rate sources keep their smoothness.
- **Quality picker modes.** The Quality card has a Video / Music toggle: Video
  shows the resolution tiers, Music shows only the two audio presets.
- **Crash resume.** Started jobs are journaled to `pending-jobs.json` (written
  atomically, temp + rename) and cleared on completion/cancel. If the app or
  the whole PC dies mid-job, the next launch restarts the survivors (max 3
  attempts): yt-dlp skips finished files and continues `.part` files, and the
  job's manifest is kept across the crash so the combine still covers both
  runs' files. Job cards show up via `job-start`/`job-end` events even though
  the UI never invoked the job. Each card shows TWO bars: overall project
  progress and the current item's own %. Quitting the app with jobs running
  tree-kills yt-dlp/ffmpeg (no orphans) and the journal resumes them next
  launch. A user **cancel** is different: it leaves the journal, so its
  `.part`/`.ytdl` leftovers are swept (only once no other job shares the
  folder). Progress events are wired at module scope (robocopy pattern), so
  jobs keep updating the store while you're on another module's route.

- **JS runtime (Deno).** Since mid-2026 YouTube requires solving JavaScript
  challenges during extraction — yt-dlp without a JS runtime fails with "No
  supported JavaScript runtime could be found" + an HTTP error. The module
  auto-downloads the standalone Deno binary into its bin folder (beside
  yt-dlp.exe, where yt-dlp auto-discovers it — no flags/PATH changes) on the
  first download/probe, and refreshes it with the yt-dlp update button. The
  bin folder is already excluded from Backup & Cloud Sync. Shared with the
  Total Channel Downloader.

## Quality

Preset tiers, not per-video format IDs, so they apply uniformly to playlists:
`Best`, `2160p (4K)`, `1440p`, `1080p`, `720p`, `480p`, `360p`, plus two audio
presets for music:

| Preset | What you get |
| --- | --- |
| **Music / MP3** | `bestaudio` transcoded to MP3 320k — universally compatible |
| **Music / original** | `bestaudio` kept in YouTube's native codec (opus/m4a), **no lossy re-encode** — best fidelity |

Both audio presets embed artist/album tags and cover art. Each video tier is
`bestvideo[height<=N]+bestaudio` with a `/best` fallback, merged to MP4, and
yt-dlp picks the best available at-or-below the target, so a preset a given video
doesn't have degrades gracefully.

## Combine clips into one movie

Turn a downloaded **playlist/album into a single video**. Enable **"Combine clips
into one video"** (a persisted preference, `yt-downloader.combineClips`) before a
playlist *video* download; when it finishes, `ipc/combine.ts` shuffles the clips
and stitches them into one file saved alongside the individual videos
(`<Playlist title> - Combined <timestamp>.mp4`).

Playlist clips vary wildly in resolution, frame rate, codec, and some have no
audio, so a naive `concat -c copy` would fail or desync. The two-pass pipeline:

1. **Which files?** yt-dlp writes each final path to a manifest
   (`--print-to-file after_move:filepath`); a folder scan of freshly-written video
   files is the fallback. (`collectOutputs`)
2. **Normalize** every clip to identical parameters — scale+pad to a common 16:9
   canvas sized to the chosen quality, uniform fps, `yuv420p`, AAC 48k stereo,
   **synthesizing silence (`anullsrc`) for clips with no audio** (detected via the
   bundled `ffprobe`). One bad clip is skipped, not fatal.
3. **Concat** the normalized copies with a stream copy (`-f concat -c copy`) —
   fast and glitch-free because the inputs are now byte-compatible.

It only runs for **playlist + video** downloads (ignored for single videos and
audio jobs) and needs ffmpeg. It re-encodes every clip, so large playlists take a
while; progress is reported per clip and the whole thing is cancellable. The
argument construction, shuffle, file selection and silence-synthesis are unit-
tested, plus a real end-to-end ffmpeg stitch of mismatched clips.

## Output & robustness

- Single video → `<folder>/<title> [<id>].<ext>`.
- Playlist → `<folder>/<playlist title>/<index> - <title> [<id>].<ext>` (its own
  subfolder, zero-padded index order).
- Playlists use `--ignore-errors`, so one unavailable/private video doesn't abort
  the rest; the module reports how many completed and surfaces a soft warning if
  some were skipped.
- Re-downloading is safe — yt-dlp skips files already present.

## Downloaded songs + skipping duplicates (music downloads)

Every audio file this module downloads is recorded in
`modules/yt-downloader/downloaded-songs.json` (`ipc/library.ts: SongLibrary`):
YouTube video id (from the `[<id>]` in the file name), the title/artist it was
**downloaded as** and the title/artist/album it was **saved as** (after "Fix
missing song info" or a manual edit — `renamedAt`), MusicBrainz recording id,
length, playlist, where it lives (this PC path / Drive file id / *pending* while
uploading or waiting for info) and when. Header button **Downloaded songs (N)**
opens the list: search, **Forget** a song (or **Forget all…**) so it can be
downloaded again — files are never touched — and **Add songs already
downloaded** (scans the download folder and `WICKED Vault/YouTube Downloads` in
Drive for `[<id>]` audio files; the download folder is also scanned once on the
first launch with the list, when no download is running).

With **Skip songs I've already downloaded** (music setting, on by default):

- **Before downloading**: every known video id (and alias) is written into the
  job's yt-dlp `--download-archive` file, so yt-dlp skips them without
  downloading. **Check** shows "N of M already downloaded".
- **Same song, different video** (official audio vs lyric video, a re-upload):
  each finished song is checked against the list *before* the MusicBrainz lookup
  (its own title/artist + length) and again *after* (fixed info, MusicBrainz
  recording id). A match = same recording id, or same cleaned title + main
  artist + length within 3 s (`findSame`; remixes, live versions and other
  lengths don't match). The copy is deleted (not uploaded) and its video id kept
  as an **alias**, so the next playlist skips it up front.
- The job card shows "**N already downloaded** — skipped"; a playlist with
  nothing new says so. Video downloads (and combine) are unaffected.

## Fix missing song info (music downloads)

A setting shown in Music mode, **on by default**, with a sub-option **Use the
official album art** (also on). Every finished audio file goes through
`ipc/tagfix.ts` → `TagFixer` before it's handed on (to the Drive uploader, or
nowhere for a local download):

1. **Read** its tags with the bundled ffprobe (`ipc/tagio.ts`).
2. **Assess** (`lib/songinfo.ts: assessTags`): YouTube Music tracks are
   *trusted* (clean title/artist/album); a video upload — "Artist - Song
   (Official Video)" by "ArtistVEVO" / "… - Topic" — is not. The title is cleaned
   (Official Video, Lyrics, [4K]…), "Artist - Song" is split, and the channel
   name is cleaned for the search. *Complete* = trusted + title, artist, album
   and a year.
3. **Look it up on MusicBrainz** (`ipc/musicbrainz.ts`; free, no key; a
   descriptive User-Agent; **≤ 1 request/second** through one shared serial
   queue, 503 back-off). Phrase search first, then a looser one. A match must be
   *confident* (`isConfident`: title similarity ≥ 0.82, artist ≥ 0.6 or
   contained, duration within 12 s — or within 4 s when the artist is unknown).
   The recording's best release is the official original album (then EP,
   single; compilations/live/bootlegs last; earliest).
4. **Write** (`mergeMatch`): video-style title/artist/album/track are replaced;
   trusted ones are only filled where empty; the **release date always comes
   from the match** (the file's date is YouTube's upload date); genre (top
   release-group genre) only if missing. With official art on, the Cover Art
   Archive front cover (release, then release group, 500 px) replaces the
   embedded thumbnail. Writes are lossless (`-c copy`) into a hidden temp file
   that replaces the original: MP3 as ID3v2.3 (full YYYY-MM-DD kept), M4A atoms,
   and Opus by rebuilding the whole Vorbis comment set + METADATA_BLOCK_PICTURE
   from an ffmetadata file mapped onto the audio stream (a plain re-mux would
   drop the cover).

Counts go to the job card: **fixed · already complete · need info · skipped**.
If MusicBrainz can't be reached the song is passed on unchanged ("skipped") —
an outage never parks a playlist. Handled paths are journaled
(`tagged-<jobId>.txt` / `.wicked-tagged.txt`) so a resumed job doesn't redo
them.

**Songs it can't identify** (missing info, no confident match) are **held** on
`review.json` (survives restarts) and, for Drive jobs, kept in staging and *not
uploaded*. Click **"N need info →"** on the card (or the banner) to open **Song
info needed**: each song is prefilled with the cleaned guesses and shows what's
in the file now; **Search** MusicBrainz with what you typed and **Use** a match
to fill everything in; pick the cover (**keep current** / **album art from the
match** / **choose an image**); then **Save** (Drive: **Save & upload**) or
**Save as is**. **Ignore all — save as is** finishes every listed song
untouched. A Drive song uploads when saved and its staging folder is cleared
once nothing from that job is waiting; a cancelled Drive job drops its held
songs.

## Download to Google Drive (per link)

After you paste a link, a **Download to Google Drive** checkbox appears. It's an
option for **that link only** — it resets for every new URL and is never a saved
rule. It uses the Google Drive connected in **File Vault** (token only, via
`getDriveProvider()` in `file-vault/ipc/shared.ts`; no second sign-in) and is
disabled with a "Connect Google Drive in File Vault" link when Drive isn't
connected.

- **Where**: `WICKED Vault/YouTube Downloads/` + the same sub-folders a local
  download gets (a playlist/album gets its own folder). It's inside the vault, so
  File Vault shows the files too.
- **How (`ipc/drive.ts`)**: yt-dlp must write real files (it merges streams and
  embeds tags + cover art in place), so a Drive job downloads into a per-job
  staging folder, `<OS temp>/WICKED YouTube to Drive/<jobId>`. yt-dlp appends
  each finished file's final path to `.wicked-done.txt`
  (`--print-to-file after_move:filepath`); main reads it every 1.5 s and hands
  new files to a `DriveSink`, which uploads them one at a time with File Vault's
  resumable `resumableUpload`, **MD5-verifies** against Drive's checksum, then
  deletes the local file and its cover-art thumbnail. Staging only ever holds
  the song(s) in flight; the thumbnails aren't uploaded (the art is embedded).
- **End of job**: any media the list missed is swept from staging and uploaded,
  the queue drains, and staging is deleted. A file that still won't upload after
  3 tries is **moved to the normal download folder** (same sub-path) rather than
  lost, and the card says so. Same-named files already in the Drive folder are
  replaced in place (no "name (1)" copies).
- **Combine + Drive**: stitching needs every clip on disk, so a combine job
  uploads the clips and the movie after the combine.
- **Crash / quit**: staging and the journal entry are kept (`toDrive` is
  journaled); on the next launch the job resumes with
  `--download-archive .wicked-archive.txt`, so tracks already downloaded (and
  uploaded + deleted) are skipped, and anything still staged is uploaded. Quitting
  no longer clears the resume journal for any job. Staging folders whose job isn't
  resuming are swept at startup. **Cancel** aborts the upload and deletes staging.
- The job card shows a **Google Drive** line (uploaded / waiting / failed + the
  current file's upload bar) and **Open in Google Drive** when done.

## Data / MCP

- Download folder defaults to `Downloads/WICKED YouTube` (changeable; can be a
  network share) — set it with the **Set default save location** link in the
  header; the **Folder** button opens the current one. This is a **separate**
  save location from the Total Channel Downloader, so the two tools can target
  different folders. yt-dlp binary + module folder are shown in Settings →
  Modules.
- MCP: `yt-downloader__status` / `__probe` (read-only; status includes
  `googleDrive.connected`), `__download` (destructive, confirm-gated — writes
  files, can run long; optional `combine`, `toDrive`, `fixTags`, `officialArt`),
  `__update`, `__cancel`; downloaded songs: `__downloaded-songs` (read-only,
  searchable) and `__forget-downloaded-songs` (confirm-gated); download also takes
  `skipDuplicates`; song info: `__songs-needing-info` and
  `__search-song-info` (read-only), `__save-song-info` and `__save-songs-as-is`
  (destructive, confirm-gated).

## Note

Respect YouTube's Terms of Service and copyright — download only content you have
the right to (your own uploads, Creative-Commons, or with permission).

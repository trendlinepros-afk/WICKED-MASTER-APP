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
- **Crash resume.** Started jobs are journaled to `pending-jobs.json` and
  cleared on completion/cancel. If the app or the whole PC dies mid-job, the
  next launch restarts the survivors (max 3 attempts): yt-dlp skips finished
  files and continues `.part` files, and the job's manifest is kept across the
  crash so the combine still covers both runs' files. Job cards show up via
  `job-start`/`job-end` events even though the UI never invoked the job. Each
  card shows TWO bars: overall project progress and the current item's own %.

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

## Data / MCP

- Download folder defaults to `Downloads/WICKED YouTube` (changeable; can be a
  network share) — set it with the **Set default save location** link in the
  header; the **Folder** button opens the current one. This is a **separate**
  save location from the Total Channel Downloader, so the two tools can target
  different folders. yt-dlp binary + module folder are shown in Settings →
  Modules.
- MCP: `yt-downloader__status` / `__probe` (read-only), `__download`
  (destructive, confirm-gated — writes files, can run long; takes an optional
  `combine` flag), `__update`, `__cancel`.

## Note

Respect YouTube's Terms of Service and copyright — download only content you have
the right to (your own uploads, Creative-Commons, or with permission).

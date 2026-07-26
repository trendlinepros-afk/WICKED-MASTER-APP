# YouTube Downloader

Paste a YouTube **video** or **playlist** URL, pick a quality, and download to a
folder you choose. Built on **yt-dlp** (the standard downloader) plus the suite's
bundled **ffmpeg** (for merging separate video+audio streams into MP4).

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
  playlist downloads run to completion. One download runs at a time and is
  cancellable (kills the child).

## Quality

Preset tiers, not per-video format IDs, so they apply uniformly to playlists:
`Best`, `2160p (4K)`, `1440p`, `1080p`, `720p`, `480p`, `360p`, and
`Audio only (MP3)`. Each video-quality tier is `bestvideo[height<=N]+bestaudio`
with a `/best` fallback, merged to MP4; audio extracts to MP3. yt-dlp picks the
best available at-or-below the target, so a preset that a given video doesn't have
degrades gracefully.

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
  network share). yt-dlp binary + module folder are shown in Settings → Modules.
- MCP: `yt-downloader__status` / `__probe` (read-only), `__download`
  (destructive, confirm-gated — writes files, can run long), `__update`,
  `__cancel`.

## Note

Respect YouTube's Terms of Service and copyright — download only content you have
the right to (your own uploads, Creative-Commons, or with permission).

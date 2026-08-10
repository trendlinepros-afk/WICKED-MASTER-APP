# Total Channel Downloader

Paste a YouTube **channel** URL (`@handle`, `/channel/UC…`, `/c/…`, `/user/…`)
and download the creator's **entire long-form library**, then optionally stitch
it into **one movie in chronological order** (oldest → newest). Lives in the
"YouTube Downloader" folder next to the Custom Playlist Downloader and shares
its yt-dlp binary, bundled ffmpeg and download folder.

## How the filtering works

The channel's **/videos tab** is used as the playlist source. That tab only
contains regular long-form uploads — **Shorts, community posts and live
streams are excluded by YouTube itself**, so no duration heuristics are needed.
Any pasted channel URL is normalized to its `/videos` form first.

## Ordering

The Videos tab lists newest-first, so the download runs with `-I ::-1`
(reversed): videos arrive **oldest → newest**. Filenames are numbered with
`%(playlist_autonumber)04d` in that download order, which gives two nice
properties:

- Files sort chronologically in the folder.
- Numbering is stable across re-runs (new uploads only append at the end), so
  already-downloaded videos are skipped cleanly.

The optional stitch reuses the shared `combineClips` with `shuffle: false` —
the manifest (yt-dlp's `--print-to-file after_move:filepath`) preserves
download order, so the movie plays the channel's story oldest → newest. The
movie is saved in the channel's own subfolder as
`<Channel> - Full Channel <stamp>.mp4`.

## History, rescan and auto-rescan

Every download session records the channel in `history.json`: folder, quality,
`downloadedCount` (videos on disk) and `stitchedCount` (videos in the last
full movie). The history card offers per channel:

- **Rescan** — probes the channel and compares counts. New uploads → a popup
  offering "download + create the complete stitched movie" or "just download"
  (deferring the stitch). No new uploads but an unstitched backlog → offers to
  complete the movie now. A **complete stitch always reads the channel folder**
  (numbered files in name order), so it includes every session's videos no
  matter when they were downloaded; each stitch writes a new timestamped
  `- Full Channel` file (old ones are kept and never re-stitched into the next).
- **Auto rescan** (per-channel toggle) — ~30s after every app launch, enabled
  channels are probed and new uploads are downloaded automatically in the
  background (downloads only — stitching ALWAYS waits for the user). Fetched
  videos count into `autoDownloadedPending`; the next time the tool opens, a
  popup asks "create the new full-channel movie now, or postpone?". Postponing
  clears the nag until more videos arrive, but the unstitched backlog stays
  visible on the history card. The sweep never runs while a user job is active.

## Thumbnails

Every video's thumbnail is saved alongside it with the same basename
(`0001 - Title [id].jpg`), converted to JPG. Thumbnails never enter the stitch
(the combine manifest and the fallback scan only accept video extensions).

## Quirks

- Big channels are BIG: hundreds of videos at 1080p, each re-encoded once for
  the stitch. The UI warns at 50+ videos; expect hours and lots of disk.
- Members-only / region-locked videos are skipped (`--ignore-errors`) and
  reported as "finished with skips".
- One channel job runs at a time (unlike the playlist tool's 3 slots) — these
  jobs are heavy enough on their own.
- Interrupted stitches leave scratch under the module folder; it is swept on
  the next launch and excluded from backups/sync (same `combine-*` naming
  rules as the playlist tool).
- Don't close WICKED mid-stitch — the worker dies with the app.

# Music Player

Plays a music library straight off any folder or network share (UNC paths
work) — built for libraries organized **one folder per artist** full of
yt-dlp rips. Play/pause/next/previous, click-to-seek, shuffle + repeat,
playlists, search, hardware media keys, and a **sidebar mini player** so the
music keeps going (and stays controllable) in every WICKED tool.

## How it works

- **Streaming**: files reach the renderer over the `wkmusic://` scheme with
  full HTTP Range support (seeking = 206s), cloned from automatic-editing's
  proven `wcmedia://` handler. The scheme itself is registered in
  automatic-editing/ipc.ts — `registerSchemesAsPrivileged` may only run once
  per app, so all privileged module schemes share that one list. Only files
  under the configured library root are ever served. CSP allows `wkmusic:`
  in media-src/img-src (src/renderer/index.html).
- **Library scan** (main process): capped async walk (depth 8, 50k tracks)
  with throttled progress pushes so a cold SMB scan shows life. Metadata is
  folders + filenames by design: artist = top-level folder, title = filename
  minus extension, leading "NNN - " numbering and a trailing **exactly-11-char**
  `[YouTubeId]` (so "[Live]" survives). Art = the same-basename .jpg/.png/.webp
  yt-dlp saves next to the track, else the folder's first image. Durations
  come free from the audio element at play time — no ffprobe over SMB.
  Result cached to `library.json` (atomic write) → instant startup; Rescan
  on demand. No `fs.watch` (unreliable on SMB).
- **Playback engine** (`player.ts`): a module-scope `new Audio()` + zustand
  store — created once when the module chunk loads, so switching tools never
  stops the music (the React page unmounts; the engine does not). Traps
  handled: seeks are guarded until metadata arrives; on load errors the
  player auto-skips but stops after 5 consecutive failures (an unplugged NAS
  must not machine-gun 50k tracks); manual Next always wraps, auto-advance
  honors repeat off/all/one; Previous restarts the track when >3s in.
- **Sidebar transport**: the engine publishes into the shell-owned
  `useNowPlaying` store; `NowPlayingBar` in the ActivityBar shows art +
  title + prev/play/next from ANY tool (collapsed rail: a single play/pause
  button with the track in its tooltip). Position is deliberately NOT
  published (no 4 Hz sidebar re-renders).
- **Media keys**: `navigator.mediaSession` handlers + per-track metadata +
  explicit playbackState (Windows SMTC). No global shortcuts (module
  contract). The session activates on first play (a click), as designed.
- **Playlists**: `playlists.json` in the module data dir → included in
  Backup & Cloud Sync. Missing tracks are SKIPPED at render, never pruned on
  save — ids are relPath hashes, so tracks reappear after a rescan even if
  the NAS was offline for a while.
- **MCP**: `music-player__status` / `__control` (play/pause/toggle/next/prev)
  / `__playlists` / `__search`. Playback lives in the renderer, so control
  returns a friendly error until the tool has been opened once per session.

- **Volume**: the speaker icon in the player bar shows a vertical slider on
  hover; clicking the icon mutes/unmutes (the slider position is kept). The
  level persists per device via renderer Local Storage.
- **Full-window player**: click the track's art or title in the player bar
  for a big Now Playing view (blurred-art backdrop, large controls); the
  Minimize chevron (top right) drops back to the song lists, and the view
  closes itself if the queue ends.
- **Playlist quick-add**: inside a playlist, the header search box type-aheads
  over the whole library; ＋ on a suggestion adds it (✓ = already on the
  list). The dropdown stays open so several songs can be added in one go.

## Quirks

- The engine loads with the module's chunk — until the Music Player is
  opened once, the sidebar bar is hidden and MCP control politely refuses
  (nothing can be playing anyway).
- "Launch in separate window" runs a SECOND, independent player (separate
  renderer process) — the sidebar bar controls the main window's player
  only. Both can play at once; that's by design, not a bug.
- The library cache (`library.json`, ~5-8 MB at 50k tracks) lives in the
  synced module folder — it rides along in backups/sync, which is what makes
  playlists portable.
- The music folder itself is external — **NOT** backed up or synced
  (disclosed in Settings → Modules).

## Windows verification checklist

Pick the UNC root → live scan progress → instant cached library on relaunch;
play mp3/m4a/opus/webm with art; seek into unbuffered positions; switch to
another tool mid-song (audio continues, sidebar transport works expanded AND
collapsed); hardware media keys with another app focused; SMTC follows
in-app pause; playlists persist and skip (not prune) missing tracks; unplug
the NAS mid-playback → stops after ~5 skips with a message; MCP control
before/after first open; Settings → Modules shows both data paths.

# Automatic Editing

Port of the standalone **Zirtola AI Video Editor** (Electron, electron-vite 2) into the
WICKED suite. Multi-stage auto-edit pipeline: transcribe (OpenAI Whisper API, or a mock
transcript when keyless) → silence/retake removal → AI cut review → scene transitions →
AI-planned graphics (user-approved, rendered via the HyperFrames CLI) → music/SFX mix
with auto-ducking → NVENC-aware ffmpeg render queue → final export → shorts via
OpusClip + S3 upload.

## Layout

```
index.tsx            renderer entry (ex App.tsx) — module-internal nav: Library/Media/Editor/Shorts/Settings
store.ts             zustand store (project, playback, selection, EDL undo/redo, queue, settings)
views/, components/  renderer UI (ported 1:1, restyled onto shell tokens)
lib/api.ts           typed wrapper over window.wicked.invoke/on (ex window.zirtola preload API)
lib/ui.ts            className constants replacing the app's @apply component classes
shared/              types, id, time, timemap, channels — imported by BOTH renderer and ipc code
ipc.ts               default-export register(ctx): all main-process handlers + wcmedia protocol
ipc/                 ported main-process modules (project, db, queue, media/*, pipeline/*, ai/*, …)
```

## IPC channel map (standalone → WICKED)

Every channel from the app's `src/shared/ipc.ts` is renamed `domain:action` →
`automatic-editing:domain-action` (see `shared/channels.ts`), e.g.
`project:create` → `automatic-editing:project-create`,
`pipeline:transcript-estimate` → `automatic-editing:pipeline-transcript-estimate`.
Push events go through `ctx.getMainWindow()?.webContents.send`:
`queue:event` → `automatic-editing:queue-event`, `project:event` →
`automatic-editing:project-event`. Dropped channels: `update:*` (shell auto-updater
owns updates), `menu:*` (shell owns menus), `settings:set-key` (see Keys below).

## `wcmedia://` custom protocol

The preview player streams work-dir media (`preview.mp4`) through a privileged custom
scheme so `webSecurity` stays on. Two-phase registration, dictated by Electron:

- `protocol.registerSchemesAsPrivileged` must run **before app ready** — module ipc.ts
  files are imported at main-bundle load time, so it runs at **module scope** in `ipc.ts`.
  It may only be called once per app: if another module ever needs a privileged scheme,
  the calls must be merged into one list.
- `protocol.handle('wcmedia', …)` needs the ready app and runs inside `register()`
  (the shell calls it from `app.whenReady()`).

The handler is root-restricted (module data dir + configured projects folder + open
projects' work dirs, nothing else), and supports HTTP Range so `<video>` can seek.
The shell CSP already allows `wcmedia:` for `img-src`/`media-src`.

## API keys (shell central vault)

The standalone app kept its own safeStorage-encrypted `secrets.json`. In WICKED all
provider keys live in the shell vault (**Settings → API Keys**) and are read at call
time in the main process via `ctx.getApiKey` (bridged through `ipc/keys.ts`). Used ids:
`openai` (Whisper + optional GPT), `gemini`, `deepseek`, `anthropic`, `opusclip`,
`s3-access`, `s3-secret`. Key **values never reach the renderer** — the module settings
payload only carries presence booleans (`keysPresent`, `hosting.configured`), refreshed
live from the vault and re-fetched when the shell broadcasts
`SHELL_IPC.apiKeysChanged`. The module Settings page shows presence and points at the
vault; there is no key-entry UI here. Missing keys degrade gracefully: AI tasks fall
back to a mock provider, transcription falls back to a mock transcript.

## Data locations (module-scoped)

Everything persists under `<userData>/modules/automatic-editing/`: `settings.json`
(non-secret settings), `projects.db` (better-sqlite3 index/mirror; lazily loaded, with
a JSON-index fallback if the native module can't load), and the default master projects
folder when the user doesn't pick one. The user-chosen master folder gets `Projects/`
and `Assets/` subfolders, exactly like the standalone app.

## Dependency isolation

Renderer code is code-split by the shell (`React.lazy` per module). Heavy main-process
deps stay off the shell-startup path:

- `better-sqlite3` — `require`d lazily on first DB access (`ipc/db.ts`).
- `@aws-sdk/client-s3` / `s3-request-presigner` — `await import()` inside `upload()`.
- `@anthropic-ai/sdk` — `await import()` inside the Anthropic provider's `complete()`.
- `ffmpeg-static` / `ffprobe-static` — resolved at ipc-module load, but these only
  export a path string (cheap). The asar-unpack path fixup (`app.asar` →
  `app.asar.unpacked`) is kept for packaged builds; dev runs use node_modules directly.
- OpenAI (Whisper + chat) and Gemini/DeepSeek are plain `fetch` calls — the `openai`
  npm package is **not** used (the standalone app didn't use it either, so the
  openai-v6-at-root concern was moot).

## Render queue / cancellation

Single-slot queue (media jobs are disk/GPU heavy). Every job is abortable; cancel kills
the ffmpeg child (`SIGKILL`) or the HyperFrames process tree (`taskkill /T /F`).
`register()` hooks `app.on('before-quit')` → `renderQueue.cancelAll()` so child
processes die with the app. OpusClip polling runs detached from the queue and stops
cleanly if the project is deleted mid-poll.

## Dropped vs the standalone app

- **App menu + recent-projects menu** (`menu.ts`) — the shell owns menus/windows. The
  menu's commands (New/Open/Import/Save/Save As) all remain reachable from the UI.
- **Help BrowserWindow** — modules may not create windows; not worth porting inline.
- **Auto-updater** (`updater.ts`, UpdateModal, Settings→Updates) — the shell updates
  the whole suite.
- **Single-instance lock / userData migration** (`migrate.ts`) — shell concerns.
  Projects from the standalone app can still be opened via *Open Project…* (their
  `project.json`), but settings/keys must be re-entered (keys now live in the vault).
- **OS drag-and-drop into the media pool** — needs `webUtils.getPathForFile` in the
  preload, which the shared shell preload doesn't expose. Dropping shows a hint to use
  the Import button (`lib/dnd.ts`).

## Quirks carried over

- Source footage is referenced **in place** and never modified; all intermediates land
  in the project work dir. `project.json` is the source of truth; SQLite is the fast
  index + crash-recovery mirror.
- All EDL events are stored in SOURCE time; `shared/timemap.ts` converts to the trimmed
  timeline at render/UI time (the same code runs in main and renderer).
- Stage 4 (graphics) pauses at `awaiting-approval` until the user approves the AI plan;
  only approved graphics render. HyperFrames CLI missing → labeled placeholder slates.
- NVENC is auto-detected once per run and used when the user preference allows.
- Styling was mapped from the app's custom palette onto the shell theme tokens
  (see `lib/ui.ts`) so both shell themes render correctly.

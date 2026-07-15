# Desktop Coding App (`coding-app`)

Ollama-first AI coding assistant with cloud fallback (OpenAI / Anthropic /
Gemini / DeepSeek), ported into the WICKED suite from the standalone
"Local LLM Coding Assistant" Electron app (v0.1.17).

What it does:

- **Chat with plan / ask / auto modes** — the model proposes file changes as
  fenced code blocks (`title="path"`); *plan* never writes, *ask* previews the
  changes for approval, *auto* writes files and runs ```bash blocks
  automatically (with a destructive-command denylist).
- **Model switcher** — every downloaded Ollama model plus configured cloud
  models, with VRAM-fit flagging, speed hints, favorites, and a load/unload
  button + live VRAM meter. Paid cloud requests show a cost-estimate
  confirmation first.
- **Project workspace** — Monaco editor + file tree over a chosen project
  folder (a chokidar watcher keeps the tree/preview live).
- **Run console** — plays the project (`python main.py` / `node index.js` /
  `npm start`, auto-detected), streams stdout/stderr, and can auto-send a
  failed run's output back to the chat for diagnosis.
- **Live preview** — an embedded Express server (port `30123`) serves static
  sites / built SPAs; Node apps get `npm start` spawned. Rendered in-app.
- **Gemini screenshot analysis** — captures the live preview in a hidden
  offscreen window, sends it to `gemini-2.5-pro` for visual QA, and can drive
  an automated fix through the active coding model.
- **Conversation history** — saved as Markdown (plus a hidden JSON sidecar)
  into a user-chosen Obsidian vault folder.

## Port notes

### API keys → shell vault (security change)

The standalone app stored provider API keys in **plaintext** in its
`config.json`. That whole mechanism is gone:

- Keys now live in the WICKED shell's central, safeStorage-encrypted vault
  (**Settings → API Keys**). Main-process code reads them at call time via
  `ctx.getApiKey(provider)` (see `ipc/services/keys.ts`).
- Key values never reach this module's renderer — it only sees set/not-set
  booleans via the shell's `shell:apikeys-status` channel (and live updates
  via `shell:apikeys-changed`).
- The module Settings → API Configuration panel no longer has key inputs; it
  shows key presence and points to the shell settings, and keeps the
  per-provider model picker / enable toggle / "Test key" button.
- Any `apiKey` fields found in an old config (including the one-time import
  of the standalone app's config, see below) are silently dropped and never
  re-persisted.

### Updater removed

The standalone app self-updated with electron-updater (`update:*` channels,
UpdateBanner, "Check for Updates", `autoCheckUpdates` setting). All removed —
the WICKED shell owns updates. Same for theming: the `theme` setting, the
theme-cycle button and `nativeTheme` handling are gone; the module follows the
shell's `.dark` class (a MutationObserver keeps Monaco's editor theme in sync).

### IPC channel map

All channels renamed to the `coding-app:` namespace (`shared/ipc.ts` is the
single source of truth; `lib/bridge.ts` recreates the old `window.api` surface
over `window.wicked.invoke/on`):

| Standalone | WICKED |
| --- | --- |
| `config:get/update/path/restore-backup` | `coding-app:config-get/-update/-path/-restore-backup` |
| `models:list` | `coding-app:models-list` |
| `ollama:status/start/load-model/unload-model/pull-model/cancel-pull` | `coding-app:ollama-*` (same suffixes) |
| `ollama:pull-progress` (event) | `coding-app:ollama-pull-progress` |
| `provider:test` | `coding-app:provider-test` |
| `chat:send/stop/estimate-cost` | `coding-app:chat-send/-stop/-estimate-cost` |
| `chat:stream` (event) | `coding-app:chat-stream` |
| `conv:list/load/save/delete` | `coding-app:conv-*` |
| `project:create/open/set-active` | `coding-app:project-*` |
| `file:tree/read/write/delete/rename/apply-blocks/preview-blocks` | `coding-app:file-*` |
| `file:changed` (event) | `coding-app:file-changed` |
| `preview:start/stop/status` | `coding-app:preview-*` |
| `run:start/stop/status/command` | `coding-app:run-*` |
| `run:log`, `run:exit` (events) | `coding-app:run-log`, `coding-app:run-exit` |
| `screenshot:capture` | `coding-app:screenshot-capture` |
| `gemini:analyze/apply-fix` | `coding-app:gemini-analyze/-apply-fix` |
| `dialog:pick-folder` | `coding-app:pick-folder` |
| `logs:export` | `coding-app:logs-export` |
| `app:open-external` | `coding-app:open-external` |
| `prereqs:check` | `coding-app:prereqs-check` |
| `gpu:detect-vram` | `coding-app:gpu-detect-vram` |
| `app:version` | *(dropped — renderer reads module.json)* |
| `update:check/install`, `update:status` | *(dropped — shell owns updates)* |

### Storage

- Non-secret config: `<userData>/modules/coding-app/config.json` (plain JSON,
  deep-merged over defaults on load, `config.backup.json` snapshot before
  every write, restore via Settings → Advanced).
- Logs: `<userData>/modules/coding-app/logs/app.log` (Settings → Advanced →
  Export app logs).
- First run only: silently imports the standalone app's settings from
  `%APPDATA%\Local LLM Coding Assistant\config.json` (or the dev-build
  `local-llm-coding-assistant` folder) if found — minus its plaintext API
  keys and the dropped `theme`/`autoCheckUpdates` fields.
- Conversations stay wherever the user's Obsidian vault points (unchanged).

### Other porting changes

- **Monaco is bundled locally.** The standalone app used
  @monaco-editor/react's default CDN loader; the shell's CSP
  (`script-src 'self'`) blocks that, so `lib/monaco.ts` points the loader at
  the local `monaco-editor` package and registers its Vite web workers.
- **Live preview uses `<webview>`, not `<iframe>`.** The shell CSP would block
  an iframe to `http://127.0.0.1:30123`; the shell window enables
  `webviewTag` for exactly this.
- **Ollama auto-start is lazy.** The standalone app spawned `ollama serve` at
  app launch; here it happens the first time the module is opened in a shell
  session (if the setting is on), so an unused module costs nothing.
- **Process cleanup on quit.** `register()` hooks `before-quit` to stop the
  preview server, kill run/command child processes, and close the file
  watcher — the standalone app did this in its own main entry.
- Styling was mapped from the app's private tokens
  (`surface/content/border/accent-fg`, red/green/amber utilities) to the shell
  tokens (`bg/surface/raised/edge/ink/muted/accent/accent-ink/danger/ok/warn`)
  so both shell themes look right. The run console intentionally stays
  always-dark, like a terminal.

## Quirks carried over from the standalone app

- The preview server port is fixed at `30123`; a Node project's dev server is
  *assumed* to bind it (`PORT` env is set, but apps that ignore it won't show).
- Run detection is heuristic: `package.json` start script, then
  `main/app/game/snake/run.py`, then `index/server/app/main.js`.
- `runCommand` blocks obviously destructive commands (`rm -rf`, `format`,
  `shutdown`, fork bombs, …) but is not a sandbox — Full Auto mode runs what
  the model emits in ```bash blocks.
- Gemini screenshot analysis is hard-pinned to `gemini-2.5-pro` (per the
  original spec, not user-selectable) and requires the live preview running.
- Chat requires an active project (so generated files have a destination).
- Ollama must be on PATH for auto-start/prereq detection; the endpoint is
  configurable for remote instances.

# Wicked AI Chat (module `ai-chat`)

Port of the standalone **WICKED Desktop AI Chat** app (v1.0.42) into the WICKED
suite. One window, every model, one memory: multi-model chat (OpenAI, Gemini,
DeepSeek, local Ollama) with an Obsidian memory vault, agent "brain" personas,
MCP tool use, voice (dictation / calls / read-aloud), local image generation
via ComfyUI, FluxGym LoRA training, prompt templates, chat links/branching,
project boards, PDF/Markdown export and a LAN web portal.

## Port notes

### Removed upstream before the port
- The **Role Play** feature (and everything grok-related) was removed on the
  source's `remove-roleplay` branch before this port. Nothing RP-related was
  carried over.

### API keys — central vault
- The standalone app stored OpenAI/Gemini/DeepSeek keys encrypted in its own
  sqlite settings. In the suite, keys live **once** in the shell:
  **Settings → API Keys**. This module reads them in the main process via
  `ctx.getApiKey(provider)` at call time and **never sends a key value to the
  renderer** (or to the web portal).
- To make that possible, all provider calls moved from the renderer into the
  main process (`ipc/providers.ts`): chat streaming (cumulative text is pushed
  on `ai-chat:stream-token`), the MCP tool loop, non-streaming completions
  (titles/summaries), Gemini image generation, embeddings for the Brain's
  semantic index, voice STT/TTS, and model discovery.
- The module's Settings dialog shows **set / not-set indicators** only (via
  `SHELL_IPC.apiKeysStatus` semantics, updated live on
  `SHELL_IPC.apiKeysChanged`), with a pointer to Settings → API Keys.
- Legacy key rows found in a carried-over database are ignored and scrubbed.
- Non-secret settings (default model, Ollama URL, vault path, portal port,
  Comfy/FluxGym paths, voice models, …) stay in the module's own sqlite
  settings as before.

### Data location
- The chat database now lives at
  `%APPDATA%\WICKED-Suite\modules\ai-chat\wicked.db` (plus WAL files).
  Project Boards default to `%APPDATA%\WICKED-Suite\modules\ai-chat\ProjectBoards`.
- The standalone app's data (`%APPDATA%\wicked\` and its database) is **not
  auto-imported** — the suite's AI Chat starts fresh. Bring it across with the
  built-in importer (below) rather than by copying files.

### Importing the old standalone app (`ipc/importStandalone.ts`)
- **AI Chat → Settings → "Import from the standalone Wicked app"** appears
  automatically when a previous standalone database is found. It scans the
  likely app-data folders (`%APPDATA%\wicked`, `Wicked`, `WICKED`,
  `desktop-ai-chat-app`, …) for any SQLite file that has `chats` + `messages`
  tables and offers the richest one.
- It imports **chats, folders, messages, agent personas ("brains"), prompt
  templates, chat links and safe settings (incl. the memory `vaultPath`, so
  memory reconnects)**. It is **additive and idempotent**: `INSERT OR IGNORE`
  on primary keys, wrapped in a transaction with foreign keys briefly disabled,
  so nothing is deleted/overwritten and re-running only fills gaps.
- **Schema-tolerant**: the source is introspected at runtime
  (`sqlite_master` / `PRAGMA table_info`) and only columns present in both
  schemas are copied; our NOT-NULL columns get sane defaults, and message
  bodies that aren't already content-parts JSON are wrapped so they render.
- **Never imported**: provider API keys (they live in the shell vault — legacy
  key rows are skipped and scrubbed) and the install-specific web-portal token.
- Also exposed over MCP: `ai-chat__scan-standalone-import` (read-only) and
  `ai-chat__import-standalone` (confirm-gated).
- The configurable **data root** ("consolidate to one folder", rolling 6-hourly
  DB backups, 14 kept) works exactly as before.

### Web portal — OFF by default
- The LAN portal (HTTP + self-signed HTTPS twin on port+1 for phone
  microphone access) is kept but **disabled by default**; enable it in the
  module's Settings → Web portal. It serves the built WICKED renderer and
  mirrors exactly the module's `ai-chat:*` handler registry over
  `/__portal/rpc` (token-gated). Since keys never transit IPC anymore, the
  portal cannot expose key values (the standalone portal used to serve
  decrypted keys inside `settings:get` — that hole is gone).
- Portal limitations in the suite: no push events (chat replies appear when
  complete rather than token-by-token), desktop-only actions (native dialogs,
  PDF export, opening folders) are replaced with browser equivalents or
  politely refused, and shell-level screens (updates, key management) are
  stubbed. The portal browser lands directly on `#/m/ai-chat`. In dev
  (`npm run dev`) there is no built renderer, so only the RPC endpoint works.

### Kept as-is
- **ComfyUI integration**: status/VRAM, checkpoint/LoRA discovery, Flux vs
  SDXL family auto-detection, custom API-format workflows, background
  launcher (auto-launch at startup when a launch path is configured,
  tree-kill on quit).
- **FluxGym LoRA training**: dataset preparation with trigger-word captions,
  training polling, LoRA install into ComfyUI, background launch. On quit a
  live training run is deliberately **orphaned, not killed**.
- **Ollama**: model manager (pull/delete), and the Load/Unload kill-switch —
  `keep_alive: -1` pins a model in memory, `keep_alive: 0` unloads it; launch
  state is IDLE/unloaded. Preserved exactly (renderer-side calls to the local
  server, no key involved).
- **Vault git sync**, brain folder digest/search, scheduled auto-memory,
  recycle bin (30-day retention), chat links, branching, global search,
  prompt templates, usage/cost estimates, onboarding tour.
- **PDF export** still renders through an offscreen BrowserWindow in the main
  process.

### Removed in the port
- Window/menu/tray/second-instance/lifecycle management — the shell owns the
  window.
- The updater (electron-updater + manual GitHub release check and the
  UpdateChecker UI) — the shell owns updates.
- The module's own light/dark theme store and toggles — the module inherits
  the shell theme; the standalone palette (`bg-app`, `text-text-muted`,
  `brain`, `idea`, …) was remapped onto the shell tokens
  (`bg/surface/raised/edge/ink/muted/accent/warn/ok`).

### Module shape
- `index.tsx` — entry (was App.tsx); global key handlers (Ctrl+B brain panel,
  Esc closes settings) bind on mount / unbind on unmount only.
- `shared/rpc.ts` — the method → channel map (`ai-chat:*`). Three surfaces are
  generated from it: the renderer bridge (`lib/bridge.ts`, replaces
  `window.polyglot`), the main-process handler registry (`ipc.ts`), and the
  web portal's allow-list + browser bridge (`ipc/webPortal.ts`).
- `ipc/` — main-process code (db, vault, brainFolder, projectBoard, dataRoot,
  comfy, comfyLauncher, fluxGym, mcp, providers, webPortal), file granularity
  kept from the standalone `electron/` folder.

### Quirks carried over
- The live SQLite DB intentionally stays on the local disk (WAL over SMB is a
  corruption risk); the data root only receives rolling backups.
- Voice features need an OpenAI key; the Brain's semantic index also uses the
  OpenAI key for embeddings and silently degrades to keyword search without it.
- Message timestamps are forced strictly increasing per chat so
  regenerate/edit range-deletes can't eat a sibling message.

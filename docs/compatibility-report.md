# WICKED Compatibility Report

Inventory date: 2026-07-15. Full per-app details live in the migration notes of each
module README; this report covers what matters for integration.

## The headline finding

**Only 4 of the 11 apps are Electron/React.** The other 7 are native Windows or
non-JS apps. "Version conflicts" are therefore a small part of the story — the real
integration question per app is *port, rewrite, or wrap*.

| # | App | Source tech | Integration path |
| --- | --- | --- | --- |
| 1 | Secret Key Generator | Python / Tkinter (121 lines) | **Rewrite** in React (Web Crypto) — trivial scope |
| 2 | ROBOCOPY GUI | C# WPF (.NET Framework 4.8) | **Rewrite**: command-builder UI + spawn `robocopy.exe`, stream output |
| 3 | Windows Event Viewer Analyzer | C# WinForms (.NET 8) | **Rewrite**: `Get-WinEvent` via PowerShell in main + AI summary |
| 4 | 365 Email Cleanup | C# WPF + Outlook COM + Ed25519 licensing | **Wrap (launcher)** — COM automation + licensing too coupled to port this pass |
| 5 | CodeLens | Electron 35 / React 18.3 | **Port** (cleanest fit) |
| 6 | MFA Tool | Python (TOTP/QR/encrypted vault), unfinished | **Rewrite**, marked **Beta** |
| 7 | Wicked Optomizzzer | C# WPF .NET 8, `requireAdministrator`, 34 views | **Wrap (launcher)** — too large to port this pass |
| 8 | GameDev Project Board | Single-file HTML + vanilla JS + IndexedDB | **Rewrite** in React (small) |
| 9 | Wicked AI Chat (`desktop-ai-chat-app`) | Electron 33 / React 18.3 | **Port** (after RP removal) |
| 10 | Desktop Coding App (`desktop-coding-app`) | Electron 33 / React 18.3 | **Port** |
| 11 | Automatic Editing (`automatic-editing`) | Electron 31 / React 18.3 | **Port** (heavy deps isolated — see below) |

The two **launcher-wrapped** apps keep shipping as their own exes; their WICKED
modules provide launch/status UI and spawn the exe on demand. This also solves
elevation cleanly (see below). They are candidates for incremental ports later.

## JS dependency matrix (the 4 Electron apps + shell decision)

| Dep | CodeLens | AI Chat | Coding App | Automatic Editing | **Shell standard** |
| --- | --- | --- | --- | --- | --- |
| React | ^18.3.1 | ^18.3.1 | ^18.3.1 | ^18.3.1 | **18.3.1** (no conflict) |
| Electron | ^35.0.0 | ^33.3.1 | ^33.3.1 | ^31.4.0 | **^35** — all modules run on the shell's Electron |
| TypeScript | ^5.6.3 | ^5.7.2 | ^5.7.3 | ^5.5.4 | **^5.7.2** |
| Vite | ^6.0.0 (electron-vite 3) | ^6.0.7 (vite-plugin-electron) | ^5.4.11 (electron-vite 2) | ^5.4.2 (electron-vite 2) | **Vite 6 + electron-vite 3** |
| Tailwind | ^3.4.15 | ^3.4.17 | ^3.4.17 | ^3.4.10 | **^3.4.17** (not v4 — sources use v3 config) |
| State | none (hooks) | Zustand **^5.0.2** | Zustand **^5.0.2** | Zustand **^4.5.4** | **Zustand 5** (dominant; v4 store code is API-compatible for our usage) |
| Persistence | electron-store ^8.2.0 | better-sqlite3 ^11.8.1 | plain JSON config | better-sqlite3 ^11.3.0 | electron-store 8 (shell) + better-sqlite3 **^11.8.1** (modules that need SQL) |
| Updater | — | electron-updater ^6.8.9 | ^6.3.9 | electron-updater | **Shell-level only** — module updaters are removed |
| AI SDKs | @anthropic-ai/sdk ^0.104.1, openai ^6.42.0 | openai ^4.77.0, @google/generative-ai ^0.21.0 | @google/generative-ai ^0.21.0 | @anthropic-ai/sdk ^0.110.0 | **@anthropic-ai/sdk ^0.110.0, openai ^6.x, @google/generative-ai ^0.21.0** — one copy each, shared AI-routing service |

### Conflicts found & resolutions

1. **Electron 31 / 33 / 35 spread** — resolved by definition: one main process, the
   shell's Electron ^35. Risks checked: `better-sqlite3` needs a rebuild against
   Electron 35 (`npm run rebuild`, wired via electron-builder `install-app-deps`);
   Automatic Editing's `protocol.registerSchemesAsPrivileged` must run before
   `app.ready` in the *shell* main (module ipc.ts files are imported before ready, so
   the hook exists).
2. **openai SDK major split (v4 vs v6)** — chat app uses v4 (`openai@^4.77.0`),
   CodeLens uses v6. Standardized on **v6**; the chat app's OpenAI-compatible calls
   (chat completions + streaming) are the same surface in v6, adjusted at port time.
3. **Zustand 4 vs 5** — Automatic Editing's store is written with `create()` +
   hooks only, no v4-removed APIs → runs on v5 unchanged.
4. **Vite plugin families differ** (electron-vite 2/3 vs vite-plugin-electron) —
   irrelevant after migration: only the shell builds; module renderer code is plain
   React bundled by the shell's Vite, module main-process code is bundled into the
   shell main via `import.meta.glob`.
5. **Updater collision** — three apps ship their own electron-updater pointing at
   three different GitHub repos. All module-level updaters are stripped; the shell's
   single updater owns updates (self-hosted feed now, GitHub Releases after push).
6. **Duplicate "zirtola" identity** — `automatic-editing` and `godot-devpad` both use
   package name `zirtola`. Only automatic-editing is part of WICKED; its module id is
   `automatic-editing`, so no collision inside the suite.
7. **userData collisions** — chat app renames userData and Automatic Editing expects
   its own; inside WICKED every module gets a subfolder under WICKED's userData
   (`<userData>/modules/<id>/`). Existing standalone data is intentionally *not*
   auto-imported this pass.

## Native/system dependencies by module

| Module | Native surface | Isolation plan |
| --- | --- | --- |
| automatic-editing | `ffmpeg-static`/`ffprobe-static` (asarUnpack), better-sqlite3, `wcmedia://` privileged scheme, S3/OpusClip/Whisper APIs | deps imported only inside module ipc; scheme registered by module hook pre-ready; render queue stays in main-side module code |
| ai-chat | better-sqlite3, git (vault sync), ComfyUI/FluxGym spawning, LAN portal (selfsigned) | module-private; portal + Comfy/FluxGym carried over as-is |
| coding-app | spawns `ollama serve`, `npm start` previews, arbitrary run-commands, express server, Monaco, webview | `webviewTag` enabled on shell window; runner confined to chosen project dir (as in source) |
| codelens | none (pure fs scan + AI) | — |
| robocopy-gui | spawns `robocopy.exe`; per-job elevation | on-demand `Start-Process -Verb RunAs` per job |
| event-viewer | PowerShell `Get-WinEvent`; Security log may need admin | elevation on demand, not app-wide |
| mfa-tool | none (pure JS TOTP + Web Crypto vault) | — |
| secret-key-generator / gamedev-board | none | — |
| optomizzzer (launcher) | wraps `WickedOptimizer.exe` (**requireAdministrator**) | UAC fires only when the user clicks Launch |
| 365-email-cleanup (launcher) | wraps `InboxCleanup.exe` (Outlook COM, licensing) | plain spawn; no elevation needed |

**The whole suite runs unelevated.** Nothing in the shell or any ported module
requires admin; the two elevation cases (Optomizzzer launch, ROBOCOPY/EventViewer
admin actions) elevate per-invocation.

## Security flags found during inventory

- **Hardcoded DeepSeek API key** in Event Viewer Analyzer source
  (`src\Config.cs:12`), compiled into its shipped exe. **Rotate that key.** The
  ported module reads the key from WICKED settings instead.
- Desktop Coding App stores API keys in **plaintext** `config.json`; ported module
  uses Electron `safeStorage` (the pattern Automatic Editing already uses).
- Chat app's LAN web portal mirrors the entire IPC surface over HTTPS with
  self-signed certs — carried over but off by default in the module.

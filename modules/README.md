# WICKED Module Contract

Every app in the WICKED suite lives in its own folder under `/modules`. The shell
discovers modules **at build time** by scanning `modules/*/module.json` — adding a new
module requires **zero shell code changes**: drop a correctly-shaped folder here and
rebuild.

## Folder shape

```
/modules/<module-id>/
  module.json     # manifest (required)
  index.tsx       # default export = React component, mounted at /m/<module-id> (required)
  ipc.ts          # optional — main-process handlers, auto-registered at startup
  store.ts        # optional — module's own Zustand store slice
  README.md       # what this module does + quirks carried over from the standalone app
  <anything else> # components/, lib/, assets/ — module-private code
```

## module.json

```json
{
  "id": "robocopy-gui",
  "name": "ROBOCOPY GUI",
  "icon": "Copy",
  "version": "1.0.0",
  "description": "Build, run and monitor robocopy jobs",
  "status": "stable"
}
```

| Field | Rules |
| --- | --- |
| `id` | kebab-case, unique. Doubles as the route (`/m/<id>`) and the IPC namespace. |
| `name` | Shown in the nav tooltip and module header. |
| `icon` | A [lucide](https://lucide.dev) icon name in PascalCase (e.g. `KeyRound`). |
| `version` | Version of the module (usually carried over from the standalone app). |
| `status` | `stable`, `beta` (yellow dot in nav), or `external` (wraps an external exe). |
| `external` | Only for `status: "external"`: `{ "program": "...", "elevated": true }`. |

## index.tsx

Default-export a React component. It renders inside the shell's router with the
shell's theme already applied (Tailwind `dark:` variants + `--wk-*` CSS variables).
Do **not** create your own `BrowserWindow`, register global shortcuts, or touch
`document.documentElement` theme classes.

```tsx
export default function RobocopyGui(): React.JSX.Element {
  return <div className="h-full overflow-y-auto p-6">…</div>
}
```

The component gets the full viewport right of the activity bar; own your scrolling
(`h-full overflow-y-auto`).

## ipc.ts (optional)

Runs in the **main process**. Default-export a `register(ctx)` function; the shell
calls it once at startup with:

```ts
interface ModuleIpcContext {
  ipcMain; app; shell; dialog
  getMainWindow(): BrowserWindow | null
  storeGet<T>(key: string, fallback: T): T   // shared electron-store persistence
  storeSet(key: string, value: unknown): void
}
```

Rules:

- **Namespace every channel** as `<module-id>:<action>` (e.g. `robocopy-gui:start-copy`).
  Collisions across modules are a bug; the namespace is the module id, always.
- Renderer side calls channels via `window.wicked.invoke(channel, ...args)` and
  subscribes via `window.wicked.on(channel, cb)` (returns an unsubscribe function).
- Long-running work must be cancellable and must not block the main process —
  spawn child processes or use async work; push progress with
  `getMainWindow()?.webContents.send('<module-id>:progress', …)`.
- **Elevation:** never require WICKED itself to run as admin. If an action needs
  admin rights, launch that specific action elevated on demand (PowerShell
  `Start-Process -Verb RunAs`) so the UAC prompt happens only when the user invokes
  that action.

## API keys (central vault)

Provider API keys (Anthropic, OpenAI, Gemini, DeepSeek, OpusClip, S3) are managed
**once** in the shell: Settings → API Keys. Rules for modules:

- **Never store provider keys yourself** — no module-level key settings, no keys in
  electron-store/JSON/db.
- Main process: read with `ctx.getApiKey('openai')` (returns decrypted string or
  `null`). Read at call time — don't cache long-term, the user can change keys.
- **Never send a key value to the renderer.** For UI states ("Gemini key missing"),
  the renderer may query `SHELL_IPC.apiKeysStatus` (booleans per provider) and
  subscribe to `SHELL_IPC.apiKeysChanged`.
- If a key is missing, show a short notice pointing at Settings → API Keys.
- Local services that need no key (Ollama, ComfyUI) are configured inside the
  module.

## store.ts (optional)

Module state lives in its own Zustand store (Zustand 5). Persist through your ipc.ts
(`storeGet`/`storeSet`) or module-owned files under `app.getPath('userData')` — do not
write into another module's keys. Prefix shared-store keys with `<module-id>.`.

## Dependency rules

- The shell provides: `react`, `react-dom`, `react-router-dom`, `zustand`,
  `lucide-react`, Tailwind. Import them normally; do not add duplicate copies.
- Module-specific deps go in the **root** package.json (single `node_modules`).
  Heavy deps (ffmpeg, sqlite) must be imported **only inside the module** — renderer
  code is code-split per module (`React.lazy`), so a heavy module doesn't slow the
  others; main-process deps load lazily inside handlers where startup cost matters.
- Native modules (e.g. `better-sqlite3`) must be listed in the root package.json so
  `electron-builder install-app-deps` rebuilds them for the shell's Electron.

## Checklist for porting a new app

1. Create `/modules/<id>/` with `module.json` (+ this doc's rules).
2. Renderer code → `index.tsx` (+ components). Replace the app's own window/menu/theme
   handling with shell equivalents.
3. Main-process code → `ipc.ts`, all channels renamed to `<id>:*`.
4. Settings/persistence → `storeGet`/`storeSet` or userData files under a
   module-named subfolder.
5. Update dependencies in root package.json; `npm run typecheck && npm run dev`.
6. Write the module `README.md` (quirks, carried-over behavior, elevation notes).

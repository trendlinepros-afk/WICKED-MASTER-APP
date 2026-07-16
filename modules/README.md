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
  mcp.ts          # REQUIRED — exports this module's MCP tool definitions for AI agents
  ipc.ts          # main-process handlers, auto-registered at startup (required if the module has any)
  store.ts        # optional — module's own Zustand store slice
  README.md       # what this module does + quirks carried over from the standalone app
  <anything else> # components/, lib/, assets/ — module-private code
```

`mcp.ts` is **mandatory** for every module going forward (see the MCP section
below). A renderer-only module with no main-process actions may export an empty
tool array, but the file must exist so its capabilities are consciously decided,
not forgotten.

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

## mcp.ts (required) — expose the module to AI agents

Every module ships an `mcp.ts` so its actions are callable by an MCP client
(Claude Desktop, Claude Code, or any MCP client) through the shell's built-in MCP
server (localhost only, toggled in Settings → AI Tools (MCP)). The shell scans
`modules/*/mcp.ts` at startup and registers whatever tools each exports — adding
`mcp.ts` is the **only** step needed to expose a module's tools.

`mcp.ts` default-exports `register(ctx): McpToolDef[]`:

```ts
import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: 'robocopy-gui__start-copy',              // MUST be <module-id>__<action>
      description: 'Run a robocopy job. Destructive: can overwrite/delete files.',
      destructive: true,                             // routes through the confirm gate
      inputSchema: {                                 // zod raw shape (shape only)
        source: z.string(),
        destination: z.string(),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined,
          `Copy ${args.source} -> ${args.destination}. May overwrite/delete files.`)
        if (gate) return gate
        return ctx.invoke('robocopy-gui:start-copy', /* same args the UI sends */)
      }
    }
  ]
}
```

Rules (all mandatory):

- **Tool names are `<module-id>__<action>`** (double underscore). The server rejects
  any tool not prefixed with the module id, so names can't collide across modules.
- **Reuse, don't duplicate.** A tool handler calls `ctx.invoke('<module-id>:<action>', …)`
  — the *same* IPC channel the UI button calls — so there is one implementation and
  one validation path. `inputSchema` is only the shape the agent sees; the real
  business validation stays in the delegated handler.
- **Destructive/irreversible tools** (file delete/overwrite, system/config change,
  credential change, anything not trivially undone) MUST set `destructive: true` and
  gate on `ctx.confirm(args.confirm, "<exactly what will happen>")`. The first call
  returns a confirmation describing the effect; the agent re-calls with
  `confirm: true` to execute. Use this shared gate — never invent your own.
- **Credential-needing tools** MUST NOT auto-use stored vault secrets on the MCP
  path. Gate on `ctx.credential('<Credential name>', args.<value>)`; when the caller
  hasn't supplied it, this returns a message *naming* (never echoing) the specific
  credential. Never log or return credential values.
- Renderer-only modules with no actions may `return []`, but the file must exist.

The `McpModuleContext` (`@shared/mcp`) provides: `invoke(channel, …args)`,
`hasApiKey(provider)`, `confirm(confirm, summary)`, `credential(name, provided)`.

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
4. **`mcp.ts` (required)** → expose the module's actions as `<id>__<action>` tools that
   delegate to those channels; mark destructive tools and gate credentials.
5. Settings/persistence → `storeGet`/`storeSet` or userData files under a
   module-named subfolder.
6. Update dependencies in root package.json; `npm run typecheck && npm run dev`.
7. Write the module `README.md` (quirks, carried-over behavior, elevation notes).

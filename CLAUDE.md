# WICKED — guidance for Claude Code

WICKED is one Electron + React + TypeScript desktop shell that hosts self-contained
feature **modules**. The shell owns navigation, theming (light/dark), settings,
auto-update, a central API-key vault, and a localhost MCP server. Each app is a
folder under `/modules` that the shell **auto-discovers at build time** — adding one
needs **zero shell code changes**.

## Read these before adding or changing a module

- **`modules/README.md`** — the authoritative module contract (folder shape, every
  rule, examples). Follow it exactly.
- **`src/shared/module-contract.ts`** — the same rules as machine-readable constants
  (also rendered by the in-app "Add New App" screen). Single source of truth.
- **`docs/compatibility-report.md`** — how the original apps map to modules.

## Adding a new module (the common task)

Create `/modules/<module-id>/` with:

```
module.json   # {id, name, icon (lucide PascalCase), version, description, status}
index.tsx     # default-export React component, mounted at /m/<module-id>
mcp.ts        # REQUIRED — default-export register(ctx): McpToolDef[]
ipc.ts        # main-process handlers (required if the module does main-process work)
store.ts      # optional Zustand store
README.md     # what it does + quirks
```

Hard rules (enforced by the contract — see `modules/README.md` for detail):

- **id** is kebab-case and doubles as the route (`/m/<id>`), the IPC namespace
  (`<id>:<action>`), and the MCP tool prefix (`<id>__<action>`, double underscore).
- **mcp.ts is mandatory.** Tools delegate to the same IPC channel the UI calls via
  `ctx.invoke(...)` — never duplicate logic. Destructive tools set `destructive: true`
  and gate on `ctx.confirm(args.confirm, "<what will happen>")`; credential-needing
  tools gate on `ctx.credential(name, value)` and never auto-use vault secrets.
- **API keys**: never store provider keys in a module. Read them in main via
  `ctx.getApiKey('openai'|'anthropic'|'gemini'|'deepseek'|...)`. Never send a key
  value to the renderer.
- **Styling**: use the shell theme tokens only — `bg surface raised edge ink muted
  accent accent-ink danger ok warn` (e.g. `className="bg-surface text-ink border-edge"`).
  The root element is `h-full`; own your scrolling. Don't create BrowserWindows,
  global shortcuts, menus, or theme handling — the shell owns those.
- **Elevation**: never require WICKED to run as admin; elevate a specific action on
  demand via PowerShell `Start-Process -Verb RunAs`.
- **Data paths (optional)**: register `<id>:data-paths` returning `ModuleDataPath[]`
  so Settings → Modules can show the app's file locations (`path: null` →
  "Not Configured Yet").
- Module data goes under `app.getPath('userData')/modules/<id>/` (which resolves to
  `%APPDATA%/WICKED-Suite/...`). Never store in the install dir.
- Windows system work is done by spawning PowerShell from the main process and
  returning JSON — see `modules/event-viewer/ipc.ts` and `modules/robocopy-gui/ipc.ts`
  as reference implementations.

New module-specific dependencies go in the **root** `package.json` (single
`node_modules`). Don't duplicate `react`, `zustand`, `lucide-react`, Tailwind, etc.

## Verify

```
npm run typecheck   # tsc for the node (main) and web (renderer) projects
npm run build       # typecheck + electron-vite build
```

Always get `npm run typecheck` clean before committing.

## Shipping / releases (this is how updates reach the app)

The user's workflow is: **bump `version` in `package.json` → commit → push to `main`**.
GitHub Actions (`.github/workflows/release.yml`, runs on `windows-latest`) then builds
the unsigned Windows installer and publishes a GitHub Release with `latest.yml`. The
app's "Check for Updates" finds it. **electron-updater only reports an update when the
released version is higher than the installed one, so bump the version for every
shippable change.** (Doc-only pushes — `**/*.md`, `docs/**` — are skipped by CI and do
not cut a release.)

Repo: `github.com/trendlinepros-afk/WICKED-MASTER-APP` (public), default branch `main`.

## Running in a cloud / Linux environment

- You can fully do: edit modules, `npm run typecheck`, commit, and push. CI builds the
  Windows installer for you — you do NOT need Windows locally to ship.
- You canNOT run the Electron GUI or exercise Windows-native behavior (Outlook COM,
  `sc.exe`/registry/winget, UAC) in a Linux sandbox. Those are verified by the user on
  Windows after an update. Write the code to the contract, typecheck, and push.
- Never commit secrets. `_sources/`, `node_modules/`, `release/`, `out/`, `.env` are
  gitignored — keep it that way.

/**
 * SINGLE SOURCE OF TRUTH for the WICKED module contract, as consumed by the
 * "Add New App" screen. The prose version in modules/README.md explains the same
 * rules for humans; this file is what the UI renders and copies, so the template
 * the user hands to Claude Code can never drift from the real contract.
 *
 * When the contract changes, update THIS file (and modules/README.md prose).
 */

export const MODULE_FOLDER_STRUCTURE = `/modules/<module-id>/
  module.json     # manifest: id, name, icon, version, description, status
  index.tsx       # default-export React component, mounted at /m/<module-id>
  mcp.ts          # REQUIRED — exports this module's MCP tool definitions
  ipc.ts          # main-process handlers (required if the module has any)
  store.ts        # optional — the module's own Zustand store slice
  README.md       # what it does + quirks carried over from the standalone app`

export interface FileRole {
  file: string
  role: string
}

export const MODULE_FILE_ROLES: FileRole[] = [
  { file: 'module.json', role: 'Manifest/metadata: id, name, lucide icon, version, description, status (stable/beta/external).' },
  { file: 'index.tsx', role: 'Default-export React component. Renders inside the shell (theme already applied). Owns its own scrolling; no BrowserWindow/menus/global shortcuts.' },
  { file: 'mcp.ts', role: 'REQUIRED. Default-export register(ctx) returning MCP tool definitions so AI agents can call the module. Tools delegate to the same IPC channels the UI uses.' },
  { file: 'ipc.ts', role: 'Main-process handlers, auto-registered at startup. Every channel namespaced <module-id>:<action>. Required if the module does any main-process work.' },
  { file: 'store.ts', role: "Optional Zustand store for the module's UI state." },
  { file: 'README.md', role: 'Brief notes: what the module does and any carried-over quirks.' }
]

export const NAMING_CONVENTIONS: string[] = [
  'Module id: kebab-case, unique (e.g. "robocopy-gui"). It is also the route (/m/<id>) and the IPC/MCP namespace.',
  'IPC channels: `<module-id>:<action>` (e.g. `robocopy-gui:start-copy`).',
  'MCP tool names: `<module-id>__<action>` with a DOUBLE underscore (e.g. `robocopy-gui__start-copy`).'
]

export const MODULE_RULES: string[] = [
  'mcp.ts is mandatory. A renderer-only module may export an empty tool array, but the file must exist.',
  'UI and MCP call the SAME underlying function. An MCP tool handler delegates to the module’s existing IPC channel via ctx.invoke(...) — never duplicate business logic or validation.',
  'Destructive or irreversible tools (delete/overwrite files, system/config changes, credential changes) MUST use the shared confirmation gate: ctx.confirm(args.confirm, "<exactly what will happen>"). The first call returns a confirmation; the agent re-calls with confirm:true to execute.',
  'Credential-needing tools MUST NOT auto-use stored vault secrets on the MCP path. Gate with ctx.credential("<credential name>", args.value); when absent it returns a message NAMING (never echoing) the credential. Never log or return credential values.',
  'Provider API keys are set once in Settings → API Keys and read in the main process via ctx.getApiKey(provider). Never store keys in a module or send a key value to the renderer.',
  'Never require WICKED to run as admin. Elevate a specific action on demand (Start-Process -Verb RunAs) so UAC fires only for that action.',
  'The shell owns theming, navigation, window management, and auto-update — modules must not reimplement them.'
]

/** The full copy-ready prompt the user hands to Claude Code to start a new module. */
export const NEW_MODULE_TEMPLATE = `# New WICKED module

Build a new module for the WICKED desktop suite. WICKED is one Electron + React
shell that hosts self-contained feature "modules". The shell handles navigation,
theming (light/dark), settings, auto-update, a central API-key vault, and a
localhost MCP server. A module is a folder under /modules that the shell
auto-discovers at build time — no shell code changes are needed to add one.

## Folder structure (exact)

${MODULE_FOLDER_STRUCTURE}

## What each file is for

${MODULE_FILE_ROLES.map((f) => `- ${f.file} — ${f.role}`).join('\n')}

## Naming conventions

${NAMING_CONVENTIONS.map((n) => `- ${n}`).join('\n')}

## Rules (must follow)

${MODULE_RULES.map((r) => `- ${r}`).join('\n')}

## module.json shape

{
  "id": "<kebab-case-id>",
  "name": "<Display Name>",
  "icon": "<lucide PascalCase icon, e.g. KeyRound>",
  "version": "1.0.0",
  "description": "<one line>",
  "status": "stable"
}

## index.tsx shape

export default function MyModule(): React.JSX.Element {
  return <div className="h-full overflow-y-auto p-6">…</div>
}
Use the shell theme tokens for styling: bg, surface, raised, edge, ink, muted,
accent, accent-ink, danger, ok, warn (e.g. className="bg-surface text-ink border-edge").

## ipc.ts shape (main process)

import type { ModuleIpcContext } from '../../src/main/module-ipc'
export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle('<module-id>:<action>', async (_e, arg) => { /* ... */ })
}
Renderer calls channels via window.wicked.invoke('<module-id>:<action>', arg).

## mcp.ts shape (required)

import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'
export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: '<module-id>__<action>',
      description: 'What it does and what it needs.',
      destructive: true,                       // if it can't be trivially undone
      inputSchema: { path: z.string(), confirm: z.boolean().optional() },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined,
          'Exactly what will happen to ' + args.path)
        if (gate) return gate
        return ctx.invoke('<module-id>:<action>', args.path)  // same fn the UI calls
      }
    }
  ]
}

Deliver the whole folder so it drops into /modules and works with zero shell
changes. Run \`npm run typecheck\` until clean.`

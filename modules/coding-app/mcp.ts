import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for CODING APP. Each tool delegates to the SAME main-process channel
 * the module UI calls (see ipc.ts / shared/ipc.ts) — no logic is duplicated here;
 * `inputSchema` is only the shape the agent sees, real validation stays in the
 * delegated handler.
 *
 * Curation: the module exposes ~30 channels; this file surfaces a focused,
 * meaningful subset (Ollama control, model/project/file discovery, file mutation,
 * the project runner, the live preview, and one credential-gated cloud chat).
 *
 * Destructive tools (file-write / file-delete / file-rename, run-start, run-command)
 * set `destructive: true` and route through `ctx.confirm(...)` — the summary names
 * the exact file or command affected.
 *
 * DELIBERATELY OMITTED and why:
 *  - config-* (get/update/path/restore-backup): editing app config over MCP is a
 *    persistent-settings change best left to the app UI.
 *  - conv-* (list/load/save/delete), logs-export: conversation history / log CRUD
 *    is app-local housekeeping with little agent value; delete is irreversible.
 *  - project-create: makes a new folder on disk; project-open (below) is the
 *    common entry point. Left to the UI's create-project flow.
 *  - file-apply-blocks / file-preview-blocks: multi-file writes parsed from an
 *    assistant's own block format — meant for the in-app chat loop, not a generic
 *    agent; the granular file-write/-rename/-delete tools cover deliberate edits.
 *  - ollama-pull-model / ollama-cancel-pull / ollama-start, gpu-detect-vram,
 *    provider-test, chat-estimate-cost, chat-stop: model downloads, one-off
 *    diagnostics and streaming-lifecycle plumbing that are noise for an agent.
 *  - screenshot-capture / gemini-analyze / gemini-apply-fix: the vision auto-fix
 *    loop is a cloud-key, screen-capture UI feature; gemini-apply-fix writes files
 *    from an opaque analysis blob and is unsafe to expose headlessly.
 *  - pick-folder / open-external / config-path: UI dialogs / shell helpers.
 */
const ID = 'coding-app'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    // ---- Read-only: environment & discovery ----
    {
      name: `${ID}__ollama-status`,
      description:
        'Report local Ollama status: whether it is reachable, its endpoint, installed models, ' +
        'which models are loaded, and VRAM in use. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:ollama-status`)
    },
    {
      name: `${ID}__models-list`,
      description:
        'List every selectable model (local Ollama + configured cloud providers) with id, provider, ' +
        'availability and VRAM/cost hints. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:models-list`)
    },
    {
      name: `${ID}__prereqs-check`,
      description:
        'Check external prerequisites (Ollama, Node.js): whether each is installed, its impact if ' +
        'missing, and a download URL. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:prereqs-check`)
    },

    // ---- Ollama model control (local, no key, non-destructive) ----
    {
      name: `${ID}__ollama-load-model`,
      description:
        'Load a locally-installed Ollama model into memory so it is ready to serve. Local-only, ' +
        'needs no API key. Returns { ok, error? }.',
      inputSchema: {
        name: z.string().describe('Ollama model name, e.g. "mistral:7b" (must already be installed).')
      },
      handler: (args) => ctx.invoke(`${ID}:ollama-load-model`, args.name)
    },
    {
      name: `${ID}__ollama-unload-model`,
      description:
        'Unload a loaded Ollama model to free VRAM. Local-only, needs no API key. Returns { ok, error? }.',
      inputSchema: {
        name: z.string().describe('Ollama model name currently loaded, e.g. "mistral:7b".')
      },
      handler: (args) => ctx.invoke(`${ID}:ollama-unload-model`, args.name)
    },

    // ---- Project (open / target) ----
    {
      name: `${ID}__project-open`,
      description:
        'Open an existing folder as the active coding project by absolute path, and make it active ' +
        'for all subsequent file/run/preview tools. Returns { name, rootPath }.',
      inputSchema: {
        rootPath: z.string().describe('Absolute path to the project folder to open.')
      },
      handler: (args) => ctx.invoke(`${ID}:project-open`, args.rootPath)
    },

    // ---- Read-only: files ----
    {
      name: `${ID}__file-tree`,
      description:
        'Return the active project\'s file tree (nested name/path/isDirectory nodes, relative to the ' +
        'project root). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:file-tree`)
    },
    {
      name: `${ID}__file-read`,
      description: 'Read a file from the active project and return its text contents. Read-only.',
      inputSchema: {
        relPath: z.string().describe('Path relative to the project root, e.g. "src/index.ts".')
      },
      handler: (args) => ctx.invoke(`${ID}:file-read`, args.relPath)
    },

    // ---- Destructive: file mutation ----
    {
      name: `${ID}__file-write`,
      description:
        'Create or overwrite a file in the active project with the given contents. Destructive: ' +
        'replaces any existing file at that path.',
      destructive: true,
      inputSchema: {
        relPath: z.string().describe('Path relative to the project root, e.g. "src/index.ts".'),
        content: z.string().describe('Full new contents for the file.'),
        confirm: z.boolean().optional().describe('Set true to actually write (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Write file "${String(args.relPath ?? '')}" in the active project, overwriting any ` +
            'existing contents at that path.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:file-write`, args.relPath, args.content)
      }
    },
    {
      name: `${ID}__file-delete`,
      description: 'Delete a file from the active project. Destructive and not trivially undone.',
      destructive: true,
      inputSchema: {
        relPath: z.string().describe('Path relative to the project root of the file to delete.'),
        confirm: z.boolean().optional().describe('Set true to actually delete (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Delete file "${String(args.relPath ?? '')}" from the active project. This cannot be ` +
            'trivially undone.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:file-delete`, args.relPath)
      }
    },
    {
      name: `${ID}__file-rename`,
      description:
        'Rename or move a file within the active project. Destructive: can overwrite the destination ' +
        'path.',
      destructive: true,
      inputSchema: {
        relPath: z.string().describe('Current path relative to the project root.'),
        newRelPath: z.string().describe('New path relative to the project root.'),
        confirm: z.boolean().optional().describe('Set true to actually rename (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Rename "${String(args.relPath ?? '')}" -> "${String(args.newRelPath ?? '')}" in the ` +
            'active project. This can overwrite a file at the destination path.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:file-rename`, args.relPath, args.newRelPath)
      }
    },

    // ---- Runner (Play button + diagnostics console) ----
    {
      name: `${ID}__run-start`,
      description:
        "Start the active project's configured run command (the Play button). Destructive: executes " +
        'project code as a child process. Streams output to the app console.',
      destructive: true,
      inputSchema: {
        confirm: z.boolean().optional().describe('Set true to actually start (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          "Run the active project's configured command, executing project code as a child process."
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:run-start`)
      }
    },
    {
      name: `${ID}__run-stop`,
      description: 'Stop the running project process (if any). Non-destructive.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:run-stop`)
    },
    {
      name: `${ID}__run-command`,
      description:
        'Run an arbitrary shell command in the active project directory and return its exit code. ' +
        'Destructive: executes an arbitrary command with the app\'s privileges.',
      destructive: true,
      inputSchema: {
        command: z.string().describe('Shell command to run, e.g. "npm install".'),
        confirm: z.boolean().optional().describe('Set true to actually run (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Run shell command "${String(args.command ?? '')}" in the active project directory. ` +
            'It executes with the app\'s privileges and can change files or system state.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:run-command`, args.command)
      }
    },

    // ---- Live preview server ----
    {
      name: `${ID}__preview-start`,
      description:
        'Start the live preview server for the active project (static / react / node) and return its ' +
        'URL and status. Non-destructive.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:preview-start`)
    },
    {
      name: `${ID}__preview-stop`,
      description: 'Stop the live preview server (if running). Non-destructive.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:preview-stop`)
    },

    // ---- Cloud chat (credential-gated) ----
    {
      name: `${ID}__chat-send`,
      description:
        'Send a chat completion to a CLOUD model (Anthropic / OpenAI / Gemini / DeepSeek) and stream ' +
        'the reply to the app. Requires the selected cloud provider\'s API key via `credential` — the ' +
        'MCP path never auto-uses the stored vault key. For LOCAL Ollama chat (which needs no key), ' +
        'use the app UI instead. Returns { requestId }; tokens stream to the app window.',
      inputSchema: {
        modelId: z
          .string()
          .describe('Cloud model id from models-list, e.g. "anthropic:claude-3-5-sonnet".'),
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant', 'system']),
              content: z.string()
            })
          )
          .describe('Ordered chat messages.'),
        temperature: z.number().optional().describe('Sampling temperature (default 0.7).'),
        maxTokens: z.number().optional().describe('Max output tokens (default 2048).'),
        credential: z
          .string()
          .optional()
          .describe('The selected cloud provider API key (required for cloud models).')
      },
      handler: (args) => {
        const cred = ctx.credential(
          'the selected cloud provider API key',
          args.credential as string | undefined
        )
        if (cred) return cred
        const req = {
          modelId: args.modelId,
          messages: args.messages,
          temperature: (args.temperature as number | undefined) ?? 0.7,
          maxTokens: (args.maxTokens as number | undefined) ?? 2048
        }
        return ctx.invoke(`${ID}:chat-send`, req)
      }
    }
  ]
}

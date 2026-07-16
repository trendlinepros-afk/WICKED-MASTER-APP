import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for CODELENS. Every tool delegates to the SAME main-process channel
 * the module UI calls (see ipc.ts + shared/api.ts CHANNELS) — no scan, read, AI
 * or export logic is duplicated here. scan/read-file/export are read-only or
 * user-directed. The AI tools (explain-file, explain-connections, explain-issue,
 * summarize) call the module's selected provider (Claude/OpenAI/Gemini/DeepSeek)
 * and are gated on a caller-supplied credential so the MCP path never silently
 * uses the shell's stored vault key.
 */
const ID = 'codelens'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__scan`,
      description:
        'Scan a project folder: build the file tree, dependency graph and static-analysis findings, and load it as the current project (subsequent read/explain tools operate on it). Read-only: reads files, changes nothing.',
      inputSchema: {
        rootPath: z.string().describe('Absolute path of the project folder to scan.')
      },
      handler: (args) => ctx.invoke(`${ID}:scan`, args.rootPath)
    },
    {
      name: `${ID}__read-file`,
      description:
        'Read a file from the currently scanned project by its project-relative path (posix separators). Returns the file content (capped) and a truncation flag. Read-only.',
      inputSchema: {
        relPath: z.string().describe('Path relative to the scanned project root, e.g. "src/main.ts".')
      },
      handler: (args) => ctx.invoke(`${ID}:read-file`, args.relPath)
    },
    {
      name: `${ID}__explain-file`,
      description:
        "Ask the selected AI provider to explain one file's purpose and structure. Requires the provider API key: supply it via `credential` — the MCP path never auto-uses the stored vault key. Operates on the currently scanned project. Read-only (no local changes).",
      inputSchema: {
        relPath: z.string().describe('Project-relative path of the file to explain.'),
        credential: z
          .string()
          .optional()
          .describe('The selected AI provider API key. Required on the MCP path; the vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('the selected AI provider API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:ai-explain-file`, args.relPath)
      }
    },
    {
      name: `${ID}__explain-connections`,
      description:
        'Ask the selected AI provider to explain how one file connects to the rest of the project (its inbound and outbound dependency edges). Requires the provider API key via `credential`; the vault key is never used on the MCP path. Read-only.',
      inputSchema: {
        relPath: z.string().describe('Project-relative path of the file whose connections to explain.'),
        credential: z
          .string()
          .optional()
          .describe('The selected AI provider API key. Required on the MCP path; the vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('the selected AI provider API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:ai-explain-connections`, args.relPath)
      }
    },
    {
      name: `${ID}__explain-issue`,
      description:
        'Ask the selected AI provider to explain a static-analysis finding (by its issue id from the scan) and how to address it. Requires the provider API key via `credential`; the vault key is never used on the MCP path. Read-only.',
      inputSchema: {
        issueId: z.string().describe('Id of an issue from the current scan result.'),
        credential: z
          .string()
          .optional()
          .describe('The selected AI provider API key. Required on the MCP path; the vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('the selected AI provider API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:ai-explain-issue`, args.issueId)
      }
    },
    {
      name: `${ID}__summarize`,
      description:
        'Ask the selected AI provider for a project-level summary of the currently scanned project (key files, hotspots, findings). Requires the provider API key via `credential`; the vault key is never used on the MCP path. Read-only.',
      inputSchema: {
        credential: z
          .string()
          .optional()
          .describe('The selected AI provider API key. Required on the MCP path; the vault key is never used here.')
      },
      handler: (args) => {
        const gate = ctx.credential('the selected AI provider API key', args.credential as string | undefined)
        if (gate) return gate
        return ctx.invoke(`${ID}:ai-summarize`)
      }
    },
    {
      name: `${ID}__export-report`,
      description:
        'Save the given Markdown report to a file the user picks in a Save dialog, as Markdown or PDF. The user chooses the path, so this is non-destructive (no silent overwrite).',
      inputSchema: {
        markdown: z.string().describe('The report Markdown to save.'),
        format: z.enum(['md', 'pdf']).describe('Output format: "md" or "pdf".')
      },
      handler: (args) => ctx.invoke(`${ID}:report-export`, args.markdown, args.format)
    }
  ]
}

import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * File Vault MCP tools — cloud file storage on the user's own Google Drive
 * ("WICKED Vault" folder). Every tool delegates to the same IPC handlers the
 * UI uses; transfers are queued and verified (MD5) in the main process.
 */
export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: 'file-vault__status',
      description:
        'Google Drive vault connection state: whether an account is connected (and which), plus the default download folder. Use before other file-vault tools.',
      inputSchema: {},
      handler: () => ctx.invoke('file-vault:status')
    },
    {
      name: 'file-vault__list',
      description:
        'List every file in the "WICKED Vault" folder on the user\'s Google Drive: name, id, size, MD5, modified time. Requires the vault to be connected (see file-vault__status).',
      inputSchema: {},
      handler: () => ctx.invoke('file-vault:list')
    },
    {
      name: 'file-vault__upload',
      description:
        'Upload local file(s) into the Drive vault (resumable, any size, MD5-verified). A vault file with the same name is REPLACED (Drive keeps the old version ~30 days). Returns immediately; watch progress with file-vault__transfers.',
      destructive: true,
      inputSchema: {
        paths: z.array(z.string()).describe('Absolute local file paths to upload'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const paths = (args.paths as string[]) ?? []
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Upload ${paths.length} file(s) to the "WICKED Vault" folder on Google Drive: ${paths.join(', ')}. Same-named vault files are replaced (previous version recoverable ~30 days).`
        )
        if (gate) return gate
        return ctx.invoke('file-vault:upload-paths', paths)
      }
    },
    {
      name: 'file-vault__download',
      description:
        'Download a vault file (by exact name or Drive file id) to a local folder, MD5-verified. Never overwrites an existing local file. Returns a transferId immediately; watch progress with file-vault__transfers.',
      inputSchema: {
        name: z.string().optional().describe('Exact vault file name (or pass fileId)'),
        fileId: z.string().optional().describe('Drive file id (from file-vault__list)'),
        dir: z.string().optional().describe('Destination folder; defaults to the configured download folder')
      },
      handler: (args) =>
        ctx.invoke('file-vault:download-to', {
          name: args.name as string | undefined,
          fileId: args.fileId as string | undefined,
          dir: args.dir as string | undefined
        })
    },
    {
      name: 'file-vault__transfers',
      description: 'Current upload/download queue with per-transfer progress, speed, verification result and errors.',
      inputSchema: {},
      handler: () => ctx.invoke('file-vault:transfers')
    },
    {
      name: 'file-vault__delete',
      description:
        'Move a vault file (by exact name or Drive file id) to the Google Drive trash — recoverable there for ~30 days, then gone.',
      destructive: true,
      inputSchema: {
        name: z.string().optional().describe('Exact vault file name (or pass fileId)'),
        fileId: z.string().optional().describe('Drive file id (from file-vault__list)'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const which = (args.name as string) || (args.fileId as string) || ''
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Move "${which}" from the Drive vault to the Google Drive trash (recoverable there for ~30 days).`
        )
        if (gate) return gate
        return ctx.invoke('file-vault:delete', {
          name: args.name as string | undefined,
          fileId: args.fileId as string | undefined
        })
      }
    }
  ]
}

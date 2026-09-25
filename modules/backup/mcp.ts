import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for BACKUP. Every tool delegates to the SAME main-process channel
 * the Backup screen calls (see ipc.ts). Restores can overwrite files, so
 * `restore` is destructive and routed through the shared confirmation gate.
 * Share passwords are never exposed or accepted here — plans use what the user
 * saved in the app.
 */
const ID = 'backup'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__list-plans`,
      description:
        'List backup plans: id, name, sources, destination, full/incremental mode, schedule, next run, last result, Google Drive copy on/off. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-plans`)
    },
    {
      name: `${ID}__status`,
      description: 'The backup/restore job running right now (phase, files and bytes done) and any queued jobs. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:queue`)
    },
    {
      name: `${ID}__run`,
      description:
        "Start a backup of a plan now (queued if another job is running). Uses the plan's full/incremental setting; set full:true to force a new full backup. Backups never modify the source files; the plan's cleanup rules may remove old backup versions afterwards.",
      inputSchema: {
        planId: z.string().describe('Plan id from list-plans'),
        full: z.boolean().optional().describe('Force a full backup instead of an incremental one')
      },
      handler: (args) => ctx.invoke(`${ID}:run`, { planId: args.planId, full: args.full === true, trigger: 'mcp' })
    },
    {
      name: `${ID}__one-time`,
      description:
        'Make a one-time full backup of the given folders/files to a destination folder (local path or \\\\server\\share). It is kept in the Backup app as a one-time entry that can be browsed and restored later; it is never scheduled or cleaned up. Never modifies the source files. Network shares that need a login must be set up in the app first.',
      inputSchema: {
        sources: z.array(z.string()).min(1).describe('Absolute paths of folders and/or files to back up'),
        destination: z.string().describe('Folder to store the backup in, e.g. "E:\\Backups" or "\\\\nas\\backups"'),
        name: z.string().optional().describe('Optional label; defaults to "<first folder> · <date time>"')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:one-time`, {
          name: args.name,
          sources: args.sources,
          destination: { path: args.destination, username: '', hasPassword: false },
          trigger: 'mcp'
        })
    },
    {
      name: `${ID}__cancel`,
      description: 'Cancel the running backup/restore job (or a queued one by jobId). A cancelled backup leaves no partial version behind.',
      inputSchema: { jobId: z.string().optional().describe('Job id; omit to cancel whatever is running') },
      handler: (args) => ctx.invoke(`${ID}:cancel`, { jobId: args.jobId })
    },
    {
      name: `${ID}__history`,
      description: 'Recent backup, restore and validation results (newest first), optionally for one plan. Read-only.',
      inputSchema: {
        planId: z.string().optional(),
        limit: z.number().int().positive().max(300).optional()
      },
      handler: (args) => ctx.invoke(`${ID}:history`, { planId: args.planId, limit: args.limit ?? 20 })
    },
    {
      name: `${ID}__list-versions`,
      description:
        'List the backup versions of a plan (newest first): id, full/incremental, time, file count, size, and whether it is at the destination and/or in Google Drive. Read-only.',
      inputSchema: { planId: z.string() },
      handler: (args) => ctx.invoke(`${ID}:versions`, { planId: args.planId })
    },
    {
      name: `${ID}__browse`,
      description:
        'List folders and files inside a backup version. `dir` is a storePath from a previous browse (omit to start where the backed-up data begins). Read-only.',
      inputSchema: {
        planId: z.string(),
        versionId: z.string(),
        dir: z.string().optional().describe('storePath of the folder to list, e.g. "C/Users/me/Documents"')
      },
      handler: (args) => ctx.invoke(`${ID}:browse`, { planId: args.planId, versionId: args.versionId, dir: args.dir ?? null })
    },
    {
      name: `${ID}__search`,
      description: 'Find files by name inside a backup version (substring, or wildcards like *.xlsx). Returns up to 500 matches with their storePaths. Read-only.',
      inputSchema: { planId: z.string(), versionId: z.string(), query: z.string() },
      handler: (args) => ctx.invoke(`${ID}:search`, { planId: args.planId, versionId: args.versionId, query: args.query })
    },
    {
      name: `${ID}__restore`,
      description:
        'Restore files/folders (storePaths from browse/search) from a backup version, either to their original locations or into a folder. Can overwrite existing files — destructive; requires confirm:true.',
      destructive: true,
      inputSchema: {
        planId: z.string(),
        versionId: z.string(),
        paths: z.array(z.string()).describe('storePaths of files and/or folders to restore ([] or [""] = everything)'),
        target: z.enum(['original', 'folder']),
        folder: z.string().optional().describe('Destination folder when target is "folder"'),
        keepStructure: z.boolean().optional().describe('Recreate the full original path under the folder'),
        overwrite: z.enum(['overwrite', 'older', 'skip']).optional().describe('Existing files: always overwrite, only if older than the backup (default), or skip'),
        confirm: z.boolean().optional().describe('Set true to actually restore (see confirmation).')
      },
      handler: (args) => {
        const paths = (args.paths as string[] | undefined) ?? []
        const target = args.target === 'folder' ? 'folder' : 'original'
        const overwrite = (args.overwrite as string | undefined) ?? 'older'
        const where = target === 'folder' ? `into "${String(args.folder ?? '')}"` : 'to their ORIGINAL locations'
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Restore ${paths.length ? `${paths.length} selected item(s)` : 'everything'} from backup version ${String(args.versionId)} ${where}. ` +
            `Existing files: ${overwrite === 'overwrite' ? 'always overwritten' : overwrite === 'older' ? 'overwritten only if older than the backup copy' : 'left untouched'}.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:restore`, {
          planId: args.planId,
          versionId: args.versionId,
          paths,
          target,
          folder: args.folder,
          keepStructure: args.keepStructure === true,
          overwrite,
          trigger: 'mcp'
        })
      }
    },
    {
      name: `${ID}__validate`,
      description: 'Re-read every file of a backup version and check it against its SHA-256 checksum. Queued like a backup; results appear in history. Read-only.',
      inputSchema: { planId: z.string(), versionId: z.string() },
      handler: (args) => ctx.invoke(`${ID}:validate`, { planId: args.planId, versionId: args.versionId })
    }
  ]
}

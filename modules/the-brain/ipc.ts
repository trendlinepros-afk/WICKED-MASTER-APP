import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import {
  absPath,
  deleteNote,
  ensureVault,
  importFiles,
  listTree,
  readNote,
  safeName,
  search,
  stats,
  vaultRoot,
  writeNote
} from './lib/brainStore'

/**
 * The Brain — main process. Owns the local markdown vault and exposes it to the
 * home-screen UI. Other modules (ai-advisor, ai-chat) write into the same vault
 * directly via `lib/brainStore`, so this file only needs the UI-facing surface
 * plus import.
 */
const ID = 'the-brain'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export default function register(ctx: ModuleIpcContext): void {
  // Create the vault (+ standard folders) once at startup so it exists and syncs
  // even before the user opens the tool.
  try {
    ensureVault(ctx.app)
  } catch {
    /* created lazily on first use instead */
  }

  ctx.ipcMain.handle(`${ID}:tree`, () => {
    try {
      return { ok: true, tree: listTree(ctx.app), stats: stats(ctx.app) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:read`, (_e, rel: unknown) => {
    try {
      return { ok: true, content: readNote(ctx.app, str(rel)) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:search`, (_e, query: unknown) => {
    try {
      return { ok: true, hits: search(ctx.app, str(query)) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:write`, (_e, rel: unknown, content: unknown) => {
    try {
      writeNote(ctx.app, str(rel), str(content))
      return { ok: true, tree: listTree(ctx.app) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Create a new empty note in a folder. Returns its relative path.
  ctx.ipcMain.handle(`${ID}:new-note`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const folder = safeName(str(r.folder) || 'Notes', 'Notes')
    const title = safeName(str(r.title) || 'Untitled note', 'Untitled note')
    const rel = `${folder}/${title}.md`
    try {
      // don't clobber an existing note of the same name
      let finalRel = rel
      let n = 2
      const exists = (p: string): boolean => {
        try {
          readNote(ctx.app, p)
          return true
        } catch {
          return false
        }
      }
      while (exists(finalRel)) finalRel = `${folder}/${title} (${n++}).md`
      const body = `---\ntitle: ${JSON.stringify(title)}\ntype: note\ncreated: ${new Date().toISOString()}\n---\n\n# ${title}\n\n`
      writeNote(ctx.app, finalRel, body)
      return { ok: true, rel: finalRel, tree: listTree(ctx.app) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:delete`, (_e, rel: unknown) => {
    try {
      deleteNote(ctx.app, str(rel))
      return { ok: true, tree: listTree(ctx.app) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:import`, async (_e, destFolder: unknown) => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Import markdown into The Brain',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Markdown / text', extensions: ['md', 'markdown', 'txt'] }]
    }
    try {
      const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true }
      const dest = safeName(str(destFolder) || 'Imported', 'Imported')
      const { imported, skipped } = importFiles(ctx.app, res.filePaths, dest)
      return { ok: true, imported, skipped, tree: listTree(ctx.app) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:reveal`, (_e, rel: unknown) => {
    try {
      ctx.shell.showItemInFolder(absPath(ctx.app, str(rel)))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Open the vault folder in the OS file manager (so users can treat it as a real
  // Obsidian vault if they like).
  ctx.ipcMain.handle(`${ID}:open-vault`, () => {
    try {
      void ctx.shell.openPath(ensureVault(ctx.app))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    let base = ''
    try {
      base = vaultRoot(ctx.app)
    } catch {
      /* not available */
    }
    return [
      {
        label: 'Brain vault (markdown)',
        path: base || null,
        note: 'Notes, auto-saved chats and persona documents. Included in Backup & Cloud Sync.'
      }
    ]
  })
}

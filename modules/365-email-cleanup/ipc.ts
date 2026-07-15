import { existsSync } from 'fs'
import type { ModuleIpcContext } from '../../src/main/module-ipc'

const ID = '365-email-cleanup'
const PATH_KEY = `${ID}.exePath`

const DEFAULT_PATHS = [
  'X:\\Coding\\_Active Projects\\365 Email Cleanup\\build\\publish\\InboxCleanup.exe',
  'C:\\Program Files\\Inbox Cleanup\\InboxCleanup.exe'
]

export default function register(ctx: ModuleIpcContext): void {
  const resolvePath = (): string => {
    const stored = ctx.storeGet<string>(PATH_KEY, '')
    if (stored) return stored
    return DEFAULT_PATHS.find((p) => existsSync(p)) ?? DEFAULT_PATHS[0]
  }

  ctx.ipcMain.handle(`${ID}:status`, () => {
    const path = resolvePath()
    return { path, exists: existsSync(path) }
  })

  ctx.ipcMain.handle(`${ID}:launch`, async () => {
    const path = resolvePath()
    if (!existsSync(path)) return { ok: false, error: `Not found: ${path}` }
    const error = await ctx.shell.openPath(path)
    return error ? { ok: false, error } : { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:pick-path`, async () => {
    const win = ctx.getMainWindow()
    if (!win) return null
    const res = await ctx.dialog.showOpenDialog(win, {
      title: 'Locate InboxCleanup.exe',
      filters: [{ name: 'Programs', extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    ctx.storeSet(PATH_KEY, res.filePaths[0])
    return res.filePaths[0]
  })
}

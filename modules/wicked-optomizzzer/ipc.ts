import { existsSync } from 'fs'
import type { ModuleIpcContext } from '../../src/main/module-ipc'

const ID = 'wicked-optomizzzer'
const PATH_KEY = `${ID}.exePath`

// first existing default wins; user can override via the module UI
const DEFAULT_PATHS = [
  'C:\\Program Files (x86)\\Wicked Optimizer\\WickedOptimizer.exe',
  'X:\\Coding\\_Active Projects\\Wicked Optomizzzer\\dist\\WickedOptimizer.exe'
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
    // ShellExecute honors the exe's requireAdministrator manifest -> UAC prompt
    // fires for this launch only; WICKED itself stays unelevated.
    const error = await ctx.shell.openPath(path)
    return error ? { ok: false, error } : { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:pick-path`, async () => {
    const win = ctx.getMainWindow()
    if (!win) return null
    const res = await ctx.dialog.showOpenDialog(win, {
      title: 'Locate WickedOptimizer.exe',
      filters: [{ name: 'Programs', extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (res.canceled || !res.filePaths[0]) return null
    ctx.storeSet(PATH_KEY, res.filePaths[0])
    return res.filePaths[0]
  })
}

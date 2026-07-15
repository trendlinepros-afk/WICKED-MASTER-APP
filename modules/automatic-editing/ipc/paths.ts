/**
 * Module-scoped data locations. Everything this module persists (settings,
 * secrets, the SQLite project index, the default projects folder) lives under
 * <userData>/modules/automatic-editing so it can never collide with the shell
 * or another module.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

export function moduleDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'modules', 'automatic-editing')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

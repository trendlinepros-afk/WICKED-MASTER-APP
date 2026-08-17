import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, rmSync, statSync } from 'fs'

/**
 * Minimal file logger for the coding-app module. Writes to
 * `<userData>/modules/coding-app/logs/app.log` (module-owned subfolder per the
 * WICKED module contract). Rotates at ~5 MB (one .old generation kept) so the
 * log can never grow without bound — it rides along in every backup/sync.
 * Surfaced to the user via Settings -> Advanced -> Export logs.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024

class Logger {
  private logFile: string | null = null

  private ensure(): string {
    if (this.logFile) return this.logFile
    const dir = join(app.getPath('userData'), 'modules', 'coding-app', 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.logFile = join(dir, 'app.log')
    return this.logFile
  }

  private rotateIfHuge(file: string): void {
    try {
      if (statSync(file).size < MAX_LOG_BYTES) return
      const old = `${file}.old`
      rmSync(old, { force: true })
      renameSync(file, old)
    } catch {
      // missing file or a locked rename — just keep appending
    }
  }

  private write(level: string, args: unknown[]): void {
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] ${args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ')}\n`
    try {
      const file = this.ensure()
      this.rotateIfHuge(file)
      appendFileSync(file, line)
    } catch {
      // ignore logging failures
    }
    // Also echo to stdout for `electron-vite dev`.
    if (level === 'ERROR') console.error(`[coding-app] ${line.trim()}`)
    else console.log(`[coding-app] ${line.trim()}`)
  }

  info(...args: unknown[]): void {
    this.write('INFO', args)
  }

  warn(...args: unknown[]): void {
    this.write('WARN', args)
  }

  error(...args: unknown[]): void {
    this.write('ERROR', args)
  }

  read(): string {
    try {
      return readFileSync(this.ensure(), 'utf-8')
    } catch {
      return ''
    }
  }

  path(): string {
    return this.ensure()
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const logger = new Logger()

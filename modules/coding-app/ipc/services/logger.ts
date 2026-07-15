import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs'

/**
 * Minimal file logger for the coding-app module. Writes to
 * `<userData>/modules/coding-app/logs/app.log` (module-owned subfolder per the
 * WICKED module contract). Surfaced to the user via Settings -> Advanced ->
 * Export logs.
 */
class Logger {
  private logFile: string | null = null

  private ensure(): string {
    if (this.logFile) return this.logFile
    const dir = join(app.getPath('userData'), 'modules', 'coding-app', 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.logFile = join(dir, 'app.log')
    return this.logFile
  }

  private write(level: string, args: unknown[]): void {
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] ${args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ')}\n`
    try {
      appendFileSync(this.ensure(), line)
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

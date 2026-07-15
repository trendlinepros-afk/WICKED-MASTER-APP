import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileManager } from './file-manager'
import { logger } from './logger'
import type { RunStatus } from '../../shared/types'

/**
 * Runs the active project as a real process (e.g. `python main.py`, `node
 * index.js`, or `npm start`) and streams its stdout/stderr to the renderer's
 * diagnostics console. This is the "Play" companion to Live Preview: Live
 * Preview renders web output in a browser frame, while Play launches desktop /
 * script apps (like a pygame game) and surfaces their logs.
 */
export class RunnerService {
  private proc: ChildProcess | null = null
  private cmdProc: ChildProcess | null = null
  private status: RunStatus = { running: false, command: null, exitCode: null }
  private onLog: ((line: string) => void) | null = null
  private onExit: ((code: number | null) => void) | null = null

  setListeners(
    onLog: (line: string) => void,
    onExit: (code: number | null) => void
  ): void {
    this.onLog = onLog
    this.onExit = onExit
  }

  getStatus(): RunStatus {
    return this.status
  }

  start(): RunStatus {
    this.stop()
    const root = fileManager.getActiveRoot()
    if (!root) {
      this.emit('No active project.')
      return this.setStatus({ running: false, command: null, exitCode: null })
    }
    const detected = detectRunCommand(root)
    if (!detected) {
      this.emit(
        'Could not detect how to run this project. Expected a main.py/app.py, ' +
          'an index.js/server.js, or a package.json with a "start" script.'
      )
      return this.setStatus({ running: false, command: null, exitCode: null })
    }
    const { cmd, args } = detected
    const commandStr = `${cmd} ${args.join(' ')}`
    try {
      // shell:true so `python`/`node`/`npm` resolve on Windows without .cmd
      // suffixing. Args are fixed literals from detection (no user injection).
      this.proc = spawn(cmd, args, {
        cwd: root,
        shell: true,
        windowsHide: false,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      })
    } catch (err) {
      this.emit(`Failed to start: ${(err as Error).message}`)
      return this.setStatus({ running: false, command: commandStr, exitCode: null })
    }

    this.emit(`▶ Running: ${commandStr}`)
    this.setStatus({ running: true, command: commandStr, exitCode: null })
    this.proc.stdout?.on('data', (d: Buffer) => this.emitChunk(d))
    this.proc.stderr?.on('data', (d: Buffer) => this.emitChunk(d))
    this.proc.on('error', (err) => {
      this.emit(
        `⚠ ${err.message}. Is the required runtime (Python/Node) installed and on PATH?`
      )
    })
    this.proc.on('exit', (code) => {
      this.emit(`■ Process exited with code ${code ?? 0}`)
      this.setStatus({ running: false, command: commandStr, exitCode: code })
      this.onExit?.(code)
      this.proc = null
    })
    return this.status
  }

  /**
   * Run an arbitrary shell command in the project directory (e.g.
   * `pip install pygame`, `npm install`), streaming output to the console.
   * Used by Full Auto / approved edits so the app can install dependencies and
   * run build steps itself instead of telling the user to. Resolves the exit
   * code. A small denylist blocks obviously destructive commands.
   */
  runCommand(command: string): Promise<number | null> {
    const root = fileManager.getActiveRoot()
    if (!root) {
      this.emit('No active project — cannot run command.')
      return Promise.resolve(null)
    }
    if (isDangerous(command)) {
      this.emit(`⚠ Skipped potentially destructive command: ${command}`)
      return Promise.resolve(null)
    }
    this.emit(`▶ $ ${command}`)
    return new Promise((resolve) => {
      const proc = spawn(command, {
        cwd: root,
        shell: true,
        windowsHide: false,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      })
      this.cmdProc = proc
      proc.stdout?.on('data', (d: Buffer) => this.emitChunk(d))
      proc.stderr?.on('data', (d: Buffer) => this.emitChunk(d))
      proc.on('error', (err) =>
        this.emit(`⚠ ${err.message}. Is the required tool installed and on PATH?`)
      )
      proc.on('exit', (code) => {
        this.emit(`■ Command exited with code ${code ?? 0}`)
        if (this.cmdProc === proc) this.cmdProc = null
        resolve(code)
      })
    })
  }

  stop(): void {
    for (const p of [this.proc, this.cmdProc]) {
      if (p) {
        try {
          p.kill()
        } catch (err) {
          logger.warn('Failed to kill process', err)
        }
      }
    }
    this.proc = null
    this.cmdProc = null
    if (this.status.running) {
      this.setStatus({ ...this.status, running: false })
    }
  }

  private emit(line: string): void {
    this.onLog?.(line)
  }

  private emitChunk(d: Buffer): void {
    for (const line of d.toString('utf-8').split(/\r?\n/)) {
      if (line.length) this.onLog?.(line)
    }
  }

  private setStatus(s: RunStatus): RunStatus {
    this.status = s
    return s
  }
}

/** Block clearly destructive commands from auto-execution. */
function isDangerous(command: string): boolean {
  return /(\brm\s+-[rf]|\brmdir\s+\/s|\bdel\s+\/|format\s+[a-z]:|mkfs|shutdown|reboot|:\(\)\s*\{|\bdd\s+if=|>\s*\/dev\/sd)/i.test(
    command
  )
}

function detectRunCommand(root: string): { cmd: string; args: string[] } | null {
  const py = process.platform === 'win32' ? 'python' : 'python3'
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>
      }
      if (pkg.scripts?.start) return { cmd: 'npm', args: ['start'] }
    } catch {
      // fall through to entry-file detection
    }
  }
  for (const f of ['main.py', 'app.py', 'game.py', 'snake.py', 'run.py']) {
    if (existsSync(join(root, f))) return { cmd: py, args: [f] }
  }
  for (const f of ['index.js', 'server.js', 'app.js', 'main.js']) {
    if (existsSync(join(root, f))) return { cmd: 'node', args: [f] }
  }
  return null
}

export const runnerService = new RunnerService()

import express, { type Express } from 'express'
import { type Server } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileManager } from './file-manager'
import { logger } from './logger'
import type { PreviewKind, PreviewStatus } from '../../shared/types'

const PORT = 30123

/**
 * Serves a live preview of the active project.
 *
 * Detection:
 *  - `static`: has an index.html at the root (or a build/dist/public folder).
 *  - `react`/built SPA: package.json present with a build output dir.
 *  - `node`: package.json with a `start` script -> run `npm start`.
 *  - `unknown`: nothing recognizable to serve.
 *
 * Static/SPA content is served by an embedded Express server (so the renderer
 * can load it in a <webview>/<iframe> and screenshot it). Hot reload is driven
 * by the renderer reloading the frame when the file watcher fires.
 */
export class PreviewManager {
  private server: Server | null = null
  private nodeProc: ChildProcess | null = null
  private status: PreviewStatus = { running: false, url: null, kind: 'unknown' }

  getStatus(): PreviewStatus {
    return this.status
  }

  async start(): Promise<PreviewStatus> {
    await this.stop()
    const root = fileManager.getActiveRoot()
    if (!root) {
      this.status = {
        running: false,
        url: null,
        kind: 'unknown',
        error: 'No active project.'
      }
      return this.status
    }
    const { kind, serveDir } = detectProject(root)

    if (kind === 'node') {
      return this.startNode(root)
    }
    if (kind === 'unknown' || !serveDir) {
      this.status = {
        running: false,
        url: null,
        kind: 'unknown',
        error:
          'Live Preview supports web projects — an index.html, a built SPA ' +
          '(dist/build/out), or a Node app with an npm "start" script. This ' +
          'folder has none of those (desktop apps like Python/pygame can\'t be ' +
          'previewed in the browser).'
      }
      return this.status
    }
    return this.startStatic(serveDir, kind)
  }

  private startStatic(serveDir: string, kind: PreviewKind): Promise<PreviewStatus> {
    const app: Express = express()
    app.use(express.static(serveDir))
    // SPA fallback to index.html for client-side routing.
    app.get('*', (_req, res) => {
      const index = join(serveDir, 'index.html')
      if (existsSync(index)) res.sendFile(index)
      else res.status(404).send('Not found')
    })
    return new Promise((resolve) => {
      this.server = app.listen(PORT, '127.0.0.1', () => {
        this.status = {
          running: true,
          url: `http://127.0.0.1:${PORT}`,
          kind
        }
        logger.info('Preview server started', this.status.url)
        resolve(this.status)
      })
      this.server.on('error', (err) => {
        this.status = {
          running: false,
          url: null,
          kind,
          error: err.message
        }
        resolve(this.status)
      })
    })
  }

  private async startNode(root: string): Promise<PreviewStatus> {
    try {
      this.nodeProc = spawn('npm', ['start'], {
        cwd: root,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PORT: String(PORT), BROWSER: 'none' }
      })
      this.nodeProc.stdout?.on('data', (d) => logger.info('[preview]', d.toString()))
      this.nodeProc.stderr?.on('data', (d) => logger.warn('[preview]', d.toString()))
      // Handle the async spawn 'error' (e.g. npm not installed) so it can't
      // become an uncaught exception.
      this.nodeProc.on('error', (err) => {
        logger.error('Preview node process error', err.message)
        this.status = {
          running: false,
          url: null,
          kind: 'node',
          error: `Could not run "npm start": ${err.message}. Is Node.js installed?`
        }
      })
      this.nodeProc.on('exit', (code) =>
        logger.info('Preview node process exited', code)
      )
      // Assume the dev server binds PORT; the renderer will retry loading.
      this.status = {
        running: true,
        url: `http://127.0.0.1:${PORT}`,
        kind: 'node'
      }
      return this.status
    } catch (err) {
      this.status = {
        running: false,
        url: null,
        kind: 'node',
        error: err instanceof Error ? err.message : String(err)
      }
      return this.status
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
    if (this.nodeProc) {
      this.nodeProc.kill()
      this.nodeProc = null
    }
    this.status = { running: false, url: null, kind: 'unknown' }
  }
}

function detectProject(root: string): { kind: PreviewKind; serveDir: string | null } {
  // Prefer a built output directory for SPA frameworks.
  for (const dir of ['dist', 'build', 'out', 'public']) {
    const p = join(root, dir)
    if (existsSync(join(p, 'index.html'))) return { kind: 'react', serveDir: p }
  }
  if (existsSync(join(root, 'index.html'))) {
    return { kind: 'static', serveDir: root }
  }
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
        scripts?: Record<string, string>
      }
      if (pkg.scripts?.start) return { kind: 'node', serveDir: null }
    } catch {
      // fall through
    }
  }
  // Any HTML file anywhere at the top level?
  try {
    if (readdirSync(root).some((f) => f.endsWith('.html'))) {
      return { kind: 'static', serveDir: root }
    }
  } catch {
    // ignore
  }
  return { kind: 'unknown', serveDir: null }
}

export const previewManager = new PreviewManager()

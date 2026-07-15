import { spawn, type ChildProcess } from 'child_process'
import { existsSync, statSync } from 'fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type {
  JobProfileJson,
  LoadProfileResult,
  OkResult,
  ProbeResult,
  ProfileListEntry,
  SaveProfileResult
} from './types'

const ID = 'robocopy-gui'
const PROFILE_EXT = '.rcjob.json'

/** Same location the C# runner used: %SystemRoot%\System32\robocopy.exe. */
function robocopyPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'robocopy.exe')
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isJobProfile(value: unknown): value is JobProfileJson {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return 'Source' in v || 'Destination' in v || 'Flags' in v
}

/** Windows-invalid filename characters -> '-', so any profile name is saveable. */
function sanitizeProfileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim()
  return safe.length > 0 ? safe : 'job'
}

export default function register(ctx: ModuleIpcContext): void {
  const moduleDir = (): string => join(ctx.app.getPath('userData'), 'modules', ID)
  const profilesDir = (): string => join(moduleDir(), 'profiles')
  const lastSessionPath = (): string => join(moduleDir(), 'last-session.json')

  /* ------------------------------------------------------------------ *
   *  Run state — one robocopy job at a time (matches the original app).
   * ------------------------------------------------------------------ */
  let child: ChildProcess | null = null
  let killed = false
  let finished = false
  let pendingLines: string[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  const flushOutput = (): void => {
    if (pendingLines.length === 0) return
    const lines = pendingLines
    pendingLines = []
    send(`${ID}:output`, lines)
  }

  const finish = (code: number): void => {
    if (finished) return
    finished = true
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    flushOutput()
    child = null
    send(`${ID}:exit`, { code })
  }

  /* ------------------------------------------------------------------ *
   *  Availability probe (IsRobocopyAvailable equivalent).
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(`${ID}:probe`, (): ProbeResult => {
    const path = robocopyPath()
    return { available: existsSync(path), path, running: child !== null }
  })

  ctx.ipcMain.handle(`${ID}:dir-exists`, (_e, path: string): boolean => {
    return typeof path === 'string' && path.length > 0 && isDirectory(path)
  })

  /* ------------------------------------------------------------------ *
   *  Pickers.
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(
    `${ID}:pick-folder`,
    async (_e, title: string, current: string): Promise<string | null> => {
      const win = ctx.getMainWindow()
      if (!win) return null
      const trimmed = typeof current === 'string' ? current.trim().replace(/^"+|"+$/g, '') : ''
      const res = await ctx.dialog.showOpenDialog(win, {
        title: typeof title === 'string' ? title : 'Pick a folder',
        defaultPath: trimmed && isDirectory(trimmed) ? trimmed : undefined,
        properties: ['openDirectory', 'createDirectory']
      })
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    }
  )

  ctx.ipcMain.handle(`${ID}:pick-log-file`, async (): Promise<string | null> => {
    const win = ctx.getMainWindow()
    if (!win) return null
    const res = await ctx.dialog.showSaveDialog(win, {
      title: 'Where should the report be saved?',
      defaultPath: 'robocopy.log',
      filters: [
        { name: 'Log file', extensions: ['log'] },
        { name: 'Text file', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled || !res.filePath ? null : res.filePath
  })

  /* ------------------------------------------------------------------ *
   *  Run / cancel. The renderer sends the fully built argument string
   *  (CommandBuilder port in store.ts); spawning with
   *  windowsVerbatimArguments keeps its quoting byte-for-byte intact,
   *  exactly like ProcessStartInfo.Arguments did in the C# app.
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(`${ID}:run`, (_e, args: string): OkResult => {
    if (typeof args !== 'string' || args.trim().length === 0)
      return { ok: false, error: 'Empty robocopy arguments.' }
    if (child) return { ok: false, error: 'A job is already running.' }

    const exe = robocopyPath()
    if (!existsSync(exe)) return { ok: false, error: `robocopy.exe was not found at ${exe}.` }

    killed = false
    finished = false
    pendingLines = []

    let proc: ChildProcess
    try {
      proc = spawn(exe, [args], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    child = proc

    // Robocopy writes legacy console output (OEM code page) and rewinds
    // progress lines with bare \r — split on any newline flavor. latin1 keeps
    // every byte (no UTF-8 mangling); accented file names may render
    // approximately, same class of quirk the OEM decode had in the C# app.
    const makeLineSink = (): ((chunk: Buffer) => void) => {
      let remainder = ''
      return (chunk: Buffer): void => {
        const text = remainder + chunk.toString('latin1')
        const lines = text.split(/\r\n|\r|\n/)
        remainder = lines.pop() ?? ''
        pendingLines.push(...lines)
      }
    }
    proc.stdout?.on('data', makeLineSink())
    proc.stderr?.on('data', makeLineSink())

    proc.on('error', (err) => {
      pendingLines.push('', `Failed to start robocopy: ${err.message}`)
      finish(16)
    })
    proc.on('close', (code) => {
      // -1 = cancelled, same convention as the C# RobocopyRunner.
      finish(killed ? -1 : (code ?? -1))
    })

    // Batch output every 150 ms like the original's flush timer, so huge
    // jobs don't flood the IPC channel line-by-line.
    flushTimer = setInterval(flushOutput, 150)

    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:cancel`, (): OkResult => {
    const proc = child
    if (!proc) return { ok: false, error: 'No job is running.' }
    killed = true
    try {
      proc.kill()
    } catch {
      // already exited — nothing to do
    }
    return { ok: true }
  })

  /* ------------------------------------------------------------------ *
   *  Elevated run. WICKED itself never elevates (module contract): the
   *  job is launched through PowerShell Start-Process -Verb RunAs in its
   *  own visible console (cmd /k keeps the window open so the summary
   *  stays readable). Output cannot be streamed back from an elevated
   *  process — the UI shows a note instead. This replaces the original
   *  app's whole-app "Restart as administrator" flow.
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(`${ID}:run-elevated`, async (_e, args: string): Promise<OkResult> => {
    if (typeof args !== 'string' || args.trim().length === 0)
      return { ok: false, error: 'Empty robocopy arguments.' }

    const exe = robocopyPath()
    if (!existsSync(exe)) return { ok: false, error: `robocopy.exe was not found at ${exe}.` }

    // Everything user-controlled travels inside PowerShell single-quoted
    // strings ('' escapes a quote). Start-Process passes the single
    // ArgumentList string verbatim to cmd.exe. The exe path is deliberately
    // NOT quoted: %SystemRoot%\System32 never contains spaces, and a /k tail
    // that starts with a quote triggers cmd's quote-stripping heuristic,
    // which would mangle the quoted robocopy arguments.
    const cmdLine = `/k ${exe} ${args}`.replace(/'/g, "''")
    const psCommand =
      `try { Start-Process -FilePath 'cmd.exe' -ArgumentList '${cmdLine}' -Verb RunAs } ` +
      `catch { Write-Error $_; exit 1 }`
    // -EncodedCommand sidesteps every cmd/argv quoting layer.
    const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')

    return await new Promise<OkResult>((resolve) => {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let stderr = ''
      ps.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      ps.on('error', (err) => resolve({ ok: false, error: err.message }))
      ps.on('close', (code) => {
        if (code === 0) {
          resolve({ ok: true })
          return
        }
        // PowerShell serializes stderr as CLIXML when spawned like this —
        // pull the readable error strings back out.
        const errParts = [...stderr.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1])
        const message = (errParts.length > 0 ? errParts.join('') : stderr)
          .replace(/_x000D__x000A_/g, ' ')
          .replace(/#< CLIXML/g, '')
          .trim()
        resolve({
          ok: false,
          error: /cancell?ed/i.test(message)
            ? 'The UAC prompt was declined.'
            : message || 'The UAC prompt was declined.'
        })
      })
    })
  })

  /* ------------------------------------------------------------------ *
   *  Job profiles — `*.rcjob.json` files, same JSON shape as the C#
   *  ProfileStore (PascalCase JobProfile). Old files drop in unchanged.
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(`${ID}:profiles-list`, async (): Promise<ProfileListEntry[]> => {
    const dir = profilesDir()
    await mkdir(dir, { recursive: true })
    const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(PROFILE_EXT))
    const entries: ProfileListEntry[] = []
    for (const file of files) {
      let modifiedMs = 0
      try {
        modifiedMs = (await stat(join(dir, file))).mtimeMs
      } catch {
        // listable anyway
      }
      entries.push({ name: file.slice(0, -PROFILE_EXT.length), file, modifiedMs })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return entries
  })

  ctx.ipcMain.handle(
    `${ID}:profile-save`,
    async (_e, name: string, profile: JobProfileJson): Promise<SaveProfileResult> => {
      if (typeof name !== 'string' || !isJobProfile(profile))
        return { ok: false, error: 'Invalid profile payload.' }
      try {
        const dir = profilesDir()
        await mkdir(dir, { recursive: true })
        const file = sanitizeProfileName(name) + PROFILE_EXT
        await writeFile(join(dir, file), JSON.stringify(profile, null, 2), 'utf8')
        return { ok: true, file }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ctx.ipcMain.handle(`${ID}:profile-load`, async (_e, file: string): Promise<LoadProfileResult> => {
    if (typeof file !== 'string') return { ok: false, error: 'Invalid file name.' }
    try {
      // basename() confines reads to the profiles folder.
      const raw = await readFile(join(profilesDir(), basename(file)), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isJobProfile(parsed)) return { ok: false, error: 'Not a robocopy job file.' }
      return { ok: true, profile: parsed }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:profile-delete`, async (_e, file: string): Promise<OkResult> => {
    if (typeof file !== 'string') return { ok: false, error: 'Invalid file name.' }
    try {
      await rm(join(profilesDir(), basename(file)))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ctx.ipcMain.handle(`${ID}:open-profiles-folder`, async (): Promise<void> => {
    await mkdir(profilesDir(), { recursive: true })
    await ctx.shell.openPath(profilesDir())
  })

  /* ------------------------------------------------------------------ *
   *  Last session — best-effort, like TrySave/TryLoadLastSession.
   * ------------------------------------------------------------------ */
  ctx.ipcMain.handle(`${ID}:session-load`, async (): Promise<JobProfileJson | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(lastSessionPath(), 'utf8'))
      return isJobProfile(parsed) ? parsed : null
    } catch {
      return null // missing or corrupt — start fresh
    }
  })

  ctx.ipcMain.handle(`${ID}:session-save`, async (_e, profile: JobProfileJson): Promise<void> => {
    if (!isJobProfile(profile)) return
    try {
      await mkdir(moduleDir(), { recursive: true })
      await writeFile(lastSessionPath(), JSON.stringify(profile, null, 2), 'utf8')
    } catch {
      // best effort only
    }
  })
}

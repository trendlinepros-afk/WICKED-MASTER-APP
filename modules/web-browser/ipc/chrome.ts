import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Locating and launching the user's real Google Chrome install ("Full Chrome"
 * mode). The embedded <webview> browser cannot run Chrome extensions — that is
 * an Electron platform limit — so anything extension-dependent (e.g. the
 * Claude in Chrome extension) runs in this real Chrome instead, driven over
 * the DevTools protocol (see cdp.ts).
 */

/** Standard Chrome install locations, most common first. */
export function chromeCandidates(): string[] {
  const out: string[] = []
  const win = (base: string | undefined): void => {
    if (base) out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  win(process.env['ProgramFiles'])
  win(process.env['ProgramFiles(x86)'])
  win(process.env['LOCALAPPDATA'])
  // non-Windows fallbacks so dev environments still resolve something
  out.push(
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  )
  return out
}

/** A user-set custom path wins; otherwise the first existing candidate. */
export function findChrome(customPath: string): string | null {
  if (customPath && existsSync(customPath)) return customPath
  for (const p of chromeCandidates()) if (existsSync(p)) return p
  return null
}

/**
 * Launch full Chrome, detached, with the module's dedicated profile and the
 * localhost-only DevTools port. Chrome 136+ ignores --remote-debugging-port on
 * the *default* profile, so a dedicated persistent user-data-dir is required —
 * the user signs into Chrome sync there once and their bookmarks + extensions
 * follow. If a Chrome with this profile is already running, the new process
 * just opens a window in the existing instance and exits.
 */
export function launchChrome(exe: string, profileDir: string, port: number, url?: string): void {
  mkdirSync(profileDir, { recursive: true })
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
  if (url) args.push(url)
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

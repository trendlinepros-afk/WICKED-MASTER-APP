/**
 * Pure path helpers shared by the engine (main) and the UI (renderer).
 *
 * A "storePath" is the platform-neutral, '/'-joined key a file is kept under
 * inside a backup — and the relative path of its bytes under `data/`:
 *
 *   C:\Users\me\file.txt        → C/Users/me/file.txt
 *   \\nas\share\docs\file.txt   → UNC/nas/share/docs/file.txt
 *   /home/me/file.txt           → ROOT/home/me/file.txt   (non-Windows)
 */

export function toStorePath(abs: string, platform: string): string {
  if (platform === 'win32') {
    let p = abs.replace(/\//g, '\\')
    if (/^\\\\\?\\UNC\\/i.test(p)) p = '\\\\' + p.slice(8)
    else if (p.startsWith('\\\\?\\')) p = p.slice(4)
    const parts = p.split('\\').filter(Boolean)
    if (p.startsWith('\\\\')) return ['UNC', ...parts].join('/')
    const drive = /^([a-zA-Z]):$/.exec(parts[0] ?? '')
    if (drive) return [drive[1].toUpperCase(), ...parts.slice(1)].join('/')
    return parts.join('/')
  }
  return ['ROOT', ...abs.split('/').filter(Boolean)].join('/')
}

/** Inverse of toStorePath (for "restore to original location"). */
export function fromStorePath(sp: string, platform: string): string {
  const parts = sp.split('/').filter(Boolean)
  if (platform === 'win32') {
    if (parts[0] === 'UNC') return '\\\\' + parts.slice(1).join('\\')
    if (/^[A-Z]$/.test(parts[0] ?? '')) return `${parts[0]}:\\` + parts.slice(1).join('\\')
    return parts.join('\\')
  }
  return '/' + (parts[0] === 'ROOT' ? parts.slice(1) : parts).join('/')
}

/** How a (possibly partial) storePath reads to a person. */
export function displayStorePath(sp: string, platform: string): string {
  if (!sp) return 'All files'
  const parts = sp.split('/')
  if (platform === 'win32') {
    if (parts[0] === 'UNC') return '\\\\' + parts.slice(1).join('\\')
    if (/^[A-Z]$/.test(parts[0])) return `${parts[0]}:\\` + parts.slice(1).join('\\')
    return parts.join('\\')
  }
  return '/' + (parts[0] === 'ROOT' ? parts.slice(1) : parts).join('/')
}

/** Display name of one segment in the browser (drive letters get their colon). */
export function segmentLabel(sp: string, platform: string): string {
  const parts = sp.split('/')
  const last = parts[parts.length - 1] ?? ''
  if (parts.length === 1) {
    if (platform === 'win32' && /^[A-Z]$/.test(last)) return `${last}:`
    if (last === 'UNC') return 'Network'
    if (last === 'ROOT') return '/'
  }
  return last
}

/** Case-insensitive identity on Windows, exact elsewhere. */
export function pathKey(sp: string, platform: string): string {
  return platform === 'win32' ? sp.toLowerCase() : sp
}

export function parentOf(sp: string): string {
  const i = sp.lastIndexOf('/')
  return i < 0 ? '' : sp.slice(0, i)
}

export function baseName(sp: string): string {
  const i = sp.lastIndexOf('/')
  return i < 0 ? sp : sp.slice(i + 1)
}

/* ------------------------------ exclusions ------------------------------ */

export const DEFAULT_EXCLUSIONS = [
  'Thumbs.db',
  'desktop.ini',
  '~$*',
  '*.tmp',
  '$RECYCLE.BIN',
  'System Volume Information',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  // Windows profile registry hives — always locked by Windows while signed in
  'NTUSER.DAT*',
  'ntuser.ini',
  'UsrClass.dat*',
  'C:\\Users\\*\\AppData\\Local\\Temp'
]

export interface Excluder {
  /** true if this entry (and, for a folder, everything under it) is skipped */
  test(storePath: string, name: string): boolean
}

function globToRegex(glob: string): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

/**
 * Patterns without a slash match an entry's NAME anywhere (`*.tmp`,
 * `node_modules`); patterns with a slash match its full path
 * (`C:\Users\me\Downloads`, `C:\Users\*\AppData\Local\Temp`).
 */
export function makeExcluder(patterns: string[], platform: string): Excluder {
  const flags = platform === 'win32' ? 'i' : ''
  const byName: RegExp[] = []
  const byPath: RegExp[] = []
  for (const raw of patterns) {
    const p = raw.trim()
    if (!p) continue
    if (/[\\/]/.test(p)) {
      const sp = toStorePath(p.replace(/[\\/]+$/, ''), platform)
      byPath.push(new RegExp(`^${globToRegex(sp)}$`, flags))
    } else byName.push(new RegExp(`^${globToRegex(p)}$`, flags))
  }
  return {
    test: (sp, name) => byName.some((r) => r.test(name)) || byPath.some((r) => r.test(sp))
  }
}

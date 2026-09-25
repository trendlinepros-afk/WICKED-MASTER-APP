/**
 * Network-share login for backup destinations like \\nas\backups\PC1.
 *
 * Uses WNetAddConnection2 (the API behind `net use`) through a short-lived
 * PowerShell, with the password passed on STDIN — never on a command line
 * where other processes could read it. The connection is device-less and lasts
 * for this Windows sign-in session, so WICKED's own file calls can then reach
 * the share. No-op for local folders, mapped drives and non-Windows hosts.
 */
import { spawn } from 'child_process'
import { access, constants } from 'fs/promises'

/** \\server\share of a UNC path, or null for local/mapped paths. */
export function shareRoot(path: string): string | null {
  const m = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(path.replace(/\//g, '\\'))
  return m ? `\\\\${m[1]}\\${m[2]}` : null
}

const connected = new Set<string>()

const MESSAGES: Record<number, string> = {
  5: 'Access denied by the network share.',
  53: 'The network path was not found — check the server name and that it is powered on.',
  67: 'The share name was not found on that server.',
  86: 'The network password is incorrect.',
  1203: 'The network path was not found.',
  1244: 'The share requires a user name and password.',
  1326: 'Unknown user name or bad password for the network share.',
  1327: 'The account is not allowed to sign in to the share (account restriction).',
  1330: 'The password for the share account has expired.',
  1331: 'The share account is disabled.',
  1909: 'The share account is locked out.',
  2202: 'The user name format is not valid (try SERVER\\user or DOMAIN\\user).'
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -Namespace WkBackup -Name Mpr -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public class NETRESOURCE {
  public int dwScope; public int dwType; public int dwDisplayType; public int dwUsage;
  public string lpLocalName; public string lpRemoteName; public string lpComment; public string lpProvider;
}
[DllImport("mpr.dll", CharSet = CharSet.Unicode)]
public static extern int WNetAddConnection2(NETRESOURCE netResource, string password, string username, int flags);
'@
$nr = New-Object 'WkBackup.Mpr+NETRESOURCE'
$nr.dwType = 1
$nr.lpRemoteName = [string]$in.share
$user = $null; if ($in.user) { $user = [string]$in.user }
$pw = $null; if ($in.password) { $pw = [string]$in.password }
$rc = [WkBackup.Mpr]::WNetAddConnection2($nr, $pw, $user, 0)
Write-Output ('{"rc":' + $rc + '}')
`

function wnetAdd(share: string, user: string, password: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Timed out connecting to the network share.'))
    }, 45_000)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`Could not start PowerShell: ${e.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const m = /"rc":(\d+)/.exec(out)
      if (m) resolve(Number(m[1]))
      else reject(new Error(`Could not connect to the network share. ${err.trim().slice(0, 300)}`))
    })
    child.stdin.end(JSON.stringify({ share, user, password }))
  })
}

async function reachable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Make sure `path` is reachable, signing in to its share first when a user
 * name is configured. Throws a readable error when it can't be reached.
 */
export async function ensureShare(path: string, user: string, password: string | null, force = false): Promise<void> {
  const share = shareRoot(path)
  if (!share || process.platform !== 'win32') return
  if (!force && connected.has(share.toLowerCase()) && (await reachable(share))) return
  if (user) {
    const rc = await wnetAdd(share, user, password ?? '')
    // 1219: already connected to this server with other credentials — fine if it works
    if (rc !== 0 && rc !== 1219) throw new Error(MESSAGES[rc] ?? `Could not connect to ${share} (Windows error ${rc}).`)
  }
  if (!(await reachable(share)))
    throw new Error(
      user
        ? `Signed in, but ${share} is not accessible.`
        : `Can't reach ${share}. If it needs a login, add the user name and password in the plan's destination settings.`
    )
  connected.add(share.toLowerCase())
}

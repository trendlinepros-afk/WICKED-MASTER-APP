/**
 * File Vault's Google Drive connection, shared with other modules in the main
 * process (Backup uses it for its offsite copy). Only a token getter and a
 * connected/email status cross this boundary — the OAuth client secret and
 * refresh token never leave File Vault's ipc.ts.
 */
export interface DriveProvider {
  /** a fresh access token (refreshing as needed); throws if not connected */
  getToken: () => Promise<string>
  status: () => { connected: boolean; email: string }
}

let provider: DriveProvider | null = null

export function setDriveProvider(p: DriveProvider): void {
  provider = p
}

/** null until File Vault's register() has run */
export function getDriveProvider(): DriveProvider | null {
  return provider
}

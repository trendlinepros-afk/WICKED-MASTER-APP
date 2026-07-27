import { ipcMain, safeStorage, type BrowserWindow } from 'electron'
import Store from 'electron-store'
import { API_PROVIDERS, SHELL_IPC, type ApiProviderId } from '@shared/types'

/**
 * Central API key vault. One place to set provider keys; every module reads
 * them in its main-process code via ctx.getApiKey(). Values are encrypted at
 * rest with Electron safeStorage (DPAPI on Windows) and are never sent to the
 * renderer — the renderer only gets set/not-set booleans.
 */
const store = new Store<{ keys: Partial<Record<ApiProviderId, string>> }>({
  name: 'wicked-keys',
  defaults: { keys: {} }
})

/**
 * The backup password lives in its OWN store (wicked-backup.json) which is NOT
 * in the backup include-list, so it never travels inside a backup. It's
 * safeStorage-encrypted (machine-bound) so scheduled backups can use it, while
 * the user must re-type it on another computer to unlock a restored key set.
 */
const backupStore = new Store<{ pw?: string }>({ name: 'wicked-backup', defaults: {} })

const VALID_IDS = new Set<string>(API_PROVIDERS.map((p) => p.id))

export function getApiKey(id: string): string | null {
  if (!VALID_IDS.has(id)) return null
  const b64 = store.get('keys')[id as ApiProviderId]
  if (!b64) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    // encrypted under a different OS user/profile — treat as unset
    return null
  }
}

export function apiKeyStatus(): Record<ApiProviderId, boolean> {
  const keys = store.get('keys')
  return Object.fromEntries(
    API_PROVIDERS.map((p) => [p.id, Boolean(keys[p.id])])
  ) as Record<ApiProviderId, boolean>
}

function setApiKey(id: string, value: string): { ok: boolean; error?: string } {
  if (!VALID_IDS.has(id)) return { ok: false, error: `Unknown provider: ${id}` }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS encryption unavailable — refusing to store the key.' }
  }
  const trimmed = value.trim()
  if (!trimmed) return { ok: false, error: 'Key is empty.' }
  store.set('keys', {
    ...store.get('keys'),
    [id]: safeStorage.encryptString(trimmed).toString('base64')
  })
  return { ok: true }
}

function clearApiKey(id: string): void {
  if (!VALID_IDS.has(id)) return
  const keys = { ...store.get('keys') }
  delete keys[id as ApiProviderId]
  store.set('keys', keys)
}

/* -------------------- portable backup of the key vault -------------------- */

/** All keys decrypted to plaintext { id: value } (for making a portable backup). */
export function getAllDecryptedKeys(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!safeStorage.isEncryptionAvailable()) return out
  const keys = store.get('keys')
  for (const [id, b64] of Object.entries(keys)) {
    if (!b64) continue
    try {
      out[id] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      /* skip a key that won't decrypt on this machine */
    }
  }
  return out
}

/** Re-encrypt a plaintext { id: value } map into the on-disk store shape. */
export function encryptKeysToStoreShape(plain: Record<string, string>): { keys: Record<string, string> } {
  const keys: Record<string, string> = {}
  if (safeStorage.isEncryptionAvailable()) {
    for (const [id, value] of Object.entries(plain)) {
      if (!VALID_IDS.has(id) || !value) continue
      keys[id] = safeStorage.encryptString(value).toString('base64')
    }
  }
  return { keys }
}

/* backup password (machine-bound; never included in a backup) */
export function getBackupPassword(): string | null {
  const b64 = backupStore.get('pw')
  if (!b64 || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}
export function hasBackupPassword(): boolean {
  return !!backupStore.get('pw')
}
export function setBackupPassword(pw: string): { ok: boolean; error?: string } {
  const trimmed = pw.trim()
  if (!trimmed) return { ok: false, error: 'Password is empty.' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'OS encryption unavailable.' }
  backupStore.set('pw', safeStorage.encryptString(trimmed).toString('base64'))
  return { ok: true }
}
export function clearBackupPassword(): void {
  backupStore.delete('pw')
}

export function registerApiKeyIpc(getWin: () => BrowserWindow | null): void {
  const broadcast = (): void => {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send(SHELL_IPC.apiKeysChanged, apiKeyStatus())
    }
  }

  ipcMain.handle(SHELL_IPC.apiKeysStatus, () => apiKeyStatus())
  ipcMain.handle(SHELL_IPC.apiKeySet, (_e, id: string, value: string) => {
    const res = setApiKey(id, value)
    if (res.ok) broadcast()
    return res
  })
  ipcMain.handle(SHELL_IPC.apiKeyClear, (_e, id: string) => {
    clearApiKey(id)
    broadcast()
  })
}

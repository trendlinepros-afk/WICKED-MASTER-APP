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

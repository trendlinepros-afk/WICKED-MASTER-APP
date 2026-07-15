/**
 * MFA Tool module state (Zustand 5).
 *
 * The master passphrase is held in a module-level variable (never in store
 * state) for as long as the vault is unlocked — same lifetime as the Python
 * GUI's `self.password`. Locking clears it and drops all plaintext accounts.
 */

import { create } from 'zustand'
import { dedupeKey, type VaultAccount } from './lib/migration'

const ID = 'mfa-tool'

/** A vault account plus a session-local row id for the UI. */
export interface Account extends VaultAccount {
  id: string
}

export interface VaultStatus {
  exists: boolean
  legacyExists: boolean
  path: string
  legacyPath: string
}

export type Phase = 'loading' | 'create' | 'locked' | 'unlocked'

type OkResult = { ok: true } | { ok: false; error: string }
type UnlockResult = { ok: true; accounts: VaultAccount[] } | { ok: false; error: string }

let passphrase: string | null = null
let uidCounter = 0

function uid(): string {
  uidCounter += 1
  return `acc-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`
}

function withIds(accounts: VaultAccount[]): Account[] {
  return accounts.map((a) => ({ ...a, id: uid() }))
}

function stripId(account: Account): VaultAccount {
  const { id: _id, ...rest } = account
  return rest
}

function friendly(error: string): string {
  return error === 'invalid-password' ? 'Wrong password. Try again.' : error
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface MfaState {
  phase: Phase
  status: VaultStatus | null
  accounts: Account[]
  error: string | null
  busy: boolean

  init: () => Promise<void>
  createVault: (pw: string) => Promise<boolean>
  unlock: (pw: string) => Promise<boolean>
  importLegacy: (pw: string) => Promise<boolean>
  lock: () => void
  /** merge + persist; returns {found, added} or null on failure */
  addAccounts: (parsed: VaultAccount[]) => Promise<{ found: number; added: number } | null>
  removeAccount: (id: string) => Promise<void>
  clearError: () => void
}

export const useMfa = create<MfaState>((set, get) => ({
  phase: 'loading',
  status: null,
  accounts: [],
  error: null,
  busy: false,

  init: async () => {
    if (get().phase !== 'loading') return // keep unlocked state across remounts
    try {
      const status = (await window.wicked.invoke(`${ID}:status`)) as VaultStatus
      set({ status, phase: status.exists ? 'locked' : 'create' })
    } catch (err) {
      set({ error: message(err), phase: 'create' })
    }
  },

  createVault: async (pw) => {
    set({ busy: true, error: null })
    try {
      const res = (await window.wicked.invoke(`${ID}:create`, pw)) as OkResult
      if (!res.ok) {
        set({ busy: false, error: friendly(res.error) })
        return false
      }
      passphrase = pw
      set((s) => ({
        busy: false,
        phase: 'unlocked',
        accounts: [],
        status: s.status ? { ...s.status, exists: true } : s.status
      }))
      return true
    } catch (err) {
      set({ busy: false, error: message(err) })
      return false
    }
  },

  unlock: async (pw) => {
    set({ busy: true, error: null })
    try {
      const res = (await window.wicked.invoke(`${ID}:unlock`, pw)) as UnlockResult
      if (!res.ok) {
        set({ busy: false, error: friendly(res.error) })
        return false
      }
      passphrase = pw
      set({ busy: false, phase: 'unlocked', accounts: withIds(res.accounts) })
      return true
    } catch (err) {
      set({ busy: false, error: message(err) })
      return false
    }
  },

  importLegacy: async (pw) => {
    set({ busy: true, error: null })
    try {
      const res = (await window.wicked.invoke(`${ID}:import-legacy`, pw)) as UnlockResult
      if (!res.ok) {
        set({ busy: false, error: friendly(res.error) })
        return false
      }
      passphrase = pw
      set((s) => ({
        busy: false,
        phase: 'unlocked',
        accounts: withIds(res.accounts),
        status: s.status ? { ...s.status, exists: true } : s.status
      }))
      return true
    } catch (err) {
      set({ busy: false, error: message(err) })
      return false
    }
  },

  lock: () => {
    passphrase = null
    set({ phase: 'locked', accounts: [], error: null })
  },

  addAccounts: async (parsed) => {
    if (passphrase === null) {
      set({ error: 'Vault is locked.' })
      return null
    }
    const current = get().accounts
    const seen = new Set(current.map(dedupeKey))
    const additions: Account[] = []
    for (const p of parsed) {
      const key = dedupeKey(p)
      if (!seen.has(key)) {
        seen.add(key)
        additions.push({ ...p, id: uid() })
      }
    }
    const next = [...current, ...additions]
    try {
      const res = (await window.wicked.invoke(`${ID}:save`, passphrase, next.map(stripId))) as OkResult
      if (!res.ok) {
        set({ error: friendly(res.error) })
        return null
      }
      set({ accounts: next, error: null })
      return { found: parsed.length, added: additions.length }
    } catch (err) {
      set({ error: message(err) })
      return null
    }
  },

  removeAccount: async (id) => {
    if (passphrase === null) return
    const next = get().accounts.filter((a) => a.id !== id)
    try {
      const res = (await window.wicked.invoke(`${ID}:save`, passphrase, next.map(stripId))) as OkResult
      if (!res.ok) {
        set({ error: friendly(res.error) })
        return
      }
      set({ accounts: next })
    } catch (err) {
      set({ error: message(err) })
    }
  },

  clearError: () => set({ error: null })
}))

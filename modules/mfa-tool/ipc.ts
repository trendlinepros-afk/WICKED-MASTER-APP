/**
 * MFA Tool — main-process vault persistence.
 *
 * Replicates vault.py's on-disk format exactly so vault files are
 * interchangeable with the standalone Python tool:
 *
 *   {
 *     "version": 1,
 *     "kdf": "scrypt",
 *     "kdf_params": { "n": 16384, "r": 8, "p": 1 },
 *     "cipher": "AES-256-GCM",
 *     "salt": base64(16 bytes),
 *     "nonce": base64(12 bytes),
 *     "ciphertext": base64(ciphertext || 16-byte GCM tag)
 *   }
 *
 * The plaintext is UTF-8 JSON `{"accounts": [Account.to_dict(), ...]}`.
 * Python's `cryptography` AESGCM appends the 16-byte auth tag to the
 * ciphertext; Node's aes-256-gcm keeps it separate, so it is concatenated on
 * save and split off on load.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'

const ID = 'mfa-tool'

/* --- constants mirroring vault.py ------------------------------------------ */
const VAULT_VERSION = 1
const SCRYPT_N = 2 ** 14 // ~16 MB of memory, comfortably fast on a desktop
const SCRYPT_R = 8
const SCRYPT_P = 1
/** 128 * N * r = 16 MiB; give scryptSync headroom above Node's 32 MiB default. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024
const GCM_TAG_LENGTH = 16

/**
 * One vault entry — key set/order mirrors migration.py's Account.to_dict().
 * (Duplicated from lib/migration.ts: ipc.ts compiles in the node tsconfig
 * project and cannot import renderer-project files. Keep them in sync.)
 */
interface VaultAccount {
  name: string
  issuer: string
  secret: string
  algorithm: string
  digits: number
  type: string
  counter: number
  period: number
}

interface VaultBlob {
  version: number
  kdf: string
  kdf_params: { n: number; r: number; p: number }
  cipher: string
  salt: string
  nonce: string
  ciphertext: string
}

/** Wrong master password, or the vault file has been tampered with. */
class InvalidPassword extends Error {}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

function int(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v))
  }
  return fallback
}

/** Mirrors Account.from_dict's defaults (tolerant of missing keys). */
function sanitizeAccount(d: unknown): VaultAccount {
  const o = (d ?? {}) as Record<string, unknown>
  return {
    name: str(o.name, ''),
    issuer: str(o.issuer, ''),
    secret: str(o.secret, ''),
    algorithm: str(o.algorithm, 'SHA1'),
    digits: int(o.digits, 6),
    type: str(o.type, 'totp'),
    counter: int(o.counter, 0),
    period: int(o.period, 30)
  }
}

function deriveKey(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(Buffer.from(password, 'utf8'), salt, 32, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM
  })
}

/** Encrypt `accounts` under `password` and write the vault atomically. */
function saveVault(path: string, password: string, accounts: VaultAccount[]): void {
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const key = deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)

  const plaintext = Buffer.from(JSON.stringify({ accounts: accounts.map(sanitizeAccount) }), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const blob: VaultBlob = {
    version: VAULT_VERSION,
    kdf: 'scrypt',
    kdf_params: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    cipher: 'AES-256-GCM',
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }

  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(blob, null, 2), 'utf8')
  renameSync(tmp, path) // replaces existing file (os.replace equivalent)
}

/** Decrypt the vault at `path` with `password`; throws InvalidPassword when wrong. */
function loadVault(path: string, password: string): VaultAccount[] {
  const blob = JSON.parse(readFileSync(path, 'utf8')) as Partial<VaultBlob>
  if (typeof blob.salt !== 'string' || typeof blob.nonce !== 'string' || typeof blob.ciphertext !== 'string') {
    throw new Error('vault file is malformed')
  }
  const salt = Buffer.from(blob.salt, 'base64')
  const nonce = Buffer.from(blob.nonce, 'base64')
  const data = Buffer.from(blob.ciphertext, 'base64')
  const params = blob.kdf_params ?? { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
  const key = deriveKey(password, salt, params.n, params.r, params.p)

  if (data.length < GCM_TAG_LENGTH) {
    throw new InvalidPassword('wrong master password or corrupted vault')
  }
  const tag = data.subarray(data.length - GCM_TAG_LENGTH)
  const body = data.subarray(0, data.length - GCM_TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new InvalidPassword('wrong master password or corrupted vault')
  }

  const parsed = JSON.parse(plaintext.toString('utf8')) as { accounts?: unknown[] }
  return (parsed.accounts ?? []).map(sanitizeAccount)
}

/** vault.py's default_vault_path(): %APPDATA%\MFA Tool\vault.json (~/.mfa_tool elsewhere). */
function legacyVaultPath(): string {
  const base = process.env.APPDATA || join(homedir(), '.mfa_tool')
  return join(base, 'MFA Tool', 'vault.json')
}

type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

function errorOf(err: unknown): string {
  if (err instanceof InvalidPassword) return 'invalid-password'
  return err instanceof Error ? err.message : String(err)
}

export default function register(ctx: ModuleIpcContext): void {
  const vaultPath = (): string =>
    join(ctx.app.getPath('userData'), 'modules', 'mfa-tool', 'vault.json')

  ctx.ipcMain.handle(`${ID}:status`, () => {
    const path = vaultPath()
    const legacyPath = legacyVaultPath()
    return {
      exists: existsSync(path),
      legacyExists: existsSync(legacyPath),
      path,
      legacyPath
    }
  })

  // Data paths — surfaced in Settings → Modules. Only the vault FILE path is
  // exposed (null until the vault is created); never the passphrase or secrets.
  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const path = vaultPath()
    return [
      {
        label: 'Encrypted vault',
        path: existsSync(path) ? path : null,
        note: 'AES-256-GCM encrypted TOTP accounts'
      }
    ]
  })

  ctx.ipcMain.handle(`${ID}:create`, (_e, passphrase: unknown) => {
    if (typeof passphrase !== 'string' || !passphrase) return fail('Password cannot be empty.')
    const path = vaultPath()
    if (existsSync(path)) return fail('A vault already exists — unlock it instead.')
    try {
      saveVault(path, passphrase, [])
      return { ok: true }
    } catch (err) {
      return fail(errorOf(err))
    }
  })

  ctx.ipcMain.handle(`${ID}:unlock`, (_e, passphrase: unknown) => {
    if (typeof passphrase !== 'string' || !passphrase) return fail('Password cannot be empty.')
    const path = vaultPath()
    if (!existsSync(path)) return fail('No vault found — create one first.')
    try {
      return { ok: true, accounts: loadVault(path, passphrase) }
    } catch (err) {
      return fail(errorOf(err))
    }
  })

  ctx.ipcMain.handle(`${ID}:save`, (_e, passphrase: unknown, accounts: unknown) => {
    if (typeof passphrase !== 'string' || !passphrase) return fail('Password cannot be empty.')
    if (!Array.isArray(accounts)) return fail('accounts must be an array')
    try {
      saveVault(vaultPath(), passphrase, accounts.map(sanitizeAccount))
      return { ok: true }
    } catch (err) {
      return fail(errorOf(err))
    }
  })

  /**
   * Unlock the standalone Python tool's vault and adopt it: the legacy file is
   * copied verbatim (formats are identical) after the passphrase is verified.
   */
  ctx.ipcMain.handle(`${ID}:import-legacy`, (_e, passphrase: unknown) => {
    if (typeof passphrase !== 'string' || !passphrase) return fail('Password cannot be empty.')
    const legacyPath = legacyVaultPath()
    if (!existsSync(legacyPath)) return fail('No legacy vault found.')
    try {
      const accounts = loadVault(legacyPath, passphrase)
      const path = vaultPath()
      mkdirSync(dirname(path), { recursive: true })
      copyFileSync(legacyPath, path)
      return { ok: true, accounts }
    } catch (err) {
      return fail(errorOf(err))
    }
  })

  /** selftest.py's test_vault_roundtrip, run against a temp file. */
  ctx.ipcMain.handle(`${ID}:self-test-vault`, () => {
    const path = join(ctx.app.getPath('temp'), 'mfa-tool-selftest-vault.json')
    const password = 'correct horse battery staple'
    const accounts: VaultAccount[] = [
      {
        name: 'alice@example.com',
        issuer: 'GitHub',
        secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', // b"12345678901234567890"
        algorithm: 'SHA1',
        digits: 6,
        type: 'totp',
        counter: 0,
        period: 30
      },
      {
        name: 'bob',
        issuer: 'AWS',
        secret: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA1',
        digits: 6,
        type: 'totp',
        counter: 0,
        period: 30
      }
    ]
    const lines: Array<{ ok: boolean; text: string }> = []
    let ok = true
    try {
      saveVault(path, password, accounts)
      const loaded = loadVault(path, password)
      const match =
        loaded.length === accounts.length &&
        accounts.every((a, i) => {
          const b = loaded[i]
          return a.secret === b.secret && a.issuer === b.issuer && a.name === b.name
        })
      lines.push({
        ok: match,
        text: `round-trip with correct password (${loaded.length} accounts)`
      })
      ok = ok && match

      let rejected = false
      try {
        loadVault(path, 'wrong password')
      } catch (err) {
        rejected = err instanceof InvalidPassword
      }
      lines.push({ ok: rejected, text: 'wrong password is rejected' })
      ok = ok && rejected
    } catch (err) {
      ok = false
      lines.push({ ok: false, text: `vault error: ${errorOf(err)}` })
    } finally {
      try {
        rmSync(path, { force: true })
      } catch {
        /* ignore */
      }
    }
    return { ok, lines }
  })
}

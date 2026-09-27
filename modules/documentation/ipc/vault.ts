/**
 * The vault lock (main process, no Electron imports — testable headless).
 *
 *   setup(password)  → random 256-bit master key, wrapped with a key derived
 *                      from the password (scrypt, N=2^16) using AES-256-GCM.
 *                      Only the wrapped key + salt are written to disk.
 *   unlock(password) → derive, unwrap (GCM's tag rejects a wrong password),
 *                      master key stays in memory until lock/quit.
 *   encrypt/decrypt  → per-value AES-256-GCM with the master key, random IV.
 *
 * The lock file is deliberately NOT bound to this PC (no DPAPI) so a WICKED
 * backup restored on another machine unlocks with the same password. The
 * cost of that: an attacker with the file can try passwords offline at
 * ~0.5 s each — a 4-digit PIN (the minimum the user asked for) falls in
 * ~1.5 h; a real passphrase does not. The setup screen says so. Failed
 * unlocks back off exponentially and the counter survives restarts.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, len: number, o: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>

export const MIN_PASSWORD_LENGTH = 4
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }
const KEY_LEN = 32

export interface VaultFile {
  v: 1
  /** base64 */
  salt: string
  /** base64: iv(12) + tag(16) + ciphertext(32) */
  wrapped: string
  scrypt: { N: number; r: number; p: number }
  failed: number
  /** epoch ms; unlock attempts refused before this */
  lockedUntil: number
  createdAt: number
  changedAt: number
  lastUnlockAt: number | null
}

const b64 = (b: Buffer): string => b.toString('base64')
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64')

async function derive(password: string, salt: Buffer, params: VaultFile['scrypt']): Promise<Buffer> {
  return scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...params, maxmem: SCRYPT.maxmem })
}

function wrap(key: Buffer, master: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(master), c.final()])
  return b64(Buffer.concat([iv, c.getAuthTag(), ct]))
}

function unwrap(key: Buffer, wrapped: string): Buffer | null {
  try {
    const buf = unb64(wrapped)
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()])
  } catch {
    return null
  }
}

export function validatePassword(pw: string): string | null {
  if (typeof pw !== 'string') return 'Enter a password.'
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (pw.length > 256) return 'That is too long.'
  return null
}

export async function setupVault(password: string, now = Date.now()): Promise<{ file: VaultFile; master: Buffer }> {
  const err = validatePassword(password)
  if (err) throw new Error(err)
  const salt = randomBytes(16)
  const master = randomBytes(KEY_LEN)
  const key = await derive(password, salt, SCRYPT)
  return {
    master,
    file: {
      v: 1,
      salt: b64(salt),
      wrapped: wrap(key, master),
      scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      failed: 0,
      lockedUntil: 0,
      createdAt: now,
      changedAt: now,
      lastUnlockAt: null
    }
  }
}

/** Seconds a failed-attempt count has to wait: none for the first 3, then 5 s doubling to 5 min. */
export function backoffSeconds(failed: number): number {
  if (failed < 3) return 0
  return Math.min(300, 5 * 2 ** (failed - 3))
}

export type UnlockResult = { ok: true; master: Buffer; file: VaultFile } | { ok: false; error: string; retryAfter: number; file: VaultFile }

export async function unlockVault(file: VaultFile, password: string, now = Date.now()): Promise<UnlockResult> {
  if (file.lockedUntil > now) {
    const retryAfter = Math.ceil((file.lockedUntil - now) / 1000)
    return { ok: false, error: `Too many attempts — try again in ${retryAfter}s.`, retryAfter, file }
  }
  const key = await derive(password, unb64(file.salt), file.scrypt)
  const master = unwrap(key, file.wrapped)
  if (!master) {
    const failed = file.failed + 1
    const wait = backoffSeconds(failed)
    const next: VaultFile = { ...file, failed, lockedUntil: wait ? now + wait * 1000 : 0 }
    return {
      ok: false,
      error: wait ? `Wrong password — try again in ${wait}s.` : 'Wrong password.',
      retryAfter: wait,
      file: next
    }
  }
  return { ok: true, master, file: { ...file, failed: 0, lockedUntil: 0, lastUnlockAt: now } }
}

/** Re-wrap the master key with a new password (the data itself is untouched). */
export async function rewrapVault(file: VaultFile, master: Buffer, newPassword: string, now = Date.now()): Promise<VaultFile> {
  const err = validatePassword(newPassword)
  if (err) throw new Error(err)
  const salt = randomBytes(16)
  const key = await derive(newPassword, salt, SCRYPT)
  return { ...file, salt: b64(salt), wrapped: wrap(key, master), scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, changedAt: now, failed: 0, lockedUntil: 0 }
}

/* ------------------------------ field values ------------------------------ */

export const ENC_PREFIX = 'enc:v1:'

export function encryptValue(master: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', master, iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return ENC_PREFIX + b64(Buffer.concat([iv, c.getAuthTag(), ct]))
}

export function decryptValue(master: Buffer, stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) throw new Error('Not an encrypted value')
  const buf = unb64(stored.slice(ENC_PREFIX.length))
  const d = createDecipheriv('aes-256-gcm', master, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith(ENC_PREFIX)

/** Constant-time compare for the clipboard auto-clear check. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/* ---------------------------- password generator --------------------------- */

export interface GenOptions {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  /** skip look-alikes: 0 O o 1 l I | */
  avoidAmbiguous: boolean
}

export function generatePassword(o: GenOptions): string {
  const sets: string[] = []
  const amb = /[0Oo1lI|]/g
  const strip = (s: string): string => (o.avoidAmbiguous ? s.replace(amb, '') : s)
  if (o.lower) sets.push(strip('abcdefghijklmnopqrstuvwxyz'))
  if (o.upper) sets.push(strip('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
  if (o.digits) sets.push(strip('0123456789'))
  if (o.symbols) sets.push(strip('!@#$%^&*()-_=+[]{}:;,.?'))
  if (!sets.length) sets.push('abcdefghijklmnopqrstuvwxyz')
  const len = Math.max(4, Math.min(128, Math.round(o.length) || 20))
  const all = sets.join('')
  // one from each chosen set, the rest from the pool, then shuffle
  const out: string[] = sets.map((s) => s[randomBytes(1)[0] % s.length])
  while (out.length < len) out.push(all[randomBytes(1)[0] % all.length])
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out.slice(0, len).join('')
}

/** Three-word passphrase style: "correct-horse-battery-7" (words from a small built-in list). */
const WORDS = (
  'apple river stone cloud maple tiger candle silver forest ocean summer winter garden window rocket planet copper velvet marble anchor ' +
  'harbor meadow falcon lantern orchid pepper saddle timber walnut yellow zephyr basket cactus dragon ember feather glacier hammer island jungle ' +
  'kettle ladder magnet needle oyster parrot quartz rabbit saffron thunder unicorn violet whisper yonder amber birch cedar delta ' +
  'eagle fjord granite helix ivory jasper kayak lotus mango nickel opal pixel quill ripple sable tulip umber vapor willow'
).split(' ')

export function generatePassphrase(words = 4): string {
  const n = Math.max(3, Math.min(8, words))
  const pick: string[] = []
  while (pick.length < n) pick.push(WORDS[randomBytes(1)[0] % WORDS.length])
  return `${pick.join('-')}-${randomBytes(1)[0] % 100}`
}

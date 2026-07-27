import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'

/**
 * Password-based, machine-independent encryption for the API-key vault so a
 * backup can carry keys to another computer. (The live vault uses Electron
 * safeStorage, which is bound to the OS user/machine and can't be moved.)
 *
 * Format: JSON { v, salt, iv, tag, ct } — all base64. scrypt-derived AES-256-GCM.
 * Pure Node crypto, no Electron, so it's unit-testable.
 */

const SCRYPT_N = 16384
const KEYLEN = 32

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(Buffer.from(password, 'utf8'), salt, KEYLEN, { N: SCRYPT_N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

/** Encrypt a UTF-8 string with a password; returns a portable JSON blob string. */
export function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(password, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return JSON.stringify({
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64')
  })
}

/** Decrypt a blob from encryptWithPassword. Returns null on wrong password / tamper. */
export function decryptWithPassword(blob: string, password: string): string | null {
  try {
    const o = JSON.parse(blob) as { v?: number; salt?: string; iv?: string; tag?: string; ct?: string }
    if (!o.salt || !o.iv || !o.tag || !o.ct) return null
    const key = deriveKey(password, Buffer.from(o.salt, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(o.tag, 'base64'))
    const pt = Buffer.concat([decipher.update(Buffer.from(o.ct, 'base64')), decipher.final()])
    return pt.toString('utf8')
  } catch {
    return null // wrong password, corrupt, or not our format
  }
}

/** Cheap sanity check that a string looks like one of our portable blobs. */
export function looksLikePortableBlob(s: string): boolean {
  try {
    const o = JSON.parse(s) as Record<string, unknown>
    return !!o && !!o.salt && !!o.iv && !!o.tag && !!o.ct
  } catch {
    return false
  }
}

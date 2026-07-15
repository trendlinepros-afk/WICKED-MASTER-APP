/**
 * Base32 / base64 helpers (renderer side).
 *
 * The base32 functions mirror the Python tool's behavior:
 * - encode: RFC 4648 alphabet, un-padded output (Account.secret_base32
 *   does `b32encode(...).rstrip("=")`).
 * - decode: case-insensitive, spaces and hyphens stripped, padding optional
 *   (totp._normalize_secret / migration._b32_to_bytes clean + re-pad before
 *   calling `base64.b32decode(..., casefold=True)`).
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32, upper-case, without `=` padding. */
export function b32encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** Decode base32; tolerates lower case, spaces, hyphens and missing padding. */
export function b32decode(text: string): Uint8Array {
  const cleaned = text
    .trim()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** Standard base64 -> bytes; whitespace stripped, missing padding restored. */
export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '')
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4)
  let bin: string
  try {
    bin = atob(padded)
  } catch {
    throw new Error('not valid base64 data')
  }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Bytes -> standard base64 (with padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * TOTP (RFC 6238) one-time codes for stored 2FA secrets (pure, main only).
 * Accepts a bare base32 setup key ("JBSW Y3DP EHPK 3PXP") or a full
 * otpauth://totp/... URI (secret, digits, period and algorithm are honoured).
 */
import { createHmac } from 'crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error(`Not a valid base32 secret (unexpected "${ch}")`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (!out.length) throw new Error('Empty secret')
  return Buffer.from(out)
}

export interface TotpParams {
  secret: string
  digits: number
  period: number
  algorithm: 'sha1' | 'sha256' | 'sha512'
  issuer: string
  account: string
}

export function parseTotp(raw: string): TotpParams {
  const s = raw.trim()
  const p: TotpParams = { secret: s, digits: 6, period: 30, algorithm: 'sha1', issuer: '', account: '' }
  if (/^otpauth:\/\//i.test(s)) {
    const u = new URL(s)
    if (u.host.toLowerCase() !== 'totp') throw new Error('Only otpauth://totp links are supported')
    const label = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const [a, b] = label.includes(':') ? label.split(':', 2) : ['', label]
    p.issuer = u.searchParams.get('issuer') ?? a
    p.account = b.trim()
    p.secret = u.searchParams.get('secret') ?? ''
    p.digits = Number(u.searchParams.get('digits') ?? 6) || 6
    p.period = Number(u.searchParams.get('period') ?? 30) || 30
    const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase().replace('-', '')
    p.algorithm = alg === 'sha256' ? 'sha256' : alg === 'sha512' ? 'sha512' : 'sha1'
  }
  if (!p.secret) throw new Error('The link has no secret')
  base32Decode(p.secret) // validate early
  return p
}

export function totpCode(params: TotpParams, now = Date.now()): { code: string; secondsLeft: number; period: number } {
  const key = base32Decode(params.secret)
  const counter = Math.floor(now / 1000 / params.period)
  const msg = Buffer.alloc(8)
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  msg.writeUInt32BE(counter >>> 0, 4)
  const h = createHmac(params.algorithm, key).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff)
  const code = String(bin % 10 ** params.digits).padStart(params.digits, '0')
  const secondsLeft = params.period - (Math.floor(now / 1000) % params.period)
  return { code, secondsLeft, period: params.period }
}

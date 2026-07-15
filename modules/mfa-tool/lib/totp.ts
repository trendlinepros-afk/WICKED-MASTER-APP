/**
 * TOTP code generation — the renderer-side port of totp.py, built on the
 * `otpauth` package (RFC 6238 verified by the self-test).
 *
 * Deviation from the Python tool: `otpauth` cannot generate MD5-based codes
 * (its dynamic truncation requires a >=19-byte MAC); such accounts are stored
 * fine but code generation throws — the UI shows "n/a" for them.
 */

import * as OTPAuth from 'otpauth'
import { b32decode } from './encoding'

export interface CodeParams {
  /** un-padded base32 secret */
  secret: string
  algorithm: string
  digits: number
  period: number
}

/** TOTP code for a vault account at `atMs` (defaults to now). */
export function generateCode(params: CodeParams, atMs: number = Date.now()): string {
  return generateCodeFromBytes(b32decode(params.secret), params, atMs)
}

/** TOTP code from raw key bytes (used by the RFC 6238 self-test seeds). */
export function generateCodeFromBytes(
  secret: Uint8Array,
  opts: { algorithm: string; digits: number; period: number },
  atMs: number = Date.now()
): string {
  // copy so the ArrayBuffer is exactly the key (no view offset/oversize)
  const key = new Uint8Array(secret)
  return OTPAuth.TOTP.generate({
    secret: new OTPAuth.Secret({ buffer: key.buffer }),
    algorithm: opts.algorithm,
    digits: opts.digits,
    period: opts.period,
    timestamp: atMs
  })
}

/** Seconds until the current TOTP window rolls over (totp.seconds_remaining). */
export function secondsRemaining(period: number, atMs: number = Date.now()): number {
  return period - ((atMs / 1000) % period)
}

/** "123456" -> "123 456" (the split-in-the-middle display the GUI used). */
export function formatCode(code: string): string {
  const mid = Math.floor(code.length / 2)
  return `${code.slice(0, mid)} ${code.slice(mid)}`
}

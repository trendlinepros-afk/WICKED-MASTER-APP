/**
 * Self-tests that prove the core works without needing a real export — the
 * port of selftest.py.
 *
 * 1. TOTP verified against the official RFC 6238 Appendix B test vectors.
 * 2. Migration pipeline round-trip: build a fake Google Authenticator export
 *    protobuf with an independent mini-encoder (ported from selftest.py),
 *    then parse the resulting URI and confirm secrets/codes survive intact.
 *    (Adapted: the Python test rendered + re-decoded an actual QR image; no
 *    QR *encoder* is available here, so the URI is parsed directly.)
 * 3. Encrypted vault round-trip via the main process (right & wrong password).
 */

import { b32decode, b32encode, bytesToBase64 } from './encoding'
import { accountLabel, accountsFromPayloads } from './migration'
import { generateCodeFromBytes } from './totp'

export interface SelfTestLine {
  status: 'ok' | 'fail' | 'info'
  text: string
}

export interface SelfTestReport {
  passed: boolean
  lines: SelfTestLine[]
}

/* --- RFC 6238 Appendix B test vectors (8-digit codes) --------------------- */
const enc = new TextEncoder()
const SEEDS = {
  SHA1: enc.encode('12345678901234567890'),
  SHA256: enc.encode('12345678901234567890123456789012'),
  SHA512: enc.encode('1234567890123456789012345678901234567890123456789012345678901234')
}

const RFC6238_VECTORS: Array<[number, keyof typeof SEEDS, string]> = [
  [59, 'SHA1', '94287082'],
  [59, 'SHA256', '46119246'],
  [59, 'SHA512', '90693936'],
  [1111111109, 'SHA1', '07081804'],
  [1111111111, 'SHA1', '14050471'],
  [1234567890, 'SHA1', '89005924'],
  [2000000000, 'SHA1', '69279037'],
  [20000000000, 'SHA1', '65353130']
]

function testRfc6238(lines: SelfTestLine[]): boolean {
  lines.push({ status: 'info', text: 'RFC 6238 test vectors:' })
  let ok = true
  for (const [at, algo, expected] of RFC6238_VECTORS) {
    const got = generateCodeFromBytes(SEEDS[algo], { algorithm: algo, digits: 8, period: 30 }, at * 1000)
    const pass = got === expected
    if (!pass) ok = false
    lines.push({
      status: pass ? 'ok' : 'fail',
      text: `t=${at} ${algo} -> ${got} (expected ${expected})`
    })
  }
  return ok
}

/* --- minimal protobuf *encoder*, used only to build a fake export ---------- */
function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return out
}

function lenField(fieldNo: number, data: ArrayLike<number>): number[] {
  return [...varint((fieldNo << 3) | 2), ...varint(data.length), ...Array.from(data)]
}

function varintField(fieldNo: number, value: number): number[] {
  return [...varint(fieldNo << 3), ...varint(value)]
}

function buildMigrationUri(accounts: Array<{ secret: Uint8Array; name: string; issuer: string }>): string {
  const payload: number[] = []
  for (const acc of accounts) {
    const otp = [
      ...lenField(1, acc.secret),
      ...lenField(2, enc.encode(acc.name)),
      ...lenField(3, enc.encode(acc.issuer)),
      ...varintField(4, 1), // algorithm = SHA1
      ...varintField(5, 1), // digits = SIX
      ...varintField(6, 2) // type = TOTP
    ]
    payload.push(...lenField(1, otp))
  }
  payload.push(...varintField(2, 1)) // version
  payload.push(...varintField(3, 1)) // batch_size
  payload.push(...varintField(4, 0)) // batch_index
  payload.push(...varintField(5, 0)) // batch_id
  const data = bytesToBase64(Uint8Array.from(payload))
  return 'otpauth-migration://offline?data=' + encodeURIComponent(data)
}

function testMigrationRoundTrip(lines: SelfTestLine[]): boolean {
  lines.push({ status: 'info', text: 'Migration round-trip (build export -> parse URI):' })
  const fake = [
    { secret: SEEDS.SHA1, name: 'alice@example.com', issuer: 'GitHub' },
    { secret: b32decode('JBSWY3DPEHPK3PXP'), name: 'bob', issuer: 'AWS' }
  ]
  const uri = buildMigrationUri(fake)

  let ok = true
  try {
    const { accounts, problems } = accountsFromPayloads([uri])
    for (const p of problems) {
      ok = false
      lines.push({ status: 'fail', text: p })
    }
    if (accounts.length !== fake.length) {
      lines.push({
        status: 'fail',
        text: `expected ${fake.length} accounts, decoded ${accounts.length}`
      })
      return false
    }
    for (let i = 0; i < fake.length; i++) {
      const expected = fake[i]
      const got = accounts[i]
      const secretOk = got.secret === b32encode(expected.secret)
      const metaOk = got.name === expected.name && got.issuer === expected.issuer
      const opts = { algorithm: 'SHA1', digits: 6, period: 30 }
      const code = generateCodeFromBytes(b32decode(got.secret), opts, 59 * 1000)
      const ref = generateCodeFromBytes(expected.secret, opts, 59 * 1000)
      const pass = secretOk && metaOk && code === ref
      if (!pass) ok = false
      lines.push({
        status: pass ? 'ok' : 'fail',
        text: `${accountLabel(got)} secret=${secretOk ? 'match' : 'MISMATCH'} code@t59=${code}`
      })
    }
  } catch (err) {
    ok = false
    lines.push({ status: 'fail', text: err instanceof Error ? err.message : String(err) })
  }
  return ok
}

interface VaultSelfTestResult {
  ok: boolean
  lines: Array<{ ok: boolean; text: string }>
}

async function testVaultRoundTrip(lines: SelfTestLine[]): Promise<boolean> {
  lines.push({ status: 'info', text: 'Encrypted vault (save -> load, right & wrong password):' })
  try {
    const res = (await window.wicked.invoke('mfa-tool:self-test-vault')) as VaultSelfTestResult
    for (const l of res.lines) lines.push({ status: l.ok ? 'ok' : 'fail', text: l.text })
    return res.ok
  } catch (err) {
    lines.push({
      status: 'fail',
      text: `vault self-test failed: ${err instanceof Error ? err.message : String(err)}`
    })
    return false
  }
}

export async function runSelfTest(): Promise<SelfTestReport> {
  const lines: SelfTestLine[] = []
  const a = testRfc6238(lines)
  const b = testMigrationRoundTrip(lines)
  const c = await testVaultRoundTrip(lines)
  const passed = a && b && c
  lines.push({ status: 'info', text: passed ? 'All self-tests PASSED.' : 'Self-tests FAILED.' })
  return { passed, lines }
}

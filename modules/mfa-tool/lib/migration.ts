/**
 * Parse Google Authenticator exports (`otpauth-migration://offline?data=...`)
 * and standard `otpauth://` URIs — the port of migration.py + importer.py.
 *
 * The protobuf schema replicates exactly what protobuf_reader.py/migration.py
 * read off the wire:
 *
 *   MigrationPayload:
 *     1  repeated OtpParameters otp_parameters
 *     2  int32 version
 *     3  int32 batch_size
 *     4  int32 batch_index
 *     5  int32 batch_id
 *   OtpParameters:
 *     1  bytes  secret        4  int32 algorithm (enum)
 *     2  string name          5  int32 digits    (enum)
 *     3  string issuer        6  int32 type      (enum)
 *                             7  uint64 counter  (HOTP only)
 */

import { Field, Root, Type } from 'protobufjs'
import { b32decode, b32encode, base64ToBytes } from './encoding'

/**
 * One vault entry. Field names and value shapes mirror migration.py's
 * `Account.to_dict()` — this is exactly what gets stored in the encrypted
 * vault, so it stays byte-compatible with the Python tool.
 * (Kept in sync with the duplicate `VaultAccount` in ../ipc.ts.)
 */
export interface VaultAccount {
  name: string
  issuer: string
  /** un-padded base32 (`Account.secret_base32`) */
  secret: string
  algorithm: string
  digits: number
  type: 'totp' | 'hotp'
  counter: number
  period: number
}

/** `"Issuer: name"` or just `name` (Account.label). */
export function accountLabel(a: Pick<VaultAccount, 'issuer' | 'name'>): string {
  return a.issuer ? `${a.issuer}: ${a.name}` : a.name
}

/* --- MigrationPayload enum mappings — identical to migration.py --- */
const ALGORITHM: Record<number, string> = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' }
const DIGITS: Record<number, number> = { 0: 6, 1: 6, 2: 8 }
const OTP_TYPE: Record<number, 'totp' | 'hotp'> = { 0: 'totp', 1: 'hotp', 2: 'totp' }

/* --- protobufjs reflection schema (no .proto file needed) --- */
const OtpParameters = new Type('OtpParameters')
  .add(new Field('secret', 1, 'bytes'))
  .add(new Field('name', 2, 'string'))
  .add(new Field('issuer', 3, 'string'))
  .add(new Field('algorithm', 4, 'int32'))
  .add(new Field('digits', 5, 'int32'))
  .add(new Field('type', 6, 'int32'))
  .add(new Field('counter', 7, 'uint64'))

const MigrationPayload = new Type('MigrationPayload')
  .add(new Field('otpParameters', 1, 'OtpParameters', 'repeated'))
  .add(new Field('version', 2, 'int32'))
  .add(new Field('batchSize', 3, 'int32'))
  .add(new Field('batchIndex', 4, 'int32'))
  .add(new Field('batchId', 5, 'int32'))

new Root().define('gaexport').add(OtpParameters).add(MigrationPayload)

interface RawOtpParameters {
  secret?: Uint8Array
  name?: string
  issuer?: string
  algorithm?: number
  digits?: number
  type?: number
  counter?: number
}

/** Parse an `otpauth-migration://` URI into a list of accounts. */
export function parseMigrationUri(uri: string): VaultAccount[] {
  const url = new URL(uri)
  if (url.protocol !== 'otpauth-migration:') {
    throw new Error(`not an otpauth-migration URI: ${url.protocol}`)
  }
  const data = url.searchParams.get('data')
  if (!data) throw new Error("migration URI is missing the 'data' parameter")
  // URLSearchParams decodes '+' to ' '; a literal '+' in un-escaped base64
  // can only have been that, so put it back (more forgiving than Python).
  const raw = base64ToBytes(data.replace(/ /g, '+'))
  const message = MigrationPayload.decode(raw)
  const obj = MigrationPayload.toObject(message, { longs: Number, defaults: true }) as {
    otpParameters?: RawOtpParameters[]
  }
  return (obj.otpParameters ?? []).map(otpParametersToAccount)
}

function otpParametersToAccount(p: RawOtpParameters): VaultAccount {
  return {
    name: p.name ?? '',
    issuer: p.issuer ?? '',
    secret: b32encode(p.secret ?? new Uint8Array(0)),
    algorithm: ALGORITHM[p.algorithm ?? 0] ?? 'SHA1',
    digits: DIGITS[p.digits ?? 0] ?? 6,
    type: OTP_TYPE[p.type ?? 0] ?? 'totp',
    counter: p.counter ?? 0,
    period: 30 // GA exports are always 30 s (Account default; migration.py never sets it)
  }
}

/** Parse a single-account `otpauth://totp/...` (or hotp) URI. */
export function parseOtpauthUri(uri: string): VaultAccount {
  const url = new URL(uri)
  if (url.protocol !== 'otpauth:') throw new Error(`not an otpauth URI: ${url.protocol}`)

  const otpType = (url.hostname || 'totp').toLowerCase()
  const rawLabel = url.pathname.replace(/^\//, '')
  let label: string
  try {
    label = decodeURIComponent(rawLabel)
  } catch {
    label = rawLabel
  }

  // label.partition(":") — "Issuer:Account", or the whole label is the name
  const sep = label.indexOf(':')
  let issuer = sep === -1 ? label : label.slice(0, sep)
  let name = sep === -1 ? '' : label.slice(sep + 1)
  if (!name) {
    name = issuer
    issuer = ''
  }
  issuer = issuer.trim()
  name = name.trim()

  const q = url.searchParams
  const qIssuer = q.get('issuer')
  if (qIssuer) issuer = qIssuer

  return {
    name,
    issuer,
    secret: b32encode(b32decode(q.get('secret') ?? '')),
    algorithm: (q.get('algorithm') ?? 'SHA1').toUpperCase(),
    digits: intParam(q.get('digits'), 6),
    type: otpType === 'hotp' ? 'hotp' : 'totp',
    counter: intParam(q.get('counter'), 0),
    period: intParam(q.get('period'), 30)
  }
}

function intParam(v: string | null, fallback: number): number {
  if (v === null || v.trim() === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`invalid number in otpauth URI: ${v}`)
  return Math.trunc(n)
}

export interface ImportOutcome {
  accounts: VaultAccount[]
  problems: string[]
}

/**
 * importer.accounts_from_payloads: parse decoded QR/pasted payloads into
 * accounts, de-duplicating on (issuer, name, secret). Unlike the Python
 * version (which silently skips non-OTP payloads and raises on the first
 * malformed URI), problems are collected and reported per payload.
 */
export function accountsFromPayloads(payloads: string[]): ImportOutcome {
  const accounts: VaultAccount[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  const add = (acc: VaultAccount): void => {
    const key = dedupeKey(acc)
    if (!seen.has(key)) {
      seen.add(key)
      accounts.push(acc)
    }
  }

  for (const payload of payloads) {
    try {
      if (payload.startsWith('otpauth-migration://')) {
        for (const acc of parseMigrationUri(payload)) add(acc)
      } else if (payload.startsWith('otpauth://')) {
        add(parseOtpauthUri(payload))
      } else {
        problems.push(`ignored (not an otpauth/otpauth-migration URI): ${truncate(payload)}`)
      }
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err))
    }
  }
  return { accounts, problems }
}

function truncate(text: string): string {
  return text.length > 60 ? text.slice(0, 57) + '…' : text
}

/** De-duplication identity — the `(issuer, name, secret)` tuple the Python tool used. */
export function dedupeKey(a: Pick<VaultAccount, 'issuer' | 'name' | 'secret'>): string {
  return [a.issuer, a.name, a.secret].join('\u0000')
}

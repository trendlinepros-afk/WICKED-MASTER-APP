# MFA Tool (Beta)

Port of the standalone Python "MFA Tool" (`X:\Coding\_Active Projects\MFA Tool`) —
a TOTP authenticator with an encrypted account vault and Google Authenticator
export import. **Status: beta** — the original was considered unfinished; the
port carries its behavior (and quirks) over rather than redesigning it.

## What it does

- **Account vault** — TOTP accounts (issuer, name, base32 secret, 6/8 digits,
  SHA1/SHA256/SHA512, custom period) with live codes, a countdown ring
  (turns red at ≤5 s, like the original), and click-to-copy.
- **Add accounts** — manual entry, pasted `otpauth://` / `otpauth-migration://`
  URIs, or QR image files (decoded in the renderer with `jsqr`).
- **Google Authenticator export import** — `otpauth-migration://offline?data=…`
  payloads are base64-decoded and parsed with `protobufjs` using the exact
  field schema from `protobuf_reader.py`/`migration.py`:
  `otp_parameters` (field 1, repeated) with `secret`(1, bytes), `name`(2),
  `issuer`(3), `algorithm`(4, enum `{0,1:SHA1, 2:SHA256, 3:SHA512, 4:MD5}`),
  `digits`(5, enum `{0,1:6, 2:8}`), `type`(6, enum `{0,2:totp, 1:hotp}`),
  `counter`(7). Duplicates are dropped on the `(issuer, name, secret)` tuple.
- **Encrypted persistence** — passphrase-locked vault; create-vault flow on
  first run, unlock on later runs, Lock button while unlocked.
- **Self-test** — "Run self-test" in the footer executes the ported
  `selftest.py`: RFC 6238 Appendix B vectors, a migration-payload round-trip,
  and an encrypted-vault round-trip (right + wrong password) in the main
  process.

## Vault format — compatible with the Python tool

`ipc.ts` replicates `vault.py` exactly (Node `crypto`: `scryptSync` +
`createCipheriv('aes-256-gcm')`):

```json
{
  "version": 1,
  "kdf": "scrypt",
  "kdf_params": { "n": 16384, "r": 8, "p": 1 },
  "cipher": "AES-256-GCM",
  "salt": "<base64, 16 bytes>",
  "nonce": "<base64, 12 bytes>",
  "ciphertext": "<base64, ciphertext + 16-byte GCM tag appended>"
}
```

- Key: scrypt(password UTF-8, salt, N=2^14, r=8, p=1) → 32 bytes.
- Plaintext: UTF-8 JSON `{"accounts": [...]}` where each account is
  `{name, issuer, secret (un-padded base32), algorithm, digits, type, counter, period}`
  (`Account.to_dict()` verbatim).
- Written atomically (`.tmp` + rename), like `os.replace`.
- A wrong passphrase fails GCM authentication and is reported as
  "Wrong password. Try again." (`InvalidPassword` equivalent).

Vault files are interchangeable in **both directions** with the Python tool.

- **Location:** `<userData>/modules/mfa-tool/vault.json` (module contract),
  **not** the original's `%APPDATA%\MFA Tool\vault.json`.
- **Legacy import:** if no module vault exists but the Python tool's vault is
  found at its default path, the create screen offers to unlock it and adopt
  it — the file is copied verbatim after the passphrase is verified.

## IPC channels

| Channel | Purpose |
| --- | --- |
| `mfa-tool:status` | vault/legacy-vault existence + paths |
| `mfa-tool:create` | create an empty vault (refuses to overwrite) |
| `mfa-tool:unlock` | decrypt and return accounts |
| `mfa-tool:save` | re-encrypt and write the account list |
| `mfa-tool:import-legacy` | verify + adopt the Python tool's vault file |
| `mfa-tool:self-test-vault` | temp-file save/load round-trip for the self-test |

TOTP generation, URI/protobuf parsing, and QR decoding all run in the
**renderer** (`otpauth`, `protobufjs`, `jsqr`); only vault encryption/file I/O
is in the main process.

## Deviations from the Python tool

- **QR decoding:** `jsqr` finds at most **one** QR code per image (pyzbar/
  OpenCV could return several). Import one image per code.
- **MD5 accounts:** `otpauth` cannot generate MD5-HMAC codes; such accounts
  (GA algorithm enum 4) import and store fine but show "n/a". (The Python
  tool's MD5 support was itself unreliable — a 16-byte MAC can crash RFC 4226
  truncation.)
- **HOTP quirk carried over:** like `gui.py`, the list renders time-based
  codes even for `hotp` entries (counter is preserved in the vault, never
  incremented). Rows show an "hotp" badge so this is at least visible.
- **Migration self-test** parses the constructed export URI directly instead
  of rendering + re-decoding a QR image (no QR *encoder* dependency here).
- **Base32 input** is slightly laxer: spaces *and* hyphens stripped, padding
  optional, case-insensitive (superset of the Python cleaning rules).
- **Migration URI leniency:** literal `+` in an un-escaped `data=` query value
  is restored after URL decoding (Python's `parse_qs` + `b64decode` silently
  corrupts that case).
- Import problems are collected and listed per payload instead of aborting on
  the first malformed URI.
- The vault stays unlocked while the shell runs (also when navigating to
  another module) until Lock is pressed — same lifetime as the original app's
  in-memory password, since the module keeps running.

## Known gaps (why still beta)

- No account editing or reordering; remove + re-add instead.
- No export (QR or otherwise), no passphrase change — take the vault file.
- No proper HOTP counter handling (see quirk above).
- No auto-lock timeout.

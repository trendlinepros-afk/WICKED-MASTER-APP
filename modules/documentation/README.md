# Documentation

Single-site IT documentation in the shape of **IT Glue** — one organisation,
no tenants. Left sidebar → **Core assets** (Configurations, Contacts,
Documents, Domains, Locations, Passwords, SSL Certificates), **Apps & services**
(Active Directory, Applications, Backup, Email, File Sharing, Internet / WAN,
LAN, Printing, Remote Access, Virtualization, Voice / PBX, Wireless) and
**Administration** (Licensing, Vendors) — with record counts beside each item,
plus Overview, Expirations, Favorites, Recent activity, Archived and Settings.
The whole tool sits behind a password.

## The lock

- **First open** asks you to set a password (minimum 4 characters, so a 4-digit
  PIN is allowed; the screen shows a strength meter and says plainly that a
  longer passphrase is safer). After that the tool asks for it on every open and
  **auto-locks** after 15 minutes without a click or keystroke (Settings →
  Security: 1 min … never), and always on app restart.
- `ipc/vault.ts`: setup generates a random 256-bit master key and wraps it with
  a key derived from the password (scrypt N=2¹⁶, ~0.3–0.5 s) using AES-256-GCM;
  only `vault.json` (salt + wrapped key) is written. Unlock = derive + unwrap
  (GCM rejects a wrong password). Wrong attempts back off — 5 s after the 3rd,
  doubling to 5 min — and the counter persists across restarts.
- **Secret fields** (`password` and `totp` kinds: passwords, Wi-Fi passphrases,
  licence keys, 2FA seeds) are encrypted per value with the master key. Every
  other field is plain SQLite so the tool stays searchable. Secrets reach the
  renderer only via **Reveal** / **Copy** (main writes the clipboard and clears
  it after 45 s if it still holds the secret), and each reveal/copy is written
  to the activity log.
- **Deliberately not PC-bound** (no DPAPI): a WICKED backup restored on another
  machine unlocks with the same password. The trade-off — someone who copies
  `vault.json` + `docs.db` can try passwords offline (~0.5 s each; 10,000 PINs
  ≈ 1.5 h, a passphrase effectively never). The setup and Security screens say
  so. There is no reset: without the password the secret fields are gone;
  everything else is still readable.

## Records, asset types, relations

- Every sidebar item is an **asset type** (`lib/schema.ts`): a name label plus
  a list of typed fields — text, multi-line, Markdown, number, date (optionally
  an *expiry*), dropdown, checkbox, URL, email, phone, IP, password, TOTP
  secret, or a *relation* (multi-select of another type's records). Fields
  marked *list* become table columns. Built-in types are seeded into the DB on
  first run; **Settings → Asset types** lets you relabel/reorder/add fields on
  built-ins (built-in fields can't be removed) and design entirely new types —
  IT Glue's flexible assets.
- Records of all types share one table (`ipc/db.ts`): name, JSON fields, tags,
  folder (Documents), favorite, archived. **Related items** = explicit links
  (any record ↔ any record) plus everything whose relation fields point at this
  record ("referenced by"). **Attachments** are copied into
  `modules/documentation/attachments/<record>/`. Every record has its own
  history; Recent activity shows everything (last 5,000 events).
- **Documents** are Markdown with a Write/Preview editor and folders;
  links open in the system browser (`open-url`, http(s) only).
- **Passwords**: generator (length/symbols, or a passphrase), TOTP with the
  rolling 6-digit code and countdown (`ipc/totp.ts`, RFC 6238; accepts a base32
  key or an `otpauth://` link), "Used on" links to Configurations.
- **Domain tracker**: *Check now* runs an RDAP lookup (the registries' JSON
  WHOIS via rdap.org — no key) for registrar / expiry / status / name servers
  and reads live **A / AAAA / CNAME / MX / NS / TXT** records with hints such as
  "Mail: Microsoft 365", "DNS: Cloudflare". Registrar and expiry are written
  back to the record (`ipc/lookups.ts`).
- **SSL tracker**: *Check now* connects to host:port, records issuer, expiry,
  SANs, and whether the chain is trusted and the name matches; expiry/issuer
  are written back.
- **Expirations**: any date field flagged as an expiry (domain, SSL, licence
  renewals, warranty, ISP/vendor contract) — sidebar badge for the next 30 days,
  the Expirations view for longer windows.
- **Export** (Settings → Export): one JSON with types, records and relations;
  secrets omitted unless you tick the box (then they're plain text — the file
  is on you).

## MCP

`documentation__status`, `__types`, `__list`, `__get`, `__search`,
`__expirations`, `__create`, `__update` (confirm-gated), `__delete`
(confirm-gated), `__lookup-domain`, `__lookup-ssl`. All need the vault
unlocked in the app and **none can reveal a secret** — secret fields come back
as `{__secret:true, set:bool}` placeholders, same as the UI.

## Files

`%APPDATA%/WICKED-Suite/modules/documentation/`: `docs.db` (SQLite, WAL;
checkpointed before Backup/Cloud Sync), `vault.json`, `attachments/`. Settings
(auto-lock, hidden sidebar types, clipboard timer) live in the shell store.
`ipc/vault.ts`, `ipc/totp.ts`, `ipc/lookups.ts` and `lib/schema.ts` have no
Electron imports and are covered by headless tests.

# File Vault

Personal cloud file storage on **your own Google Drive** — built for installers,
executables and other big files. Everything lives under one Drive folder
(**"WICKED Vault"** at the root of My Drive), so it's also visible on
drive.google.com, your phone, and any other PC.

**Folders are supported** — the vault is browsable, not flat. Upload a whole
folder (button or drag-drop) and its structure is mirrored into Drive
(sub-folders created, empty ones kept); click a folder to open it, with a
breadcrumb back to the root. Sub-folders you create directly in Drive show up in
the app too. Uploads land in the folder you're currently viewing.

**Why Drive:** the Drive API has no usage billing (only rate quotas a personal
vault never approaches) and the user already pays for TBs of Business storage —
so this module costs $0 on top. R2/B2 free tiers are 10 GB; GitHub is a public
repo. There is **no per-file size limit** in the module — Drive itself caps a
single file at 5 TB.

## One-time setup (user does this once, ~10 min, free)

The module walks the user through it in-app: create a Google Cloud project →
enable the **Drive API** → OAuth consent screen set to **Internal** (Workspace
accounts only — skips Google verification and gives non-expiring refresh
tokens) → create a **Desktop app** OAuth client → paste the Client ID + Secret
into WICKED → Connect (browser sign-in).

## How it works

- **OAuth**: loopback flow (one-shot `127.0.0.1` HTTP server on a random port)
  with PKCE + state, `prompt=consent` + `access_type=offline` for a refresh
  token. Full `drive` scope so files dropped into the vault folder from
  outside WICKED still show up (with `drive.file` they wouldn't).
- **Secrets**: client id is plaintext (public by design for installed apps);
  client secret + refresh token are `safeStorage` (DPAPI) encrypted in
  `modules/file-vault/auth.json`, which is **excluded from Backup & Cloud Sync**
  (`backup-core.ts` EXCLUDE_RELPATHS) — DPAPI blobs are useless on another
  machine anyway; the user just reconnects there. Nothing secret is ever sent
  to the renderer.
- **Uploads**: chunked **resumable** uploads (16 MB chunks), exponential-backoff
  retries with a `bytes */total` offset probe, session restart on expiry.
  A same-named vault file (same name in the same folder) is **replaced in place**
  (Drive keeps the previous version ~30 days) instead of creating "name (1)"
  duplicates.
- **Folder uploads**: a dropped/picked folder is walked recursively in main;
  each sub-folder is created with `findOrCreateSubfolder` (existing ones reused)
  and every file is queued into its matching Drive folder, so the tree is
  preserved (empty folders included). Windows can't combine file+folder in one
  native dialog, hence the separate **Upload folder** button; drag-drop handles
  both at once. Each queued transfer carries its target `folderId`.
- **Downloads**: streamed to a `.wkdownload` temp file with Range-resume across
  retries, renamed into place only after verification. Drive's "abusive file"
  gate on executables is acknowledged automatically (owner's own file).
- **Verification**: every completed transfer's **MD5 is compared with Drive's
  server-side checksum** — a mismatch is a hard error, which matters when the
  files are executables that will be run.
- **Queue**: 2 concurrent transfers in the main process; progress is pushed to
  the renderer over `file-vault:transfers-changed` (throttled ~4/s).
  Drag-and-drop uses `window.wicked.getPathForFile` (Electron killed
  `File.path`).
- **Delete = Drive trash** (recoverable ~30 days). Never a hard delete.

## Quirks

- The vault ROOT folder id is cached in the shared store; if the user deletes it
  in Drive, a 404 triggers re-create + retry automatically. A 404 on a *sub*-folder
  (genuinely deleted) surfaces as an error rather than silently recreating.
- Listing returns folders too (folders first, then files, each A→Z); navigating
  passes the current folder id to `list`, and stale responses after a fast
  navigation are dropped.
- Google-native docs (Docs/Sheets) in the folder list with size 0 and no MD5 —
  they can't be meaningfully stored/verified here, but they're shown.
- If Google doesn't return a refresh token (re-consent on an already-authorized
  client without `prompt=consent` honoring), the error tells the user to remove
  WICKED's access in their Google account and reconnect.
- On `invalid_grant` (revoked/expired), tokens are wiped and the UI drops back
  to the Connect screen with a clear message.

## MCP

`file-vault__status`, `file-vault__list`, `file-vault__upload` (destructive —
replaces same-named vault files; confirm-gated), `file-vault__download` (never
overwrites local files), `file-vault__transfers`, `file-vault__delete`
(destructive; confirm-gated; goes to Drive trash). All delegate to the same IPC
handlers the UI calls.

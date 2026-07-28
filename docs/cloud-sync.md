# Cloud Sync (private GitHub repo)

Keep every device you use WICKED on in sync through one **private** GitHub repo.
It's in **Settings → Cloud Sync**.

## How it works

- A **snapshot** is the same whole-app bundle the Backup feature makes: your
  settings, every module's data (Trade Journal, Project Board, email rules, AI
  Chat, …) and your API keys.
- The snapshot is **encrypted with your passphrase before it leaves the PC**
  (scrypt + AES-256-GCM). Only two files ever land in the repo:
  `wicked-sync.enc` (the opaque ciphertext) and `wicked-sync-manifest.json` (a
  tiny plaintext note: version, time, device name — no secrets).
- **A leaked token, a repo breach, or an accidental public-flip only ever exposes
  ciphertext.** The passphrase is never uploaded.
- Model: your **main PC auto-pushes** on a timer (and optionally on close); other
  devices **Pull from cloud** on demand. It's whole-snapshot **last-writer-wins**
  with a version + device stamp, so a pull warns you before it would overwrite
  newer local work. (It is not a real-time multi-writer merge — edit on one
  device at a time.)

## One-time setup (5 minutes)

1. **Create a private repo** on GitHub, e.g. `yourname/wicked-sync`. Empty is
   fine — no need to add a README.
2. **Make a fine-grained token**: GitHub → Settings → Developer settings →
   *Fine-grained personal access tokens* → *Generate new token*.
   - **Repository access:** *Only select repositories* → your sync repo.
   - **Permissions → Repository permissions → Contents: Read and write.**
   - Copy the token (starts with `github_pat_…`).
3. In WICKED → **Settings → Cloud Sync**:
   - **Repo:** `yourname/wicked-sync` · **Branch:** `main`.
   - **GitHub token:** paste the token.
   - **Sync passphrase:** choose a strong passphrase. **Use the same one on every
     device** — it's what decrypts your data (and API keys) elsewhere. *There is
     no recovery if you forget it.*
   - Name this device (e.g. `Desktop`), click **Save**, then **Test connection**.
4. On your **main PC**, turn on **Auto-push** (every 30 min by default) and, if
   you like, **Sync app on close**. Click **Sync now (push)** once to seed the
   repo.

## On another PC

1. Install WICKED, open **Settings → Cloud Sync**.
2. Enter the **same repo, token and passphrase**, click **Save**.
3. Click **Pull from cloud** → it downloads, decrypts, and restarts with your
   full config — API keys and all. (Leave Auto-push **off** here so this device
   can't overwrite your main PC's newer data; just Pull when you sit down.)

## App Lock (optional, separate)

**Settings → App Lock** sets a PIN that's required to open WICKED on *this*
device. It's a convenience gate on top of the running app and is stored only as a
salted hash — it never syncs. The real protection for your synced data is the
sync passphrase (which encrypts everything before upload); the PIN does not
encrypt local data at rest.

## Notes & limits

- Everything sync-related (repo, token, passphrase, device state, the PIN) is
  **device-local** and is deliberately excluded from the snapshot, so pulling on
  another machine never stomps that machine's own credentials or identity.
- Snapshots use GitHub's Git Data API, so large data (up to ~100 MB) uploads
  fine. The full Chrome profile from the Web Browser module is excluded (huge and
  Chrome-owned).
- The token and passphrase are stored with OS encryption (Windows DPAPI via
  Electron safeStorage), so they can't be lifted off disk as plaintext.

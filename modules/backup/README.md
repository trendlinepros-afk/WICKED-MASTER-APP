# Backup

File & folder backups in the style of Acronis True Image: create plans, run them
on demand or on a schedule, pick **full** or **incremental**, store them on a
local/USB drive or a **network share**, keep an optional **offsite copy in Google
Drive**, and **browse any version and restore** single files, folders or
everything. (No disk images — file & folder only, by design.)

## Using it

1. **New backup** → choose folders/files (buttons or drag-drop), exclusions,
   the destination (`D:\Backups`, `E:\`, `\\nas\backups\PC1`), the scheme,
   a schedule and cleanup rules.
2. **Back up now** (or the ▾ menu → *Run a full backup now* / *Upload to Google
   Drive now*). Progress, speed and ETA show live; jobs queue one at a time.
3. **Browse & restore**: pick a version on the left, navigate or search
   (`*.xlsx` wildcards work), tick files/folders, **Restore…** → original
   location or another folder, with an overwrite policy (only-if-older /
   always / skip). The clock icon on a file shows every distinct copy of it
   across versions with a one-click restore.
4. **Activity** lists every backup/restore/validation with the files that
   couldn't be read.

## Schemes

- **Full** — every run copies everything. Each version stands alone.
- **Incremental** — the first run is full; later runs copy only files whose
  size or modified time changed, and reference the older copies for the rest.
  *"Start a new full backup after every N incrementals"* (default 6, 0 = never)
  begins a new **chain** — the same knob Acronis has.

**Cleanup** runs after each successful backup: keep the last N (versions in
full mode, chains in incremental mode) or delete ones older than N days.
Chains are removed whole — an incremental is useless without its full — and
the newest chain is never deleted. Individual versions can also be deleted from
the Browse view (dependents are deleted with them, and the dialog says so).

## Storage format

```
<destination>\WICKED Backup\<plan name> [<id>]\
  plan.json                           plan snapshot (for "Open existing backup")
  versions\2026-09-25_210000_full\
    info.json                         summary
    manifest.json.gz                  every file: size, mtime, SHA-256, which version holds it
    data\C\Users\me\Documents\...     plain copies of the files stored in this version
  versions\2026-09-26_210000_inc\...  only the changed files
```

Files are stored as **plain copies** (mtime preserved) — no proprietary archive —
so a backup is readable with Explorer even without WICKED. Versions are written
to `versions\.<id>.partial` and renamed only when complete, so a crash/cancel
never leaves a half version that looks real (leftovers are cleaned next run).
A `.lock` file stops two PCs writing the same plan folder at once.

Every copied file is SHA-256 hashed while copying. *Validate each backup after
it's created* (default on) re-reads what was written; **Validate** on a version
re-checks every file it depends on. Restores verify each file against its
checksum before replacing anything (written to `*.wkrestore`, then renamed).

**Locked files** (e.g. an open Outlook PST): in an incremental chain the
previous good copy is kept and the run reports a warning; in a full backup
the file is listed as skipped. The Windows registry hives (`NTUSER.DAT` …) and
the profile Temp folder are excluded by default. Junctions/symlinks are not
followed (AppData contains self-referencing ones); OneDrive placeholder files
*are* backed up (Windows downloads them on read).

## Network shares

Enter a UNC path. If the share needs a login, fill **User name / Password** in
the destination section and click **Test**. The login uses `WNetAddConnection2`
(the API behind `net use`) via a short-lived PowerShell with the password passed
on **stdin**, never on a command line. The password is `safeStorage` (DPAPI)
encrypted in `modules/backup/credentials.json` — never sent to the renderer and
excluded from WICKED Backup/Cloud Sync (`backup-core.ts` EXCLUDE_RELPATHS).

## Google Drive copy

Reuses **File Vault's** Drive connection (connect there first). After a backup
finishes, each version not yet in Drive is uploaded to
`My Drive/WICKED Backups/<plan folder>/` as:

- `<version>.p001.wkpack …` — the version's new file bytes concatenated in
  storePath order, split into ≤1 GiB parts (resumable uploads, each part
  MD5-verified against Drive's checksum; completed parts are skipped on retry,
  so a big first backup survives restarts and Drive's 750 GB/day upload cap);
- `<version>.manifest.json.gz`, then `<version>.info.json` (written last = complete).

Packs instead of per-file mirroring because Drive sustains only a few file
creations per second — 100k small files would take many hours. Single files
still restore cheaply: the manifest gives each file's offset, and restores use
HTTP **Range** reads (neighbouring files coalesced), retrying from the file
they were in the middle of. If the backup location is offline, Browse lists the
Drive versions and restores come from Drive automatically.

Cleanup and deletes move the matching Drive files to the **Drive trash**
(recoverable ~30 days). Drive deletions happen only through cleanup/delete —
never by "mirroring" an empty or wiped destination — so a lost NAS can't take
the offsite copy with it.

## Schedules

The scheduler ticks every 30 s **while WICKED is running** (there is no Windows
service). Plans can *run missed backups ~1 minute after WICKED starts*, and the
sidebar has **Start WICKED with Windows** (`app.setLoginItemSettings`). Hourly,
daily, weekly (chosen days) and monthly (day clamped to month length) are
supported. The PC is kept awake (`powerSaveBlocker`) while a job runs, and a
Windows notification appears if a scheduled run fails or has warnings.

Plans record the computer they were made on. If `plans.json` reaches another PC
(Cloud Sync), the plan shows there with its schedule paused — browse/restore
work, and **Run it from this PC instead** takes it over. **Open existing
backup…** adopts plans found at a destination (e.g. on a new PC after a
disaster).

## MCP tools

`backup__list-plans`, `backup__status`, `backup__run`, `backup__cancel`,
`backup__history`, `backup__list-versions`, `backup__browse`, `backup__search`,
`backup__validate`, and `backup__restore` (**destructive** — gated by
`confirm: true`). All delegate to the same IPC channels as the UI.

## Files

- `modules/backup/plans.json`, `history.json` (last 300 jobs) and
  `credentials.json` (encrypted) under `%APPDATA%/WICKED-Suite/modules/backup/`.
- Engine (`ipc/engine.ts`) and Drive replica (`ipc/cloud.ts`) have no Electron
  imports so they can be exercised headless.

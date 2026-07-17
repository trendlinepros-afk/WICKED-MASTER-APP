# 365 Email Cleanup

A **fully in-app** WICKED module (v2.0.0) — everything runs inside the WICKED
window. It is a from-scratch reimplementation of the standalone "Inbox Cleanup"
C#/.NET 8 WPF app; **nothing external is launched** and there is **no licensing /
activation gate** (the original's Ed25519 signed-license, EULA and activation
windows were deliberately omitted).

## How it works

- **Outlook automation via PowerShell.** Instead of C# COM interop, every Outlook
  action spawns `powershell.exe` from the Node main process (see `ipc.ts`), which
  drives **classic Outlook desktop** through
  `New-Object -ComObject Outlook.Application` and returns a single JSON blob —
  the same pattern the `event-viewer` module uses. It **attaches to the running
  (or a new) Outlook session under the current user**, never calls `Application.Quit`,
  and never runs elevated.
- **Requires classic Outlook.** The "new Outlook" app and webmail do **not** expose
  MAPI/COM, so they are unsupported. If Outlook COM isn't available the module says
  so clearly instead of failing silently.
- **Pure routing logic** (junk-signal rules, sender/domain/subject routing, plan
  building) is ported to TypeScript in `store.ts` (from `RulesEngine`,
  `RouteStore`, `RouteEngine`). Headers in → plan out; it moves nothing.

## Outlook COM iteration (why the scan reads every message)

The inbox scan iterates `Inbox.Items` with the collection **enumerator**
(`foreach ($it in $items)`), not by numeric index (`$items.Item($i)`).
Index-based iteration over an Outlook `Items` collection — especially after a
`Sort()` and while releasing each item — is a well-known source of *silently
skipped items* (a scan that reports only a handful of messages from a full
inbox). The enumerator (IEnumVARIANT) is stable. The scan also **counts and
reports non-mail / unreadable items** (`skipped`) instead of dropping them
silently, and accessing each item's `.Class` is guarded so one bad item can't
knock the rest out. Folder listing (`ListSubfolders`) is **recursive** — nested
inbox subfolders are returned as `Parent\Child` paths — and `EnsureFolder`
resolves/creates those nested paths, so filing to nested folders works. The
Cleanup tab has a **Sync folders** button (the original's "Sync Folder Structure
From Outlook") to re-read the tree on demand.

## Features (ported from the original)

- **Scan inbox** (most recent 500) → group by sender, classify against saved rules,
  and flag likely junk (List-Unsubscribe / bulk headers, no-reply/VERP addresses,
  bulk-mail domains).
- **Bulk file** senders into Inbox subfolders (or keep-in-inbox); one-click "file
  suggested junk" to `_Review`. Create folders on the fly.
- **Apply** moves the mail and remembers sender→folder rules; **Undo** reverses the
  last run (mail is moved, never deleted; batches are recorded for undo).
- **Subject rules** that override sender rules (subject-contains → folder).
- **AI reply drafting** (port of `AiDraftService`): drafts a reply per selected
  message and saves it to Outlook Drafts (never sent). Tries **Gemini 2.5 Flash**,
  then **DeepSeek** — the original order.
- **History** of recorded cleanup runs.

## API keys (central vault)

AI keys are **not** stored in this module. The main process reads them at call
time from the shell's central vault via `ctx.getApiKey('gemini')` then
`ctx.getApiKey('deepseek')`, and never forwards a value to the renderer. If neither
is set, drafting returns a clear "set a Gemini or DeepSeek key in Settings → API
Keys" message. The renderer only sees presence booleans (`SHELL_IPC.apiKeysStatus`).

## Persistence

Routing rules (`365-email-cleanup.routes`) and the undo history
(`365-email-cleanup.undoHistory`, capped at 25 batches) live in the shell's
module store via `storeGet`/`storeSet` — no keys or mail contents are persisted.

## IPC channels (`365-email-cleanup:*`)

`connect`, `scan`, `list-folders`, `create-folder`, `cleanup`, `undo`, `has-undo`,
`history`, `routes-load`, `routes-save`, `draft-reply`, `cancel`. Progress is pushed
on `365-email-cleanup:progress`.

## MCP tools (`365-email-cleanup__*`)

Read-only: `connect`, `list-folders`, `scan`, `list-rules`, `history`,
`create-folder`. Destructive (confirmation-gated): `cleanup`, `undo`. Credential-
gated: `draft-reply` (caller must supply a Gemini/DeepSeek key). Plus `cancel`.

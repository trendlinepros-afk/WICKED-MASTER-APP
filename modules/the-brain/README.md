# The Brain

The app's own local **Obsidian-style markdown vault** — one memory that lives
*inside* WICKED instead of a folder on your `C:\` drive, so it travels with
**Backup & Cloud Sync** (GitHub) like everything else.

## Where it lives

```
%APPDATA%/WICKED-Suite/modules/the-brain/vault/
  Chats/
    AI Advisor/<title>.md          ← auto-saved AI Advisor conversations
    Wicked AI Chat/<title>.md      ← auto-saved Wicked AI Chat conversations
  Personas/<name>/*.md             ← an agent persona's grounding documents
  Imported/*.md                    ← files you imported
  Notes/*.md                       ← notes you write in The Brain
```

The whole `vault/` folder is picked up by the shell's Backup & Cloud Sync
automatically (the sync walks `modules/` recursively), so your notes, chats and
personas sync across machines with no extra setup. You can also open the folder
in Obsidian directly (**Open folder** button) — it's plain markdown.

## What it does

- **Browse / edit** every note in a two-pane vault view (folder tree + editor
  with live markdown preview).
- **Import `.md`** files from disk (they land in `Imported/`).
- **New note** for free-form notes (`Notes/`).
- **Delete** any note or folder — which also removes it from the next sync.

## Automatic chat capture

Both AI chat surfaces write here on their own:

- **AI Advisor** (Stocks) and **Wicked AI Chat** save every conversation to
  `Chats/<source>/` as markdown, updated as the chat grows and **renamed on disk**
  when you rename the chat. **Deleting** a chat in either tool deletes its note in
  The Brain too.
- Existing conversations and personas are **ported in once** on first run after
  this update.

## Personas live in the app

Agent personas in Wicked AI Chat used to point at an Obsidian folder on your
local drive. Now, whenever a persona is created or edited, its grounding
documents are **copied into `Personas/<name>/`** and the persona is re-pointed
there — so personas (and their brains) sync with the app. The original folder on
disk is left untouched.

## MCP

Read-only: `the-brain__list` (folder/file tree), `the-brain__read` (one note by
path) and `the-brain__search` (keyword search). Writing/deleting stays a
deliberate action in the tool UI.

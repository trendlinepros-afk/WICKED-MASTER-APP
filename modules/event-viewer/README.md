# Event Viewer Analyzer

Port of the standalone **Windows Event Viewer Analyser** (C# / .NET 8 WinForms,
`X:\Coding\_Active Projects\Windows Event Viewer Analyser`) into the WICKED shell.

Collects recent Windows Event Log entries, de-duplicates them into groups, shows them in a
filterable table, and sends a plain-text digest to the DeepSeek chat completions API to
generate a **Windows Health Report** (Markdown, rendered in-app). A side "Investigate" chat
lets you ask follow-up questions against the same collection — the digest is pinned as the
system message of a multi-turn session, exactly like the original `ChatSession`.

## Carried over from the original

- **Logs:** Application + System on by default; Security (audit failures only) and Setup
  opt-in — same checkboxes as `MainForm`.
- **Levels:** Critical / Error / Warning on by default, Information opt-in ("can be slow").
- **Time range:** presets Last hour / 6 h / 12 h / 24 h / 3 days / 7 days + custom range;
  default **Last 24 hours**. Presets resolve relative to "now" at collection time.
- **Security log handling:** filtered by the audit-failure keyword bit
  (`0x0010000000000000`), not by level, because the Security log records nearly everything
  at level Information.
- **Grouping:** events de-duplicated by `log | provider | eventId | level` with occurrence
  count, first/last seen, and up to **2 sample messages** of **600 chars** each
  (whitespace-collapsed; raw-properties fallback when the provider can't format the
  message) — mirrors `EventCollector`.
- **Digest:** same layout as `EventCollector.BuildDigest` (machine, OS, range, counts by
  level, collection warnings, one line per group), truncated at **120,000 chars**.
- **AI:** DeepSeek `POST https://api.deepseek.com/chat/completions`, model
  `deepseek-chat`, `temperature 0.3`, `max_tokens 6000`, non-streaming, 300 s timeout.
  System prompt and report instructions are verbatim from `AiClient.cs`. Failed exchanges
  leave the chat history unchanged so they can be retried.
- Sending a chat message before pressing Analyse auto-collects first, same as the original.

## Deliberate changes

- **No hardcoded API key.** The original baked a DeepSeek key into `Config.cs`. Here the
  key lives in WICKED's **central API key vault** (Settings → API Keys, encrypted with
  Electron `safeStorage`): main-process code reads it at call time via
  `ctx.getApiKey('deepseek')`, and the renderer only ever sees set/not-set booleans
  (`SHELL_IPC.apiKeysStatus` / `apiKeysChanged`). When the key is missing the UI shows a
  notice pointing at Settings → API Keys; the key value is never sent to the renderer.
- **No elevation.** The original suggested "run as Administrator" for the Security log.
  WICKED never elevates: if the Security log can't be read, it is skipped with a notice
  (surfaced in the UI and in the digest as a collection warning).
- **Collection runs out-of-process** via `powershell.exe -EncodedCommand` using
  `Get-WinEvent -FilterHashtable @{ LogName; StartTime; EndTime; Level | Keywords }`
  with `ConvertTo-Json`, instead of `System.Diagnostics.Eventing.Reader`. Grouping and
  sampling happen inside the script so only compact groups cross the IPC boundary.
- **Safety cap (new):** at most **10,000 events per log** are read (newest first — the
  original was unbounded). Hitting the cap adds a warning suggesting a narrower range.
- **Export:** Markdown only (`dialog.showSaveDialog`); the original also offered HTML.
- **Rendering:** `react-markdown` + `remark-gfm` in a `prose dark:prose-invert` container
  instead of the original's hand-rolled Markdown→HTML in a `WebBrowser` control.
- The events table (level badge / count / last seen / log / source / event ID / message
  preview, with level-filter chips and count summary) is new — the original only showed
  the AI report.

## IPC channels

| Channel | Direction | Purpose |
| --- | --- | --- |
| `event-viewer:collect` | invoke | Spawn PowerShell, collect + group events for `{ logs, levels, fromIso, toIso }` |
| `event-viewer:progress` | on | Per-log progress text during collection |
| `event-viewer:ai-complete` | invoke | One exchange: full message history in, assistant reply out |
| `event-viewer:cancel` | invoke | Kill the collection child process / abort the in-flight AI request |
| `event-viewer:export-report` | invoke | Save-dialog + write the report Markdown to a `.md` file |

The DeepSeek key intentionally has no module channels — it is read in the main process
from the shell vault (`ctx.getApiKey('deepseek')`); the renderer checks presence via the
shell's `SHELL_IPC.apiKeysStatus` / `apiKeysChanged` channels.

## Quirks

- The Information level genuinely can be slow — tens of thousands of events per day are
  normal; expect the 10k/log cap warning on wide ranges.
- The Setup log doesn't exist on some machines; that surfaces as a "not found" notice,
  same as the original.
- Events whose provider metadata is missing show `Raw event data: …` (joined raw
  properties) as their sample text, mirroring `EventCollector.GetMessage`.

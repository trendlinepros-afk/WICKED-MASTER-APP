# ROBOCOPY GUI

Port of the standalone **Robocopy GUI** C#/WPF app
(`X:\Coding\_Active Projects\ROBOCopy GUI`) into the WICKED suite. Builds a
robocopy command from plain-English options, runs it with live output, and
translates the bitmask exit code into a human verdict.

## What carried over (and from where)

| Original file | Ported to | Notes |
| --- | --- | --- |
| `Services/CommandBuilder.cs` | `store.ts` (`buildArguments`, `normalizePath`, `quotePath`) | 1:1 port, including the trailing-backslash pitfalls: separators are stripped except drive roots, where the backslash is doubled inside quotes (`"C:\\"`); bare `C:` gets its root slash back; `/LOG` auto-adds `/TEE`; dry-run appends `/L`; custom flags appended verbatim. |
| `Data/FlagCatalog.cs` | `store.ts` (`FLAG_CATEGORIES`) | Same curated flags, titles, descriptions, defaults (`/E /MT:8 /R:2 /W:5` on by default) and exclusion groups (`subdirs`: /E vs /S; `mode`: /MIR vs /MOVE vs /MOV — checking one unchecks the rest). |
| `Services/ExitCodeTranslator.cs` | `store.ts` (`translateExitCode`) | Identical bitmask logic: `<0` cancelled (warning), `>=16` fatal, bit 8 failures, bit 4 warnings, else success; bit-by-bit detail strings match. |
| `Services/RobocopyRunner.cs` | `ipc.ts` (`robocopy-gui:run` / `:cancel` / `:probe`) | Spawns `%SystemRoot%\System32\robocopy.exe` hidden with piped output, batches lines every 150 ms, cancel kills the process and reports exit code −1. The `New File`/`Newer`/`Older`/`Modified`/`ERROR` line heuristics for the live counters live in `store.ts` (`appendOutput`). |
| `Services/ProfileStore.cs` | `ipc.ts` (profile handlers) | Profiles are `*.rcjob.json` with the **same PascalCase JSON shape** (`Source`, `Destination`, `CustomFlags`, `Flags: { "/E": { On, Value } }`), so files from `%AppData%\RobocopyGui\Profiles` can be dropped in unchanged. New location: `<userData>\modules\robocopy-gui\profiles`. `last-session.json` (same shape) restores the last job on open; it's saved on a debounce instead of on window close. |
| `MainWindow.xaml(.cs)` | `index.tsx` | Live command preview with `<source>`/`<destination>` placeholders, copy-to-clipboard, swap paths, path validation (empty / same / missing source), destination-inside-source warning, dangerous-flag run confirmation, bounded output pane (~2 MB, trimmed to 1 MB), status line with files-copied/error counters and elapsed time. |

## Elevation (differs from the original by design)

The original app relaunched **itself** as administrator. Per the WICKED module
contract, the shell never elevates; instead there is a per-job
**"Run elevated (UAC)"** toggle. When on, Run/Preview launch
`powershell Start-Process -Verb RunAs` on `cmd /k robocopy …` — a visible
console window that stays open with the full report. Output cannot be streamed
back from an elevated process, so the pane shows a note instead (use `/LOG` if
you need a saved report). The "Administrator needed" hint appears when an
admin-only flag (`/B`, `/COPYALL`) is checked without the toggle.

## IPC channels (all `robocopy-gui:*`)

`probe`, `dir-exists`, `pick-folder`, `pick-log-file`, `run`, `cancel`,
`run-elevated`, `profiles-list`, `profile-save`, `profile-load`,
`profile-delete`, `open-profiles-folder`, `session-load`, `session-save`.
Events pushed to the renderer: `output` (string[] batches) and `exit`
(`{ code }`, −1 = cancelled).

## Quirks

- Robocopy writes legacy OEM-code-page console output; the C# app decoded it
  with the OEM code page. Here stdout is decoded as `latin1` (lossless
  byte-to-char), so accented file names may render approximately in the pane —
  the copy itself is unaffected.
- One job at a time, exactly like the original (`run` refuses while running).
- The "Run elevated" toggle is intentionally **not** written into profile
  files, to keep the `.rcjob.json` shape byte-compatible with the old app.
- Elevated runs pass the command through `cmd /k`; a path containing `&`, `^`
  or `%` could be mis-parsed by cmd in that mode. Non-elevated runs are immune
  (args go straight to robocopy.exe).

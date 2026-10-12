# Performance Analyzer

On-demand system performance capture, modelled on App Control's activity view:
a real graph of **CPU / Memory / Disk / GPU / Processes** over any time frame,
the apps behind every moment, and every saved capture kept on disk so later
visits can scroll back through them.

## On demand only

Nothing runs until **Start Capture**. Then one hidden PowerShell process
(`ipc/sampler.ts`) prints raw counters every tick (1/2/5/10 s, default 2 s);
**Stop Capture**, the **auto-stop** timer (default 4 h, settable to "never") or
quitting WICKED kills it. No service, no startup task, no admin rights.

## What is read (Windows performance counters via CIM — no elevation)

| Data | Source |
| --- | --- |
| per-process CPU time, private working set, I/O bytes | `Win32_PerfRawData_PerfProc_Process` (raw cumulative; deltas in Node) |
| total CPU | the same query's `_Total` minus `Idle` |
| memory in use | Node `os.totalmem() - os.freemem()` |
| GPU % per process + overall | `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` — overall = busiest engine (Task Manager's method), per app = its busiest engine |
| dedicated GPU memory | `…GPUAdapterMemory.DedicatedUsage` |
| disk active % / read / write | `Win32_PerfFormattedData_PerfDisk_PhysicalDisk` `_Total` |
| temperature | `Win32_PerfFormattedData_Counters_ThermalZoneInformation` (ACPI zone; not every PC has one — then no strip) |
| app name / publisher / "Unsigned" | first time each exe is seen: `FileVersionInfo` + `Get-AuthenticodeSignature` (files < 64 MB), path from `Get-Process` or `Win32_Process` |

Apps are grouped by exe (`chrome#12` → chrome, ×N instances). Per-app "disk" is
the process I/O counter (disk + network + device), shown as bytes/s.

## Storage (`%APPDATA%/WICKED-Suite/modules/perf-analyzer/`)

- `sessions/<id>.jsonl` — header line, then one sample per tick: totals + the
  top apps for each metric (≈ 25 apps; the rest summed as "others").
- `sessions/<id>.min.jsonl` — one summary per minute (avg + peak + apps), used
  when a view's buckets are ≥ 1 minute (6 h and longer), so a week loads fast.
- `sessions.json` (index), `apps.json` (exe details).
- Append-only: a power cut loses at most a tick; the next launch closes the open
  session and rebuilds its minute file. Sessions older than **Keep sessions for**
  (default 30 days) are deleted. The `sessions/` folder is excluded from Backup /
  Cloud Sync (it's this PC's history and grows with every capture).

## The graph

- Time frames 5 min → 30 days; ‹ › step, the strip below shows all history with
  a draggable window, **Live** follows now. Gaps are hatched "Not capturing";
  dotted lines mark where sessions start.
- Line = average per bucket, shaded band = peak; the line turns red above the
  spike line (CPU/GPU 85 %, memory/disk 90 %). Red pills mark each spike (its
  peak and the app most to blame), green **+N** pills mark apps that started.
- Hover: time, temperature, value and the top 3 apps; click: every app recorded
  in that slice (switchable between CPU / memory / GPU / disk).
- Below: apps for the time frame sorted by CPU / memory / GPU / disk / name with
  sparklines, average and peak; click up to 3 to draw them on the graph (not on
  Disk — app I/O is bytes/s, the graph is active-time %, one axis only).

## MCP

`perf-analyzer__status`, `__start-capture`, `__stop-capture`, `__sessions`,
`__summary` (averages, peaks, top apps per metric, every spike with its culprit
for a time window), `__moment`, `__delete-sessions` (destructive, confirm-gated).

## Testing notes

`WICKED_PERF_SAMPLER=<script.js>` makes the sampler spawn that Node script
instead of PowerShell (it must print the same line protocol) — used by the
headless tests on Linux.

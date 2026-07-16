# Wicked Optomizzzer

A **real in-app port** of the standalone C#/.NET 8 WPF *WickedOptimizer* (34 views, 21
services, `requireAdministrator` manifest) into the WICKED shell. The old module only
shelled out to `WickedOptimizer.exe` (which opened its own elevated window outside WICKED).
This module reimplements the core, high-value features as React screens backed by
Node + PowerShell — nothing shells out to the old exe anymore.

## Elevation model (per-action, on demand)

WICKED itself **never runs as administrator** (module-contract rule). Instead:

- **Read operations** (dashboard, all scans/listings) run **unelevated** PowerShell
  out-of-process (like `event-viewer`), or Node built-ins.
- **System-changing operations** run an **elevated child** via
  `Start-Process -Verb RunAs`, so the Windows **UAC prompt fires only for that one
  action**. The elevated child writes its JSON result to a temp file which the
  unelevated launcher reads back (elevated processes can't stream stdout to us), so these
  actions report a **final result**, not live progress. This replaces the original app's
  whole-app "run as Administrator" requirement.

Each screen shows a per-action "this needs administrator (UAC)" note where actions elevate.

## Ported views (faithful to the original services)

| View | Reads | Elevated action | Original source |
| --- | --- | --- | --- |
| **Dashboard** | CPU load (Node `os.cpus()` delta), RAM (`os` totals), uptime (`os.uptime`), OS name + fixed disks (`Get-CimInstance Win32_OperatingSystem` / `Win32_LogicalDisk`) | — (read-only) | `SystemHealth.cs`, `SystemInfoService.cs`, `Native.cs` |
| **Cleaner** | Per-category size + file count (recycle bin via `Shell.Application`; folders via `Get-ChildItem`) | **Clean** — deletes files / `Clear-RecycleBin` | `Cleaner.cs`, `RecycleBin.cs` |
| **Services** | `Get-CimInstance Win32_Service` (state, start mode, account); Microsoft/third-party + protected flags | **Enable/Disable/Stop** — `sc.exe config` + `Stop-Service` | `ServiceScanner.cs` |
| **Startup** | Registry Run keys (HKLM, WOW6432, HKCU) + startup folders + `StartupApproved` state | **Enable/Disable** — writes `StartupApproved` binary flag | `StartupScanner.cs` |
| **Installed Apps** | Registry uninstall keys (HKLM/WOW6432/HKCU), de-duped, filtered | **Uninstall** — `msiexec /x {GUID}` or the registered uninstall command | `AppScanner.cs`, `Uninstaller.cs` |
| **Updates** | `winget upgrade --include-unknown` fixed-width table parse | **Update / Update all** — `winget upgrade` (elevated) | `UpdateService.cs` |

Cleaner categories carried over: recycle bin, user temp, Windows temp, prefetch, Windows
Update cache (>1 day), temporary internet files, crash dumps & WER, thumbnail cache. The
`admin` badge marks categories whose folders are system-owned.

Protected core services (`RpcSs`, `Winmgmt`, `WinDefend`, `Schedule`, …) are the same set
as the original and are rejected before any elevated `sc.exe` call.

## NOT yet ported (was 34 views in the original)

These views/services from the WPF app were intentionally left out of this pass and are
candidates for later:

- **Performance** monitor / live graphs (`PerfEngine.cs`, `PerformanceView`)
- **Task Manager** / running processes (`ProcessService.cs`, `TaskManagerView`)
- **Drivers** inventory & updates (`DriverService.cs`, `DriversView`)
- **Registry cleaner** (`RegistryCleaner.cs`, `Safety.cs`, `BrowserRegistryView`)
- **Large files** finder (`DiskScanner.cs`, `LargeFilesView`)
- **Desktop** cleanup (`DesktopScanner.cs`, `DesktopView`)
- **Browser** cleanup (`BrowserScanner.cs`)
- **Event Viewer** (already a separate WICKED module — `modules/event-viewer`)
- **Logs / Activity log** (`ActivityLog.cs`, `LogsView`)
- **System Info** detailed spec table (partially surfaced on the Dashboard)
- App **usage/last-used** matching in Installed Apps (`UsageData.cs`) — apps list omits
  last-used/launch-count for speed.
- Cleaner's **Downloads (recycle, >7 days)** category and per-file expandable view — the
  in-app cleaner hard-deletes system/temp caches only (no send-to-recycle for user files).

## IPC channels (`wicked-optomizzzer:*`)

| Channel | Type | Purpose |
| --- | --- | --- |
| `dashboard` | read | CPU/RAM/uptime/OS/disks snapshot |
| `clean-scan` | read | Reclaimable size per cleanup category |
| `clean` | **elevated** | Delete selected categories / empty recycle bin |
| `list-services` | read | Windows services list |
| `set-service` | **elevated** | Set start type and/or stop a service |
| `list-startup` | read | Startup entries + enabled state |
| `set-startup` | **elevated** | Toggle a startup entry (StartupApproved) |
| `list-apps` | read | Installed applications |
| `uninstall-app` | **elevated** | Run an app's uninstaller |
| `list-updates` | read | `winget upgrade` listing |
| `apply-updates` | **elevated** | Apply one/all winget upgrades |
| `cancel` | control | Kill in-flight read child processes |
| `progress` | event (`on`) | Elevation status text (`elevating` / `done`) for the active view |

## MCP tools (`wicked-optomizzzer__<action>`)

Read tools (freely callable): `dashboard`, `clean-scan`, `list-services`, `list-startup`,
`list-apps`, `list-updates`. Destructive tools (`destructive: true`, gated on
`ctx.confirm`): `clean`, `set-service`, `set-startup`, `uninstall-app`, `apply-updates`.
Each delegates to the same IPC channel the UI uses — one implementation, one validation
path — so an agent action triggers the identical UAC-gated behavior.

## Quirks & gaps

- Elevated actions **cannot stream progress** (the elevated child is a separate process);
  the UI shows an indeterminate "Waiting for the UAC prompt…" state and then the final
  result. Cleaning large caches can take a while with no per-file feedback.
- Declining the UAC prompt returns a "cancelled" result and changes nothing.
- Some read scans hit access-denied on system folders while unelevated (e.g. Windows
  Update cache / prefetch sizes may read low); the elevated Clean still reaches them.
- **winget** is required for the Updates view; if "App Installer" isn't present the view
  reports that winget is unavailable.
- Recycle-bin size uses `Shell.Application` + `System.Size` (locale-independent), not the
  original's `SHQueryRecycleBin` P/Invoke.

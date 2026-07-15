# Wicked Optomizzzer (launcher module)

The original app is a C#/.NET 8 WPF program (34 views, 21 services) whose manifest
sets `requireAdministrator`, with deep Win32/P-Invoke and `sc.exe`/`reg.exe`/`winget`
usage. Porting it to React/Node in one pass wasn't sensible, so this module **wraps
the existing exe** instead of reimplementing it.

- `wicked-optomizzzer:launch` uses ShellExecute (`shell.openPath`), so the exe's own
  manifest triggers the UAC prompt — WICKED itself never elevates (module-contract
  elevation rule).
- Default exe locations tried in order: the installed copy under
  `C:\Program Files (x86)\Wicked Optimizer\`, then the dev build in
  `_Active Projects\Wicked Optomizzzer\dist\`. Overridable via Browse (persisted in
  the shared module store).
- Candidate for an incremental true port later (dashboard first).

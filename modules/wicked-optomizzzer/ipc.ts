import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { cpus, freemem, tmpdir, totalmem, uptime } from 'os'
import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'

/**
 * WICKED OPTOMIZZZER — real in-app port of the C#/.NET 8 WPF optimizer.
 *
 * Design (module contract §elevation): WICKED itself NEVER runs elevated.
 *   - Read operations (dashboard / scans / listings) run UNELEVATED PowerShell
 *     out-of-process, exactly like event-viewer's collector.
 *   - System-changing operations (clean, service change, startup toggle,
 *     uninstall, apply-update) run an ELEVATED child via
 *     `Start-Process -Verb RunAs`, so the Windows UAC prompt fires ONLY for that
 *     one action. The elevated child writes its JSON result to a temp file which
 *     the (unelevated) launcher reads back — elevated processes can't stream
 *     stdout to us, so these actions report a final result rather than progress.
 */

const ID = 'wicked-optomizzzer'

/* --------------------------------- helpers -------------------------------- */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** PowerShell single-quoted string literal ('' escapes an embedded quote). */
function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function psEncode(script: string): string {
  // Prefix mirrors Ps.cs: force UTF-8 console output so ConvertTo-Json survives.
  const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script
  return Buffer.from(full, 'utf16le').toString('base64')
}

/** Extract the first JSON value from noisy stdout (skips banners / BOM). */
function firstJson(text: string): string | null {
  const iObj = text.indexOf('{')
  const iArr = text.indexOf('[')
  const starts = [iObj, iArr].filter((i) => i >= 0)
  if (starts.length === 0) return null
  return text.slice(Math.min(...starts))
}

const WIN = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
const LOCAL = process.env['LOCALAPPDATA'] ?? join(process.env['USERPROFILE'] ?? 'C:\\', 'AppData\\Local')
const PROGDATA = process.env['ProgramData'] ?? 'C:\\ProgramData'
const USERTEMP = process.env['TEMP'] ?? process.env['TMP'] ?? join(LOCAL, 'Temp')

/* ---------------------------- cleaner categories -------------------------- */

interface CleanCategory {
  key: string
  name: string
  description: string
  paths: string[]
  minAgeDays: number
  thumbsFilter: boolean
  special: string | null
  /** true = disabling/cleaning it reaches system-owned folders (needs admin). */
  systemScope: boolean
  defaultSelected: boolean
}

/** Faithful subset of Cleaner.BuildCategories (recycle/download recycle logic aside). */
function cleanCategories(): CleanCategory[] {
  return [
    {
      key: 'recyclebin',
      name: 'Recycle Bin',
      description: 'Permanently empties the Recycle Bin',
      paths: [],
      minAgeDays: 0,
      thumbsFilter: false,
      special: 'recyclebin',
      systemScope: false,
      defaultSelected: true
    },
    {
      key: 'usertemp',
      name: 'User temporary files',
      description: 'Leftovers in your %TEMP% folder',
      paths: [USERTEMP],
      minAgeDays: 0,
      thumbsFilter: false,
      special: null,
      systemScope: false,
      defaultSelected: true
    },
    {
      key: 'wintemp',
      name: 'Windows temporary files',
      description: 'System-wide temp folder (needs admin)',
      paths: [join(WIN, 'Temp')],
      minAgeDays: 0,
      thumbsFilter: false,
      special: null,
      systemScope: true,
      defaultSelected: true
    },
    {
      key: 'prefetch',
      name: 'Prefetch data',
      description: 'Windows prefetch cache — rebuilds automatically (needs admin)',
      paths: [join(WIN, 'Prefetch')],
      minAgeDays: 0,
      thumbsFilter: false,
      special: null,
      systemScope: true,
      defaultSelected: false
    },
    {
      key: 'wupdate',
      name: 'Windows Update cache',
      description: 'Old downloaded update files, older than 1 day (needs admin)',
      paths: [join(WIN, 'SoftwareDistribution\\Download')],
      minAgeDays: 1,
      thumbsFilter: false,
      special: null,
      systemScope: true,
      defaultSelected: false
    },
    {
      key: 'inetcache',
      name: 'Temporary internet files',
      description: 'Windows / IE / Edge web cache',
      paths: [join(LOCAL, 'Microsoft\\Windows\\INetCache')],
      minAgeDays: 0,
      thumbsFilter: false,
      special: null,
      systemScope: false,
      defaultSelected: false
    },
    {
      key: 'crashdumps',
      name: 'Crash dumps & error reports',
      description: 'CrashDumps and Windows Error Reporting data',
      paths: [
        join(LOCAL, 'CrashDumps'),
        join(LOCAL, 'Microsoft\\Windows\\WER'),
        join(PROGDATA, 'Microsoft\\Windows\\WER')
      ],
      minAgeDays: 0,
      thumbsFilter: false,
      special: null,
      systemScope: true,
      defaultSelected: false
    },
    {
      key: 'thumbs',
      name: 'Thumbnail cache',
      description: 'Explorer thumbnail database (rebuilds automatically)',
      paths: [join(LOCAL, 'Microsoft\\Windows\\Explorer')],
      minAgeDays: 0,
      thumbsFilter: true,
      special: null,
      systemScope: false,
      defaultSelected: false
    }
  ]
}

/** Services we never let the user weaken (mirror of ServiceScanner.Protected). */
const PROTECTED_SERVICES = new Set(
  [
    'RpcSs', 'RpcEptMapper', 'DcomLaunch', 'BFE', 'mpssvc', 'Dhcp', 'Dnscache', 'nsi', 'Power',
    'PlugPlay', 'Schedule', 'EventLog', 'ProfSvc', 'Themes', 'AudioSrv', 'Audiosrv', 'CryptSvc',
    'LanmanServer', 'LanmanWorkstation', 'Winmgmt', 'gpsvc', 'SamSs', 'UserManager',
    'CoreMessagingRegistrar', 'WinDefend', 'SecurityHealthService', 'wscsvc', 'TrustedInstaller',
    'msiserver', 'BrokerInfrastructure'
  ].map((n) => n.toLowerCase())
)

/* --------------------------------------------------------------------------- *
 *  register
 * --------------------------------------------------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  const readChildren = new Set<ChildProcess>()

  const sendProgress = (payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(`${ID}:progress`, payload)
  }

  /**
   * Run an UNELEVATED PowerShell script that emits JSON on stdout and return
   * the parsed value. Registered as cancellable (cancel kills all read children).
   */
  function runPsJson(script: string, timeoutMs = 60_000): Promise<{ ok: true; data: unknown } | { ok: false; error: string; cancelled?: boolean }> {
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(script)],
          { windowsHide: true }
        )
      } catch (err) {
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
        return
      }
      readChildren.add(child)
      let out = ''
      let errText = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, timeoutMs)

      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.stderr?.on('data', (d: Buffer) => {
        errText += d.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        readChildren.delete(child)
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
      })
      child.on('close', () => {
        clearTimeout(timer)
        readChildren.delete(child)
        if (child.killed) {
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        const json = firstJson(out)
        if (json === null) {
          const detail = (errText || out || 'no output').trim().slice(0, 500)
          resolve({ ok: false, error: 'PowerShell returned no data. ' + detail })
          return
        }
        try {
          resolve({ ok: true, data: JSON.parse(json) })
        } catch (err) {
          resolve({ ok: false, error: 'Could not parse PowerShell output: ' + errMsg(err) })
        }
      })
    })
  }

  /**
   * Run one ELEVATED action. `work` is PowerShell that must assign `$result`
   * (a hashtable). We write it to a temp .ps1, then an unelevated launcher does
   * `Start-Process -Verb RunAs -Wait` — UAC fires here, for this action only —
   * and reads the JSON the elevated child wrote to a temp file. WICKED stays
   * unelevated throughout.
   */
  async function runElevated(work: string, timeoutMs = 300_000): Promise<Record<string, unknown>> {
    const tag = randomBytes(8).toString('hex')
    const scriptPath = join(tmpdir(), `wickedopt-${tag}.ps1`)
    const resultPath = join(tmpdir(), `wickedopt-${tag}.json`)

    const childScript =
      "$ErrorActionPreference='Stop'\n" +
      `$ResultPath = ${psq(resultPath)}\n` +
      'try {\n' +
      "  [Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" +
      `${work}\n` +
      '} catch {\n' +
      '  $result = @{ ok=$false; error=$_.Exception.Message }\n' +
      '}\n' +
      'try { ($result | ConvertTo-Json -Depth 6 -Compress) | Out-File -FilePath $ResultPath -Encoding UTF8 } catch {}\n'

    try {
      await writeFile(scriptPath, childScript, 'utf8')
    } catch (err) {
      return { ok: false, error: 'Could not stage the elevated action: ' + errMsg(err) }
    }

    const launcher =
      "$ErrorActionPreference='Stop'\n" +
      `$scriptPath = ${psq(scriptPath)}\n` +
      `$resultPath = ${psq(resultPath)}\n` +
      'try {\n' +
      "  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$scriptPath) -Verb RunAs -Wait -PassThru\n" +
      '  if (Test-Path -LiteralPath $resultPath) { Get-Content -Raw -LiteralPath $resultPath }\n' +
      '  else { \'{"ok":false,"error":"The elevated action produced no result (it may have failed to start)."}\' }\n' +
      '} catch {\n' +
      '  \'{"ok":false,"cancelled":true,"error":"Elevation was cancelled or denied at the UAC prompt."}\'\n' +
      '}\n'

    const cleanup = async (): Promise<void> => {
      await unlink(scriptPath).catch(() => undefined)
      await unlink(resultPath).catch(() => undefined)
    }

    return await new Promise<Record<string, unknown>>((resolve) => {
      let ps: ChildProcess
      try {
        ps = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncode(launcher)],
          { windowsHide: true }
        )
      } catch (err) {
        void cleanup()
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
        return
      }
      let out = ''
      let errText = ''
      const timer = setTimeout(() => {
        try {
          ps.kill()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
      ps.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      ps.stderr?.on('data', (d: Buffer) => {
        errText += d.toString('utf8')
      })
      ps.on('error', (err) => {
        clearTimeout(timer)
        void cleanup()
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
      })
      ps.on('close', () => {
        clearTimeout(timer)
        void cleanup()
        const json = firstJson(out)
        if (json === null) {
          resolve({
            ok: false,
            error: 'The elevated action returned no data. ' + (errText || 'UAC may have been declined.').trim().slice(0, 400)
          })
          return
        }
        try {
          resolve(JSON.parse(json) as Record<string, unknown>)
        } catch (err) {
          resolve({ ok: false, error: 'Could not parse the elevated action result: ' + errMsg(err) })
        }
      })
    })
  }

  /* ----------------------------- 1. DASHBOARD ---------------------------- */

  ctx.ipcMain.handle(`${ID}:dashboard`, async () => {
    // CPU load sampled in Node from os.cpus() times (mirror of Native.GetCpuLoad).
    const sample = (): { idle: number; total: number } => {
      let idle = 0
      let total = 0
      for (const c of cpus()) {
        const t = c.times
        idle += t.idle
        total += t.user + t.nice + t.sys + t.idle + t.irq
      }
      return { idle, total }
    }
    const a = sample()
    await new Promise((r) => setTimeout(r, 250))
    const b = sample()
    const dTotal = b.total - a.total
    const dIdle = b.idle - a.idle
    const cpuLoad = dTotal > 0 ? Math.round(Math.min(1, Math.max(0, (dTotal - dIdle) / dTotal)) * 100) : 0

    const total = totalmem()
    const free = freemem()
    const cpuList = cpus()

    const psRes = await runPsJson(
      "@{ os=(Get-CimInstance Win32_OperatingSystem).Caption; " +
        "drives=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { " +
        "@{ name=[string]$_.DeviceID; label=[string]$_.VolumeName; total=[int64]$_.Size; free=[int64]$_.FreeSpace } }) } " +
        '| ConvertTo-Json -Depth 4 -Compress',
      20_000
    )

    let osName = 'Windows'
    let drives: Array<{ name: string; label: string; total: number; free: number }> = []
    if (psRes.ok && psRes.data && typeof psRes.data === 'object') {
      const d = psRes.data as Record<string, unknown>
      if (typeof d.os === 'string' && d.os) osName = d.os
      const raw = Array.isArray(d.drives) ? d.drives : d.drives ? [d.drives] : []
      drives = raw
        .map((x) => x as Record<string, unknown>)
        .map((x) => ({
          name: typeof x.name === 'string' ? x.name : '',
          label: typeof x.label === 'string' ? x.label : '',
          total: Number(x.total) || 0,
          free: Number(x.free) || 0
        }))
        .filter((x) => x.name && x.total > 0)
    }

    return {
      ok: true,
      osName,
      cpuName: cpuList[0]?.model.trim() ?? 'Unknown CPU',
      cpuCores: cpuList.length,
      cpuLoad,
      ramTotal: total,
      ramUsed: total - free,
      ramPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      uptimeSec: Math.floor(uptime()),
      drives
    }
  })

  /* --------------------------- 2. CLEANER (read) ------------------------- */

  ctx.ipcMain.handle(`${ID}:clean-scan`, async () => {
    const cats = cleanCategories()
    const payload = cats.map((c) => ({
      key: c.key,
      special: c.special,
      paths: c.paths,
      minAgeDays: c.minAgeDays,
      thumbsFilter: c.thumbsFilter
    }))
    const script =
      `$cats = ${psq(JSON.stringify(payload))} | ConvertFrom-Json\n` +
      '$out = @()\n' +
      'foreach ($c in $cats) {\n' +
      '  $bytes = [int64]0; $count = 0\n' +
      "  if ($c.special -eq 'recyclebin') {\n" +
      '    try {\n' +
      "      $sh = New-Object -ComObject Shell.Application\n" +
      '      $rb = $sh.NameSpace(10)\n' +
      '      foreach ($it in @($rb.Items())) { try { $s = $it.ExtendedProperty(\'System.Size\'); if ($s) { $bytes += [int64]$s; $count++ } } catch {} }\n' +
      '    } catch {}\n' +
      '  } else {\n' +
      '    foreach ($p in $c.paths) {\n' +
      '      if (-not (Test-Path -LiteralPath $p)) { continue }\n' +
      '      $files = @()\n' +
      '      try { $files = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue } catch {}\n' +
      '      foreach ($f in $files) {\n' +
      "        if ($c.thumbsFilter -and ($f.Name -notmatch '^(?i)(thumbcache|iconcache)')) { continue }\n" +
      '        if ($c.minAgeDays -gt 0 -and (((Get-Date) - $f.LastWriteTime).TotalDays -lt $c.minAgeDays)) { continue }\n' +
      '        $bytes += [int64]$f.Length; $count++\n' +
      '      }\n' +
      '    }\n' +
      '  }\n' +
      '  $out += [ordered]@{ key = $c.key; sizeBytes = $bytes; fileCount = $count }\n' +
      '}\n' +
      '@{ items = @($out) } | ConvertTo-Json -Depth 5 -Compress\n'

    const res = await runPsJson(script, 120_000)
    if (!res.ok) return res
    const data = res.data as Record<string, unknown>
    const items = Array.isArray(data.items) ? data.items : []
    const sizes = new Map<string, { sizeBytes: number; fileCount: number }>()
    for (const it of items) {
      const x = it as Record<string, unknown>
      if (typeof x.key === 'string') {
        sizes.set(x.key, { sizeBytes: Number(x.sizeBytes) || 0, fileCount: Number(x.fileCount) || 0 })
      }
    }
    return {
      ok: true,
      categories: cats.map((c) => ({
        key: c.key,
        name: c.name,
        description: c.description,
        systemScope: c.systemScope,
        defaultSelected: c.defaultSelected,
        sizeBytes: sizes.get(c.key)?.sizeBytes ?? 0,
        fileCount: sizes.get(c.key)?.fileCount ?? 0
      }))
    }
  })

  /* ------------------------- 2b. CLEANER (elevated) --------------------- */

  ctx.ipcMain.handle(`${ID}:clean`, async (_e, rawKeys: unknown) => {
    const keys = Array.isArray(rawKeys) ? rawKeys.filter((k): k is string => typeof k === 'string') : []
    const selected = cleanCategories().filter((c) => keys.includes(c.key))
    if (selected.length === 0) return { ok: false, error: 'No cleanup categories were selected.' }

    sendProgress({ view: 'cleaner', phase: 'elevating', message: 'Waiting for the UAC prompt…' })

    const payload = selected.map((c) => ({
      key: c.key,
      name: c.name,
      special: c.special,
      paths: c.paths,
      minAgeDays: c.minAgeDays,
      thumbsFilter: c.thumbsFilter
    }))
    const work =
      `$cats = ${psq(JSON.stringify(payload))} | ConvertFrom-Json\n` +
      '$results = @()\n' +
      'foreach ($c in $cats) {\n' +
      '  $freed = [int64]0; $removed = 0; $failed = 0; $outcome = \'empty\'\n' +
      "  if ($c.special -eq 'recyclebin') {\n" +
      '    $bytes = [int64]0; $cnt = 0\n' +
      '    try {\n' +
      "      $sh = New-Object -ComObject Shell.Application\n" +
      '      $rb = $sh.NameSpace(10)\n' +
      '      foreach ($it in @($rb.Items())) { try { $s = $it.ExtendedProperty(\'System.Size\'); if ($s) { $bytes += [int64]$s; $cnt++ } } catch {} }\n' +
      '    } catch {}\n' +
      '    if ($cnt -eq 0) { $outcome = \'empty\' }\n' +
      '    else { try { Clear-RecycleBin -Force -ErrorAction Stop; $freed = $bytes; $removed = $cnt; $outcome = \'success\' } catch { $failed = $cnt; $outcome = \'failed\' } }\n' +
      '  } else {\n' +
      '    foreach ($p in $c.paths) {\n' +
      '      if (-not (Test-Path -LiteralPath $p)) { continue }\n' +
      '      $files = @()\n' +
      '      try { $files = Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue } catch {}\n' +
      '      foreach ($f in $files) {\n' +
      "        if ($c.thumbsFilter -and ($f.Name -notmatch '^(?i)(thumbcache|iconcache)')) { continue }\n" +
      '        if ($c.minAgeDays -gt 0 -and (((Get-Date) - $f.LastWriteTime).TotalDays -lt $c.minAgeDays)) { continue }\n' +
      '        try { $len = [int64]$f.Length; Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $freed += $len; $removed++ } catch { $failed++ }\n' +
      '      }\n' +
      '    }\n' +
      '    if ($removed -gt 0 -and $failed -eq 0) { $outcome = \'success\' }\n' +
      '    elseif ($removed -gt 0 -and $failed -gt 0) { $outcome = \'partial\' }\n' +
      '    elseif ($removed -eq 0 -and $failed -gt 0) { $outcome = \'failed\' }\n' +
      '    else { $outcome = \'empty\' }\n' +
      '  }\n' +
      '  $results += [ordered]@{ key = $c.key; name = $c.name; bytesFreed = $freed; itemsRemoved = $removed; itemsFailed = $failed; outcome = $outcome }\n' +
      '}\n' +
      '$result = @{ ok = $true; results = @($results) }\n'

    const res = await runElevated(work)
    sendProgress({ view: 'cleaner', phase: 'done', message: '' })
    return res
  })

  /* --------------------------- 3. SERVICES (read) ----------------------- */

  ctx.ipcMain.handle(`${ID}:list-services`, async () => {
    const script =
      '@(Get-CimInstance Win32_Service | ForEach-Object { [ordered]@{ ' +
      'name=[string]$_.Name; displayName=[string]$_.DisplayName; state=[string]$_.State; ' +
      'startMode=[string]$_.StartMode; pathName=[string]$_.PathName; account=[string]$_.StartName } }) ' +
      '| ConvertTo-Json -Depth 3 -Compress'
    const res = await runPsJson(script, 60_000)
    if (!res.ok) return res
    const raw = Array.isArray(res.data) ? res.data : res.data ? [res.data] : []
    const winLower = WIN.toLowerCase()
    const services = raw
      .map((x) => x as Record<string, unknown>)
      .map((x) => {
        const name = typeof x.name === 'string' ? x.name : ''
        const pathName = typeof x.pathName === 'string' ? x.pathName : ''
        const expanded = pathName.replace(/^"+|"+$/g, '').toLowerCase()
        const isMicrosoft = expanded === '' || expanded.includes(winLower) || expanded.includes('\\windows\\')
        return {
          name,
          displayName: typeof x.displayName === 'string' && x.displayName ? x.displayName : name,
          state: typeof x.state === 'string' ? x.state : '',
          startMode: typeof x.startMode === 'string' ? x.startMode : '',
          account: typeof x.account === 'string' ? x.account : '',
          pathName,
          isMicrosoft,
          isProtected: PROTECTED_SERVICES.has(name.toLowerCase())
        }
      })
      .filter((s) => s.name)
      .sort((a, b) => {
        if (a.isMicrosoft !== b.isMicrosoft) return a.isMicrosoft ? 1 : -1
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
      })
    return { ok: true, services }
  })

  /* ------------------------- 3b. SERVICES (elevated) -------------------- */

  ctx.ipcMain.handle(`${ID}:set-service`, async (_e, rawArgs: unknown) => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
    const name = typeof args.name === 'string' ? args.name : ''
    const startType = typeof args.startType === 'string' ? args.startType : '' // auto|demand|disabled|''
    const stop = args.stop === true
    if (!name) return { ok: false, error: 'No service specified.' }
    if (PROTECTED_SERVICES.has(name.toLowerCase()) && (startType === 'disabled' || startType === 'demand' || stop)) {
      return { ok: false, error: `"${name}" is a protected core service and can't be weakened.` }
    }
    if (!startType && !stop) return { ok: false, error: 'Nothing to change.' }

    sendProgress({ view: 'services', phase: 'elevating', message: 'Waiting for the UAC prompt…' })
    const work =
      `$name = ${psq(name)}\n` +
      `$mode = ${psq(startType)}\n` +
      `$stop = $${stop ? 'true' : 'false'}\n` +
      '$msgs = @()\n' +
      "if ($mode -ne '') {\n" +
      "  $out = (& sc.exe config $name 'start=' $mode 2>&1 | Out-String)\n" +
      '  if ($LASTEXITCODE -ne 0) { throw ("sc.exe config failed: " + $out.Trim()) }\n' +
      '  $msgs += ("start type set to " + $mode)\n' +
      '}\n' +
      'if ($stop) {\n' +
      '  try { Stop-Service -Name $name -Force -ErrorAction Stop; $msgs += "stopped" }\n' +
      '  catch { throw ("could not stop service: " + $_.Exception.Message) }\n' +
      '}\n' +
      '$result = @{ ok = $true; message = ($msgs -join "; ") }\n'
    const res = await runElevated(work, 60_000)
    sendProgress({ view: 'services', phase: 'done', message: '' })
    return res
  })

  /* --------------------------- 4. STARTUP (read) ------------------------ */

  ctx.ipcMain.handle(`${ID}:list-startup`, async () => {
    // Registry Run keys (HKLM, WOW6432, HKCU) + startup folders + Win32_StartupCommand,
    // with StartupApproved deciding the enabled state (StartupScanner port).
    const script = String.raw`
$items = @()
$approvedBase = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved'
function Test-Approved($hive, $subkey, $name) {
  try {
    $root = if ($hive -eq 'Machine') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
    $k = $root.OpenSubKey("$approvedBase\$subkey")
    if ($k) { $d = $k.GetValue($name); if ($d -is [byte[]] -and $d.Length -gt 0) { return (($d[0] -band 0x01) -eq 0) } }
  } catch {}
  return $true
}
function Read-Run($hive, $path, $scope, $sub) {
  $root = if ($hive -eq 'Machine') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
  $k = $root.OpenSubKey($path)
  if ($null -eq $k) { return }
  foreach ($n in $k.GetValueNames()) {
    if ([string]::IsNullOrEmpty($n)) { continue }
    $script:items += [ordered]@{ name=$n; command=[string]$k.GetValue($n); source='RegistryRun'; scope=$scope; location=("$($root.Name)\$path"); approvedSubkey=$sub; approvedValueName=$n; enabled=(Test-Approved $hive $sub $n) }
  }
}
Read-Run 'Machine' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run' 'Machine' 'Run'
Read-Run 'Machine' 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' 'Machine' 'Run'
Read-Run 'User' 'SOFTWARE\Microsoft\Windows\CurrentVersion\Run' 'User' 'Run'
function Read-Folder($folder, $scope) {
  if (-not (Test-Path -LiteralPath $folder)) { return }
  foreach ($f in Get-ChildItem -LiteralPath $folder -File -ErrorAction SilentlyContinue) {
    if ($f.Name -ieq 'desktop.ini') { continue }
    $script:items += [ordered]@{ name=$f.BaseName; command=$f.FullName; source='StartupFolder'; scope=$scope; location=$folder; approvedSubkey='StartupFolder'; approvedValueName=$f.Name; enabled=(Test-Approved $scope 'StartupFolder' $f.Name) }
  }
}
Read-Folder ([Environment]::GetFolderPath('Startup')) 'User'
Read-Folder ([Environment]::GetFolderPath('CommonStartup')) 'Machine'
@{ items = @($items) } | ConvertTo-Json -Depth 4 -Compress
`
    const res = await runPsJson(script, 45_000)
    if (!res.ok) return res
    const data = res.data as Record<string, unknown>
    const raw = Array.isArray(data.items) ? data.items : []
    const items = raw
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        name: typeof x.name === 'string' ? x.name : '',
        command: typeof x.command === 'string' ? x.command : '',
        source: typeof x.source === 'string' ? x.source : '',
        scope: x.scope === 'Machine' ? 'Machine' : 'User',
        location: typeof x.location === 'string' ? x.location : '',
        approvedSubkey: typeof x.approvedSubkey === 'string' ? x.approvedSubkey : 'Run',
        approvedValueName: typeof x.approvedValueName === 'string' ? x.approvedValueName : '',
        enabled: x.enabled !== false
      }))
      .filter((i) => i.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return { ok: true, items }
  })

  /* ------------------------- 4b. STARTUP (elevated) -------------------- */

  ctx.ipcMain.handle(`${ID}:set-startup`, async (_e, rawArgs: unknown) => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
    const scope = args.scope === 'Machine' ? 'Machine' : 'User'
    const subkey = typeof args.approvedSubkey === 'string' ? args.approvedSubkey : ''
    const valueName = typeof args.approvedValueName === 'string' ? args.approvedValueName : ''
    const enabled = args.enabled === true
    if (!subkey || !valueName) return { ok: false, error: 'Malformed startup entry.' }

    sendProgress({ view: 'startup', phase: 'elevating', message: 'Waiting for the UAC prompt…' })
    const work =
      `$root = if (${psq(scope)} -eq 'Machine') { 'HKLM:' } else { 'HKCU:' }\n` +
      `$base = "$root\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\${subkey.replace(/[^A-Za-z0-9]/g, '')}"\n` +
      'if (-not (Test-Path -LiteralPath $base)) { New-Item -Path $base -Force | Out-Null }\n' +
      '$data = New-Object byte[] 12\n' +
      `if ($${enabled ? 'true' : 'false'}) { $data[0] = 0x02 } else { $data[0] = 0x03; [BitConverter]::GetBytes([int64](Get-Date).ToFileTime()).CopyTo($data,4) }\n` +
      `New-ItemProperty -Path $base -Name ${psq(valueName)} -Value ([byte[]]$data) -PropertyType Binary -Force | Out-Null\n` +
      `$result = @{ ok = $true; message = if ($${enabled ? 'true' : 'false'}) { 'enabled' } else { 'disabled' } }\n`
    const res = await runElevated(work, 60_000)
    sendProgress({ view: 'startup', phase: 'done', message: '' })
    return res
  })

  /* ------------------------ 5. INSTALLED APPS (read) ------------------- */

  ctx.ipcMain.handle(`${ID}:list-apps`, async () => {
    const script = String.raw`
$apps = @()
$hives = @(
  @{ Root='HKLM'; Path='SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Scope='Machine' },
  @{ Root='HKLM'; Path='SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; Scope='Machine' },
  @{ Root='HKCU'; Path='SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Scope='User' }
)
foreach ($h in $hives) {
  $root = if ($h.Root -eq 'HKLM') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
  $base = $root.OpenSubKey($h.Path)
  if ($null -eq $base) { continue }
  foreach ($sub in $base.GetSubKeyNames()) {
    $k = $base.OpenSubKey($sub)
    if ($null -eq $k) { continue }
    $name = [string]$k.GetValue('DisplayName')
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if (($k.GetValue('SystemComponent') -as [int]) -eq 1) { continue }
    if ($null -ne $k.GetValue('ParentKeyName')) { continue }
    if ($name -match '^(KB\d+|Security Update|Update for|Hotfix)') { continue }
    $un = [string]$k.GetValue('UninstallString')
    $qun = [string]$k.GetValue('QuietUninstallString')
    if ([string]::IsNullOrWhiteSpace($un) -and [string]::IsNullOrWhiteSpace($qun)) { continue }
    $size = 0L
    $es = $k.GetValue('EstimatedSize') -as [int]
    if ($es -gt 0) { $size = [int64]$es * 1024 }
    $apps += [ordered]@{ name=$name.Trim(); version=[string]$k.GetValue('DisplayVersion'); publisher=[string]$k.GetValue('Publisher'); installLocation=[string]$k.GetValue('InstallLocation'); uninstallString=$un; quietUninstallString=$qun; sizeBytes=$size; scope=$h.Scope; installDate=[string]$k.GetValue('InstallDate') }
  }
}
$dedup = $apps | Group-Object { "$($_.name)|$($_.version)" } | ForEach-Object { $_.Group[0] }
@{ items = @($dedup) } | ConvertTo-Json -Depth 4 -Compress
`
    const res = await runPsJson(script, 60_000)
    if (!res.ok) return res
    const data = res.data as Record<string, unknown>
    const raw = Array.isArray(data.items) ? data.items : []
    const apps = raw
      .map((x) => x as Record<string, unknown>)
      .map((x) => ({
        name: typeof x.name === 'string' ? x.name : '',
        version: typeof x.version === 'string' ? x.version : '',
        publisher: typeof x.publisher === 'string' ? x.publisher : '',
        installLocation: typeof x.installLocation === 'string' ? x.installLocation : '',
        uninstallString: typeof x.uninstallString === 'string' ? x.uninstallString : '',
        quietUninstallString: typeof x.quietUninstallString === 'string' ? x.quietUninstallString : '',
        sizeBytes: Number(x.sizeBytes) || 0,
        scope: x.scope === 'User' ? 'User' : 'Machine',
        installDate: typeof x.installDate === 'string' ? x.installDate : ''
      }))
      .filter((a) => a.name)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    return { ok: true, apps }
  })

  /* ---------------------- 5b. INSTALLED APPS (elevated) ---------------- */

  ctx.ipcMain.handle(`${ID}:uninstall-app`, async (_e, rawArgs: unknown) => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
    const name = typeof args.name === 'string' ? args.name : 'this application'
    const uninstallString = typeof args.uninstallString === 'string' ? args.uninstallString : ''
    const quietUninstallString = typeof args.quietUninstallString === 'string' ? args.quietUninstallString : ''
    const cmd = quietUninstallString || uninstallString
    if (!cmd) return { ok: false, error: 'No uninstall command is registered for this app.' }

    sendProgress({ view: 'apps', phase: 'elevating', message: 'Waiting for the UAC prompt…' })
    // Port of Uninstaller.Run: msiexec /x {GUID} for MSI products, otherwise the
    // registered uninstall command (quoted exe + tail args).
    const work =
      `$cmd = ${psq(cmd)}\n` +
      "$guid = [regex]::Match($cmd, '\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}')\n" +
      'if ($cmd -match \'msiexec\' -and $guid.Success) {\n' +
      '  $p = Start-Process -FilePath \'msiexec.exe\' -ArgumentList @(\'/x\', $guid.Value, \'/quiet\', \'/norestart\') -Wait -PassThru\n' +
      '} else {\n' +
      '  $exe = \'\'; $rest = \'\'\n' +
      '  $t = $cmd.Trim()\n' +
      '  if ($t.StartsWith(\'"\')) { $end = $t.IndexOf(\'"\', 1); if ($end -lt 0) { $exe = $t.Trim(\'"\') } else { $exe = $t.Substring(1, $end - 1); $rest = $t.Substring($end + 1).Trim() } }\n' +
      '  else { $sp = $t.IndexOf(\' \'); if ($sp -lt 0) { $exe = $t } else { $exe = $t.Substring(0, $sp); $rest = $t.Substring($sp + 1).Trim() } }\n' +
      '  if ([string]::IsNullOrWhiteSpace($exe)) { throw \'Could not parse the uninstall command.\' }\n' +
      '  if ([string]::IsNullOrWhiteSpace($rest)) { $p = Start-Process -FilePath $exe -Wait -PassThru }\n' +
      '  else { $p = Start-Process -FilePath $exe -ArgumentList $rest -Wait -PassThru }\n' +
      '}\n' +
      '$code = $p.ExitCode\n' +
      'switch ($code) {\n' +
      '  0 { $result = @{ ok = $true; message = \'Removed\' } }\n' +
      '  1605 { $result = @{ ok = $true; message = \'Already removed\' } }\n' +
      '  1641 { $result = @{ ok = $true; message = \'Removed (reboot was initiated)\' } }\n' +
      '  3010 { $result = @{ ok = $true; message = \'Removed (reboot required)\' } }\n' +
      '  1602 { $result = @{ ok = $false; error = \'Cancelled by the uninstaller.\' } }\n' +
      '  default { $result = @{ ok = $false; error = ("Uninstaller exited with code " + $code) } }\n' +
      '}\n'
    const res = await runElevated(work)
    sendProgress({ view: 'apps', phase: 'done', message: '' })
    return { ...res, name }
  })

  /* --------------------------- 6. UPDATES (read) ------------------------ */

  ctx.ipcMain.handle(`${ID}:list-updates`, async () => {
    return await new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(
          'winget.exe',
          ['upgrade', '--include-unknown', '--disable-interactivity'],
          { windowsHide: true }
        )
      } catch (err) {
        resolve({ ok: false, error: 'Could not run winget: ' + errMsg(err) })
        return
      }
      readChildren.add(child)
      let out = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* gone */
        }
      }, 120_000)
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        readChildren.delete(child)
        resolve({
          ok: false,
          error:
            'winget is not available on this machine (install "App Installer" from the Microsoft Store). ' +
            errMsg(err)
        })
      })
      child.on('close', () => {
        clearTimeout(timer)
        readChildren.delete(child)
        if (child.killed) {
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        resolve({ ok: true, updates: parseWingetUpgrades(out) })
      })
    })
  })

  /* ------------------------- 6b. UPDATES (elevated) -------------------- */

  ctx.ipcMain.handle(`${ID}:apply-updates`, async (_e, rawArgs: unknown) => {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
    const id = typeof args.id === 'string' ? args.id : ''
    const all = args.all === true || id === ''

    sendProgress({ view: 'updates', phase: 'elevating', message: 'Waiting for the UAC prompt…' })
    const argList = all
      ? "@('upgrade','--all','--include-unknown','--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity')"
      : `@('upgrade','--id',${psq(id)},'--silent','--accept-package-agreements','--accept-source-agreements','--disable-interactivity')`
    const work =
      `$argList = ${argList}\n` +
      "$p = Start-Process -FilePath 'winget.exe' -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden\n" +
      '$code = $p.ExitCode\n' +
      '$result = @{ ok = ($code -eq 0); exitCode = $code; message = if ($code -eq 0) { \'Update completed.\' } else { ("winget exited with code " + $code) } }\n' +
      'if ($code -ne 0) { $result.error = $result.message }\n'
    const res = await runElevated(work)
    sendProgress({ view: 'updates', phase: 'done', message: '' })
    return res
  })

  /* -------------------------------- CANCEL ------------------------------ */

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    let cancelled = false
    for (const c of readChildren) {
      try {
        c.kill()
        cancelled = true
      } catch {
        /* already gone */
      }
    }
    readChildren.clear()
    return { ok: true, cancelled }
  })
}

/* ---------------------- winget upgrade table parser ----------------------- *
 *  Port of UpdateService.ScanUpgrades — fixed-width columns positioned from
 *  the header row; winget's spinner uses bare \r so split on every newline. */
function parseWingetUpgrades(output: string): Array<{ name: string; id: string; current: string; available: string }> {
  const lines = output.split(/\r\n|\n|\r/)
  let hi = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.includes('Name') && l.includes('Id') && l.includes('Version') && l.includes('Available')) {
      hi = i
      break
    }
  }
  if (hi < 0) return []
  const header = lines[hi]
  const pId = header.indexOf('Id')
  const pVer = header.indexOf('Version')
  const pAvail = header.indexOf('Available')
  const pSrc = header.indexOf('Source')
  if (pId < 0 || pVer < 0 || pAvail < 0) return []

  const out: Array<{ name: string; id: string; current: string; available: string }> = []
  const seen = new Set<string>()
  for (let i = hi + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    if (l.trimStart().startsWith('-')) continue
    if (l.length < pAvail) continue
    const trim = (s: string): string => s.trim().replace(/[….]+$/, '')
    const name = trim(l.slice(0, pId))
    const id = trim(l.slice(pId, pVer))
    const current = l.slice(pVer, pAvail).trim()
    const available = (pSrc > pAvail && l.length >= pSrc ? l.slice(pAvail, pSrc) : l.slice(pAvail)).trim()
    if (!id || id.includes(' ')) continue // valid winget Ids have no spaces
    if (!name) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ name, id, current, available })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

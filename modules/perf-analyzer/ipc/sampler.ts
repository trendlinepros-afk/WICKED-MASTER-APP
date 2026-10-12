/**
 * The sampler: ONE long-lived, hidden PowerShell process that prints a block of
 * raw counters every tick — started by "Start Capture", killed by "Stop".
 * Nothing runs (and nothing is spawned) while you aren't capturing.
 *
 * It reads Windows' own performance counters through CIM, which needs no admin
 * rights and sees every process (Task Manager's data source):
 *   - Win32_PerfRawData_PerfProc_Process  → per-process CPU time, private
 *     working set, I/O bytes (raw cumulative values; deltas are taken in Node)
 *   - …GPUPerformanceCounters_GPUEngine    → per-process GPU engine use
 *   - …GPUPerformanceCounters_GPUAdapterMemory → dedicated GPU memory in use
 *   - Win32_PerfFormattedData_PerfDisk_PhysicalDisk (_Total) → disk active / MB/s
 *   - …Counters_ThermalZoneInformation     → ACPI thermal zone (°C), if the PC exposes one
 * New exe names get a one-time lookup (description, company, signature).
 *
 * Line protocol (tab separated), one block per tick:
 *   S <Timestamp_Sys100NS>
 *   P <pid> <cpu100ns> <wsPrivate> <ioBytes> <instance name>
 *   GOK | G <util%> <engine instance>      GM <dedicated bytes>
 *   D <idle%> <readB/s> <writeB/s>         T <°C>
 *   M <name> <description> <company> <signature> <path>
 *   E
 */
import { spawn, type ChildProcess } from 'child_process'
import { parseBlock, type RawSnapshot } from '../lib/compute'

export function samplerScript(intervalMs: number): string {
  // «t» / «n» → PowerShell's `t / `n (a backtick can't sit inside this template)
  return String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$interval = ${Math.max(500, Math.round(intervalMs))}
$seen = @{}
$out = [Console]::Out
function Clean($s) { if ($s) { ("$s" -replace "[\t\r\n]", ' ').Trim() } else { '' } }
while ($true) {
  $tick = [Diagnostics.Stopwatch]::StartNew()
  $sb = New-Object Text.StringBuilder
  $procs = @(Get-CimInstance -ClassName Win32_PerfRawData_PerfProc_Process -Property Name,IDProcess,PercentProcessorTime,WorkingSetPrivate,IODataBytesPersec,Timestamp_Sys100NS)
  $ts = 0
  if ($procs.Count -gt 0) { $ts = $procs[0].Timestamp_Sys100NS }
  [void]$sb.Append("S«t»$ts«n»")
  foreach ($p in $procs) { [void]$sb.Append("P«t»$($p.IDProcess)«t»$($p.PercentProcessorTime)«t»$($p.WorkingSetPrivate)«t»$($p.IODataBytesPersec)«t»$($p.Name)«n»") }
  try {
    $eng = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Property Name,UtilizationPercentage -ErrorAction Stop)
    [void]$sb.Append("GOK«n»")
    foreach ($e in $eng) { if ($e.UtilizationPercentage -gt 0) { [void]$sb.Append("G«t»$($e.UtilizationPercentage)«t»$($e.Name)«n»") } }
  } catch {}
  try {
    $gm = [uint64]0
    foreach ($a in @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -Property DedicatedUsage -ErrorAction Stop)) { $gm += [uint64]$a.DedicatedUsage }
    [void]$sb.Append("GM«t»$gm«n»")
  } catch {}
  try {
    $d = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -Property PercentIdleTime,DiskReadBytesPersec,DiskWriteBytesPersec -ErrorAction Stop | Select-Object -First 1
    if ($d) { [void]$sb.Append("D«t»$($d.PercentIdleTime)«t»$($d.DiskReadBytesPersec)«t»$($d.DiskWriteBytesPersec)«n»") }
  } catch {}
  try {
    $max = 0
    foreach ($z in @(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -Property HighPrecisionTemperature,Temperature -ErrorAction Stop)) {
      $k = 0
      if ($z.HighPrecisionTemperature) { $k = $z.HighPrecisionTemperature / 10 } elseif ($z.Temperature) { $k = $z.Temperature }
      if ($k -gt $max) { $max = $k }
    }
    if ($max -gt 200) { [void]$sb.Append("T«t»$([math]::Round($max - 273.15, 1))«n»") }
  } catch {}
  $n = 0
  foreach ($p in $procs) {
    if ($n -ge 4) { break }
    $base = ("$($p.Name)" -replace '#\d+$', '')
    $key = $base.ToLower()
    if ($base -eq '_Total' -or $base -eq 'Idle' -or $seen.ContainsKey($key)) { continue }
    $seen[$key] = 1
    $n++
    $path = ''; $desc = ''; $co = ''; $sig = 'unknown'
    try { $path = (Get-Process -Id $p.IDProcess -ErrorAction Stop).Path } catch {}
    if (-not $path) { try { $path = (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($p.IDProcess)" -Property ExecutablePath -ErrorAction Stop).ExecutablePath } catch {} }
    if ($path) {
      try { $vi = [Diagnostics.FileVersionInfo]::GetVersionInfo($path); $desc = $vi.FileDescription; $co = $vi.CompanyName } catch {}
      try {
        if ((Get-Item -LiteralPath $path -ErrorAction Stop).Length -lt 64MB) {
          $st = "$((Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop).Status)"
          if ($st -eq 'Valid') { $sig = 'valid' } elseif ($st -eq 'NotSigned') { $sig = 'unsigned' } elseif ($st) { $sig = $st.ToLower() }
        }
      } catch {}
    }
    [void]$sb.Append("M«t»$base«t»$(Clean $desc)«t»$(Clean $co)«t»$sig«t»$(Clean $path)«n»")
  }
  [void]$sb.Append("E«n»")
  $out.Write($sb.ToString())
  $out.Flush()
  $left = $interval - $tick.ElapsedMilliseconds
  if ($left -gt 10) { Start-Sleep -Milliseconds ([int]$left) }
}
`
    .replace(/«t»/g, '`t')
    .replace(/«n»/g, '`n')
}

export interface SamplerHandlers {
  onSnapshot: (s: RawSnapshot) => void
  /** the sampler died on its own (not via stop()) */
  onExit: (error: string) => void
}

export class Sampler {
  private child: ChildProcess | null = null
  private buf = ''
  private block: string[] | null = null
  private stopping = false
  private errTail = ''

  constructor(private h: SamplerHandlers) {}

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get running(): boolean {
    return !!this.child
  }

  start(intervalMs: number): void {
    if (this.child) return
    this.stopping = false
    // tests (Linux) point this at a fake that prints the same protocol
    const fake = process.env.WICKED_PERF_SAMPLER
    const child = fake
      ? spawn(process.execPath, [fake, String(intervalMs)], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      : spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(samplerScript(intervalMs), 'utf16le').toString('base64')], { windowsHide: true })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.feed(d))
    child.stderr?.on('data', (d: Buffer) => {
      this.errTail = (this.errTail + d.toString()).slice(-800)
    })
    const done = (msg: string): void => {
      if (this.child !== child) return
      this.child = null
      if (!this.stopping) this.h.onExit(msg)
    }
    child.on('error', (err) => done(`Couldn’t start the sampler: ${err.message}`))
    child.on('close', (code) => done(`The sampler stopped (exit ${code ?? '?'})${this.errTail.trim() ? `: ${this.errTail.trim().slice(-300)}` : ''}`))
  }

  stop(): void {
    this.stopping = true
    const c = this.child
    this.child = null
    this.buf = ''
    this.block = null
    try {
      c?.kill()
    } catch {
      /* already gone */
    }
  }

  private feed(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      if (line.startsWith('S\t')) this.block = [line]
      else if (line === 'E') {
        if (this.block) {
          try {
            this.h.onSnapshot(parseBlock(this.block))
          } catch {
            /* a bad block is skipped */
          }
        }
        this.block = null
      } else if (this.block) this.block.push(line)
    }
    if (this.buf.length > 4_000_000) this.buf = '' // never grow without bound
  }
}

import { spawn, type ChildProcess } from 'child_process'
import { writeFile } from 'fs/promises'
import type { ModuleIpcContext } from '../../src/main/module-ipc'

const ID = 'event-viewer'

/* ------------------------------------------------------------------------ *
 *  Mirrors of the standalone app's Config.cs.
 *  The original baked a hardcoded API key into the exe — that key was
 *  deliberately NOT carried over. The key comes from the shell's central
 *  API key vault (Settings → API Keys) via ctx.getApiKey('deepseek'),
 *  read at call time and never forwarded to the renderer.
 * ------------------------------------------------------------------------ */
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'
const MAX_RESPONSE_TOKENS = 6000 // Config.MaxResponseTokens
const HTTP_TIMEOUT_MS = 300_000 // Config.HttpTimeoutSeconds = 300
const MAX_SAMPLES_PER_GROUP = 2 // Config.MaxSamplesPerGroup
const MAX_SAMPLE_MESSAGE_CHARS = 600 // Config.MaxSampleMessageChars

/** "Audit Failure" keywords bit for the Security log (0x0010000000000000). */
const AUDIT_FAILURE_KEYWORD = '4503599627370496'

/**
 * Safety cap the original app did not have: read at most this many events
 * per log (Get-WinEvent returns newest first, so the newest N are kept).
 * Keeps the PowerShell JSON payload bounded; a warning is surfaced when hit.
 */
const MAX_EVENTS_PER_LOG = 10_000

const ALLOWED_LOGS = new Set(['Application', 'System', 'Security', 'Setup'])
const ALLOWED_LEVELS = new Set([1, 2, 3, 4])

interface CollectRequest {
  logs: string[]
  levels: number[]
  fromIso: string
  toIso: string
}

interface GroupOut {
  log: string
  provider: string
  eventId: number
  level: number
  count: number
  firstSeen: string | null
  lastSeen: string | null
  samples: string[]
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/* ----------------------------- small helpers ----------------------------- */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v === null || v === undefined) return []
  return [v]
}

function toStringArray(v: unknown): string[] {
  return toArray(v).filter((x): x is string => typeof x === 'string')
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function parseCollectRequest(raw: unknown): CollectRequest | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'Malformed collect request.' }
  const r = raw as Record<string, unknown>
  const logs = Array.isArray(r.logs)
    ? r.logs.filter((l): l is string => typeof l === 'string' && ALLOWED_LOGS.has(l))
    : []
  const levels = Array.isArray(r.levels)
    ? r.levels.filter((l): l is number => typeof l === 'number' && ALLOWED_LEVELS.has(l))
    : []
  if (logs.length === 0) return { error: 'Select at least one log to analyse.' }
  // Same rule as the original: levels are required unless only the Security
  // log (which is filtered by audit-failure keyword, not level) is selected.
  if (levels.length === 0 && !(logs.length === 1 && logs[0] === 'Security'))
    return { error: 'Select at least one event level (Critical / Error / Warning / Information).' }
  const from = new Date(typeof r.fromIso === 'string' ? r.fromIso : NaN)
  const to = new Date(typeof r.toIso === 'string' ? r.toIso : NaN)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
    return { error: 'Invalid time range.' }
  if (from.getTime() >= to.getTime())
    return { error: "The 'From' time must be before the 'To' time." }
  // Re-serialised ISO strings + whitelisted logs/levels means every value
  // interpolated into the PowerShell script below is machine-generated.
  return { logs, levels, fromIso: from.toISOString(), toIso: to.toISOString() }
}

function normalizeGroup(raw: unknown): GroupOut | null {
  if (typeof raw !== 'object' || raw === null) return null
  const g = raw as Record<string, unknown>
  return {
    log: str(g.log, '(unknown log)'),
    provider: str(g.provider, '(unknown provider)'),
    eventId: typeof g.eventId === 'number' ? g.eventId : 0,
    level: typeof g.level === 'number' ? g.level : 0,
    count: typeof g.count === 'number' ? g.count : 0,
    firstSeen: typeof g.firstSeen === 'string' ? g.firstSeen : null,
    lastSeen: typeof g.lastSeen === 'string' ? g.lastSeen : null,
    samples: toStringArray(g.samples)
  }
}

/**
 * Builds the PowerShell collection script. Faithful port of
 * EventCollector.Collect/ReadLog/GetMessage: per-log Get-WinEvent with a
 * FilterHashtable (Security = audit-failure keyword, others = level filter),
 * de-duplication into log|provider|id|level groups, first/last-seen tracking
 * and up to two whitespace-collapsed 600-char sample messages per group with
 * a raw-properties fallback when the provider can't format the message.
 */
function buildCollectScript(req: CollectRequest): string {
  const logsPs = req.logs.map((l) => `'${l}'`).join(',')
  const levelsPs = req.levels.join(',')
  return String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$rk = [System.Globalization.DateTimeStyles]::RoundtripKind
$from = [DateTime]::Parse('${req.fromIso}', $inv, $rk).ToLocalTime()
$to = [DateTime]::Parse('${req.toIso}', $inv, $rk).ToLocalTime()
$logs = @(${logsPs})
$levels = @(${levelsPs})
$cap = ${MAX_EVENTS_PER_LOG}
$groups = @{}
$totalEvents = 0
$warnings = New-Object System.Collections.Generic.List[string]
$truncatedLogs = New-Object System.Collections.Generic.List[string]

foreach ($log in $logs) {
    [Console]::Error.WriteLine('PROGRESS: Reading ' + $log + ' log...')
    $filter = @{ LogName = $log; StartTime = $from; EndTime = $to }
    if ($log -eq 'Security') {
        # The Security log logs almost everything at level Information, so a
        # level filter would hide the interesting entries; pull audit failures.
        $filter['Keywords'] = ${AUDIT_FAILURE_KEYWORD}
    } else {
        $filter['Level'] = $levels
    }
    try {
        $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents $cap -ErrorAction Stop)
        if ($events.Count -ge $cap) { [void]$truncatedLogs.Add($log) }
        foreach ($e in $events) {
            $provider = $e.ProviderName
            if ([string]::IsNullOrEmpty($provider)) { $provider = '(unknown provider)' }
            $lvl = 0
            if ($null -ne $e.Level) { $lvl = [int]$e.Level }
            $key = $e.LogName + '|' + $provider + '|' + $e.Id + '|' + $lvl
            $g = $groups[$key]
            if ($null -eq $g) {
                $g = [pscustomobject]@{
                    log = $e.LogName
                    provider = $provider
                    eventId = $e.Id
                    level = $lvl
                    count = 0
                    firstSeen = $null
                    lastSeen = $null
                    samples = (New-Object System.Collections.Generic.List[string])
                }
                $groups[$key] = $g
            }
            if ($e.TimeCreated) {
                $t = $e.TimeCreated.ToUniversalTime().ToString('o')
                if ($null -eq $g.firstSeen -or $t -lt $g.firstSeen) { $g.firstSeen = $t }
                if ($null -eq $g.lastSeen -or $t -gt $g.lastSeen) { $g.lastSeen = $t }
            }
            $g.count++
            $totalEvents++
            # Formatting the message is the slow part, so only do it while we
            # still need sample text for this group (same as the original).
            if ($g.samples.Count -lt ${MAX_SAMPLES_PER_GROUP}) {
                $m = $null
                try { $m = $e.Message } catch { $m = $null }
                if ([string]::IsNullOrWhiteSpace($m)) {
                    try {
                        $parts = @($e.Properties | ForEach-Object { if ($null -ne $_.Value) { [string]$_.Value } } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                        if ($parts.Count -gt 0) { $m = 'Raw event data: ' + ($parts -join ' | ') }
                    } catch { $m = $null }
                }
                if (-not [string]::IsNullOrWhiteSpace($m)) {
                    $m = ($m -replace '\s+', ' ').Trim()
                    if ($m.Length -gt ${MAX_SAMPLE_MESSAGE_CHARS}) { $m = $m.Substring(0, ${MAX_SAMPLE_MESSAGE_CHARS}) + [char]0x2026 }
                    if (-not $g.samples.Contains($m)) { [void]$g.samples.Add($m) }
                }
            }
        }
    } catch {
        $msg = $_.Exception.Message
        $name = $_.Exception.GetType().Name
        if ($msg -match 'No events were found') {
            # nothing matched in this log; not an error
        } elseif ($name -eq 'UnauthorizedAccessException' -or $msg -match 'unauthorized|access is denied') {
            [void]$warnings.Add('Could not read the ' + $log + ' log: access denied. Windows only lets administrators read it, so it was skipped (WICKED never runs elevated).')
        } elseif ($name -eq 'EventLogNotFoundException' -or $msg -match 'There is not an event log|does not exist') {
            [void]$warnings.Add('The ' + $log + ' log was not found on this machine.')
        } else {
            [void]$warnings.Add('Could not read the ' + $log + ' log: ' + $msg)
        }
    }
}

$result = @{
    groups = @($groups.Values)
    totalEvents = $totalEvents
    warnings = $warnings
    truncatedLogs = $truncatedLogs
    machine = $env:COMPUTERNAME
    os = [System.Environment]::OSVersion.VersionString
}
ConvertTo-Json -InputObject $result -Compress -Depth 6
`
}

function parseMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: ChatMessage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const m = item as Record<string, unknown>
    if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') return null
    if (typeof m.content !== 'string') return null
    out.push({ role: m.role, content: m.content })
  }
  return out
}

/* --------------------------------- register ------------------------------ */

export default function register(ctx: ModuleIpcContext): void {
  let collectChild: ChildProcess | null = null
  let aiAbort: AbortController | null = null

  /* ---- collection ---- */

  ctx.ipcMain.handle(`${ID}:collect`, async (_event, rawReq: unknown) => {
    if (collectChild) return { ok: false, error: 'A collection is already running.' }
    const req = parseCollectRequest(rawReq)
    if ('error' in req) return { ok: false, error: req.error }

    const script = buildCollectScript(req)
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    return await new Promise((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true }
        )
      } catch (err) {
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
        return
      }
      collectChild = child

      let out = ''
      let errText = ''
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (line.startsWith('PROGRESS:')) {
            ctx
              .getMainWindow()
              ?.webContents.send(`${ID}:progress`, line.slice('PROGRESS:'.length).trim())
          } else if (line.trim()) {
            errText += line + '\n'
          }
        }
      })
      child.on('error', (err) => {
        collectChild = null
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
      })
      child.on('close', (code) => {
        collectChild = null
        if (child.killed) {
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        const jsonStart = out.indexOf('{')
        if (jsonStart < 0) {
          const detail = (errText || out || `exit code ${code}`).trim().slice(0, 600)
          resolve({ ok: false, error: 'Event collection returned no data. ' + detail })
          return
        }
        try {
          const parsed = JSON.parse(out.slice(jsonStart)) as Record<string, unknown>
          resolve({
            ok: true,
            groups: toArray(parsed.groups)
              .map(normalizeGroup)
              .filter((g): g is GroupOut => g !== null),
            totalEvents: typeof parsed.totalEvents === 'number' ? parsed.totalEvents : 0,
            warnings: toStringArray(parsed.warnings),
            truncatedLogs: toStringArray(parsed.truncatedLogs),
            machine: str(parsed.machine, 'unknown machine'),
            os: str(parsed.os, 'Microsoft Windows')
          })
        } catch (err) {
          resolve({ ok: false, error: 'Could not parse the event collection output: ' + errMsg(err) })
        }
      })
    })
  })

  /* ---- AI completion (one exchange of the multi-turn chat session) ---- */

  ctx.ipcMain.handle(`${ID}:ai-complete`, async (_event, rawMessages: unknown) => {
    const messages = parseMessages(rawMessages)
    if (!messages) return { ok: false, error: 'Malformed chat messages.' }
    if (aiAbort) return { ok: false, error: 'An analysis request is already running.' }

    // Central vault, read at call time; the value never reaches the renderer.
    const key = ctx.getApiKey('deepseek')
    if (!key)
      return {
        ok: false,
        error: 'No DeepSeek API key is set. Add one under Settings → API Keys.'
      }

    const controller = new AbortController()
    aiAbort = controller
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      // Same request shape as AiClient.CompleteAsync in the original.
      let resp: Response
      try {
        resp = await fetch(DEEPSEEK_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages,
            temperature: 0.3,
            max_tokens: MAX_RESPONSE_TOKENS,
            stream: false
          }),
          signal: controller.signal
        })
      } catch (err) {
        if (controller.signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' }
        return {
          ok: false,
          error: `Could not reach the analysis service. Check the internet connection. (${errMsg(err)})`
        }
      }

      const body = await resp.text()
      if (!resp.ok) {
        const snippet = body.length > 600 ? body.slice(0, 600) + '…' : body
        return {
          ok: false,
          error: `Analysis service error ${resp.status} ${resp.statusText}: ${snippet}`
        }
      }

      try {
        const parsed = JSON.parse(body) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const content = parsed.choices?.[0]?.message?.content
        if (typeof content !== 'string' || content.length === 0)
          return { ok: false, error: 'The analysis service returned an empty response.' }
        return { ok: true, content }
      } catch (err) {
        return { ok: false, error: 'Could not parse the analysis service response: ' + errMsg(err) }
      }
    } finally {
      clearTimeout(timer)
      aiAbort = null
    }
  })

  /* ---- cancellation (collection child process + in-flight AI request) ---- */

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    let cancelled = false
    if (collectChild) {
      collectChild.kill()
      cancelled = true
    }
    if (aiAbort) {
      aiAbort.abort()
      cancelled = true
    }
    return { ok: true, cancelled }
  })

  /* ---- export report ---- */

  ctx.ipcMain.handle(`${ID}:export-report`, async (_event, rawMarkdown: unknown) => {
    if (typeof rawMarkdown !== 'string' || rawMarkdown.length === 0)
      return { ok: false, error: 'There is no report to save yet.' }
    const win = ctx.getMainWindow()
    if (!win) return { ok: false, error: 'No application window available.' }

    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`

    const res = await ctx.dialog.showSaveDialog(win, {
      title: 'Save health report',
      defaultPath: `event-report-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      await writeFile(res.filePath, rawMarkdown, 'utf8')
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: 'Could not save the report: ' + errMsg(err) }
    }
  })
}

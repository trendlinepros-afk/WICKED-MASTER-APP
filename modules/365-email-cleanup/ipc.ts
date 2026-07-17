import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'

/* ------------------------------------------------------------------------ *
 *  365 EMAIL CLEANUP — in-app module (no external process).
 *
 *  Reimplements the standalone "Inbox Cleanup" (C#/.NET 8 WPF, Outlook COM)
 *  entirely inside WICKED. All Outlook work is done by spawning PowerShell from
 *  the Node main process, exactly like the event-viewer module: each operation
 *  is one `powershell.exe` invocation that drives classic Outlook through
 *  `New-Object -ComObject Outlook.Application` and returns a single JSON blob.
 *
 *  The original's Ed25519 licensing / activation / EULA is deliberately NOT
 *  ported — there is no licensing anywhere in this module.
 *
 *  AI reply drafting (AiDraftService.cs) is reimplemented with the central key
 *  vault: ctx.getApiKey('gemini') first, then ctx.getApiKey('deepseek') — the
 *  same order the original used. Keys are read at call time and never sent to
 *  the renderer.
 * ------------------------------------------------------------------------ */

const ID = '365-email-cleanup'
const ROUTES_KEY = `${ID}.routes`
const UNDO_KEY = `${ID}.undoHistory`

/** Cap the inbox scan so the JSON payload stays bounded (original used 500). */
const DEFAULT_SCAN_LIMIT = 500
const MAX_SCAN_LIMIT = 2000
const AI_TIMEOUT_MS = 45_000 // AiDraftService HttpClient timeout
const AI_BODY_CAP = 6000 // AiDraftService prompt body cap
const MAX_UNDO_BATCHES = 25 // UndoLog.MaxBatches

/* --------------------------------- types --------------------------------- */

interface MoveRecord {
  movedEntryId: string
  uncertain: boolean
  originalFolderEntryId: string
  originalFolderStoreId: string
  targetFolderEntryId: string
  targetFolderStoreId: string
  messageId: string
  senderLabel: string
  subject: string
  targetFolderName: string
}

interface MoveBatch {
  createdUtc: string
  records: MoveRecord[]
}

interface RouteData {
  emails: Record<string, string>
  domains: Record<string, string>
  subjects: Record<string, string>
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

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function normalizeRoutes(raw: unknown): RouteData {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const rec = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {}
    if (typeof v === 'object' && v !== null)
      for (const [k, val] of Object.entries(v as Record<string, unknown>))
        if (typeof val === 'string') out[k] = val
    return out
  }
  return { emails: rec(r.emails), domains: rec(r.domains), subjects: rec(r.subjects) }
}

function normalizeRecord(raw: unknown): MoveRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  return {
    movedEntryId: str(r.movedEntryId),
    uncertain: r.uncertain === true,
    originalFolderEntryId: str(r.originalFolderEntryId),
    originalFolderStoreId: str(r.originalFolderStoreId),
    targetFolderEntryId: str(r.targetFolderEntryId),
    targetFolderStoreId: str(r.targetFolderStoreId),
    messageId: str(r.messageId),
    senderLabel: str(r.senderLabel),
    subject: str(r.subject),
    targetFolderName: str(r.targetFolderName)
  }
}

/* ---------------- legacy rules import (standalone Inbox Cleanup) --------- */

/**
 * The old standalone "Inbox Cleanup" app kept its learned rules in
 * %LOCALAPPDATA%\InboxCleanup (a JSON file named `routes`, plus backups).
 * Those rules never transferred to this module, which stores routes in the
 * shell's shared store. This block finds and parses the old files so the user
 * can import them with one click — no manual file copying, since the module's
 * format/location differs from the old app's.
 *
 * The parser is deliberately SCHEMA-TOLERANT: the exact C# serialization shape
 * isn't guaranteed, so it accepts container keys in any casing
 * (Emails/emails, Domains, Subjects…), rule lists as maps or as
 * {entry,target}-style object arrays, a {routes:{…}} wrapper, or a bare
 * entry→folder map (classified by whether the key looks like an address or
 * domain). Unrecognized content imports zero rules rather than erroring.
 */

const LEGACY_RULE_FILENAMES = [
  'routes',
  'routes.json',
  'routes.recovered-full',
  'routes.json.bak',
  'routes.json.shrunk-backup'
]
const LEGACY_MAX_FILE_BYTES = 4 * 1024 * 1024

interface LegacyRules {
  emails: Record<string, string>
  domains: Record<string, string>
  subjects: Record<string, string>
  total: number
}

function legacyRulesDirs(): string[] {
  const dirs: string[] = []
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'InboxCleanup'))
  dirs.push(join(homedir(), 'AppData', 'Local', 'InboxCleanup'))
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'InboxCleanup'))
  return [...new Set(dirs.map((d) => resolve(d)))]
}

/** "" / "inbox" / "keep in inbox" variants all mean keep-in-inbox (our ""). */
function normLegacyTarget(v: unknown): string | null {
  if (v === null) return ''
  if (typeof v !== 'string') return null
  const t = v.trim()
  const low = t.toLowerCase()
  if (!t || low === 'inbox' || low === '(inbox)' || low === 'keep in inbox' || low === '(keep in inbox)')
    return ''
  return t
}

/** Extract [entry, target] pairs from a rules container (map or object list). */
function legacyPairs(v: unknown): [string, string][] {
  const out: [string, string][] = []
  if (Array.isArray(v)) {
    const ENTRY_KEYS = ['entry', 'key', 'email', 'address', 'sender', 'domain', 'pattern', 'subject', 'match', 'from']
    const TARGET_KEYS = ['target', 'folder', 'foldername', 'destination', 'dest', 'value', 'to']
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      const keys = Object.keys(r)
      const ek = keys.find((k) => ENTRY_KEYS.includes(k.toLowerCase()))
      const tk = keys.find((k) => TARGET_KEYS.includes(k.toLowerCase()))
      const entry = ek ? r[ek] : undefined
      const target = tk === undefined ? null : normLegacyTarget(r[tk])
      if (typeof entry === 'string' && entry.trim() && target !== null) out.push([entry, target])
    }
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const target = normLegacyTarget(val)
      if (k.trim() && target !== null) out.push([k, target])
    }
  }
  return out
}

/** File an address-or-domain entry into the right bucket (mirrors addRoute). */
function legacyAddSender(out: LegacyRules, rawEntry: string, target: string): void {
  let e = rawEntry.trim().toLowerCase()
  let domainOnly = false
  if (e.startsWith('*@')) {
    e = e.slice(2)
    domainOnly = true
  } else if (e.startsWith('@')) {
    e = e.slice(1)
    domainOnly = true
  } else if (!e.includes('@')) {
    domainOnly = true
  }
  if (!e) return
  if (domainOnly) out.domains[e] = target
  else out.emails[e] = target
}

function parseLegacyRules(text: string): LegacyRules | null {
  let doc: unknown
  try {
    // strip a UTF-8 BOM (C#'s File.WriteAllText writes one)
    doc = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  const out: LegacyRules = { emails: {}, domains: {}, subjects: {}, total: 0 }

  const findKey = (obj: Record<string, unknown>, names: string[]): unknown => {
    const hit = Object.keys(obj).find((k) => names.includes(k.toLowerCase()))
    return hit === undefined ? undefined : obj[hit]
  }

  const ingest = (node: unknown, depth: number): void => {
    if (depth > 3 || typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const [entry, target] of legacyPairs(node)) legacyAddSender(out, entry, target)
      return
    }
    const obj = node as Record<string, unknown>
    const emailsNode = findKey(obj, ['emails', 'email', 'emailroutes', 'senders', 'senderroutes', 'addresses'])
    const domainsNode = findKey(obj, ['domains', 'domain', 'domainroutes'])
    const subjectsNode = findKey(obj, ['subjects', 'subject', 'subjectrules', 'subjectroutes', 'subjectpatterns'])
    if (emailsNode !== undefined || domainsNode !== undefined || subjectsNode !== undefined) {
      for (const [k, t] of legacyPairs(emailsNode)) {
        const e = k.trim().toLowerCase()
        if (e) out.emails[e] = t
      }
      for (const [k, t] of legacyPairs(domainsNode)) {
        let d = k.trim().toLowerCase()
        if (d.startsWith('*@')) d = d.slice(2)
        if (d.startsWith('@')) d = d.slice(1)
        if (d) out.domains[d] = t
      }
      for (const [k, t] of legacyPairs(subjectsNode)) {
        const s = k.trim()
        if (s.length >= 3) out.subjects[s] = t
      }
      return
    }
    const wrapper = findKey(obj, ['routes', 'rules', 'data'])
    if (wrapper !== undefined) {
      ingest(wrapper, depth + 1)
      return
    }
    // Bare entry→folder map: address/domain-looking keys are sender rules,
    // anything else a subject pattern. Only trusted when at least one key
    // actually looks like an address/domain — otherwise this is some other
    // app's JSON (settings, license log), not rules, and we import nothing.
    const pairs = legacyPairs(obj)
    const senderish = (k: string): boolean => k.includes('@') || /^[\w-]+(\.[\w-]+)+$/.test(k)
    if (!pairs.some(([k]) => senderish(k.trim()))) return
    for (const [k, t] of pairs) {
      const key = k.trim()
      if (!key) continue
      if (senderish(key)) legacyAddSender(out, key, t)
      else if (key.length >= 3) out.subjects[key] = t
    }
  }

  ingest(doc, 0)
  out.total =
    Object.keys(out.emails).length + Object.keys(out.domains).length + Object.keys(out.subjects).length
  return out.total > 0 ? out : null
}

interface LegacyCandidate {
  file: string
  emails: number
  domains: number
  subjects: number
  total: number
}

function readLegacyFile(file: string): LegacyRules | null {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return null
    if (statSync(file).size > LEGACY_MAX_FILE_BYTES) return null
    return parseLegacyRules(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function scanLegacyRules(extraFile?: string): LegacyCandidate[] {
  const seen = new Set<string>()
  const candidates: LegacyCandidate[] = []
  const consider = (file: string): void => {
    const key = resolve(file).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const parsed = readLegacyFile(file)
    if (parsed)
      candidates.push({
        file,
        emails: Object.keys(parsed.emails).length,
        domains: Object.keys(parsed.domains).length,
        subjects: Object.keys(parsed.subjects).length,
        total: parsed.total
      })
  }
  if (extraFile) consider(extraFile)
  // `routes` (the live file) is checked before the backups in each dir.
  for (const dir of legacyRulesDirs()) for (const name of LEGACY_RULE_FILENAMES) consider(join(dir, name))
  return candidates
}

/* --------------------------- PowerShell / Outlook ------------------------ */

/**
 * Shared prelude: attach to the running (or a new) classic Outlook instance
 * under the current user, open the MAPI session, and define the COM helpers
 * that mirror OutlookService.cs (SMTP resolution, unsubscribe detection). The
 * caller-supplied payload is passed as a base64 JSON literal so no user data is
 * ever interpolated straight into the script.
 */
function outlookPrelude(payload: unknown): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload ?? {}), 'utf8').toString('base64')
  return String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
function Emit($o) { ConvertTo-Json -Compress -Depth 6 -InputObject $o }
function Fail($msg) { Emit(@{ ok = $false; error = [string]$msg }); exit 0 }
function Progress($m) { [Console]::Error.WriteLine('PROGRESS: ' + $m) }
function SafeStr($sb) { try { $v = & $sb; if ($null -eq $v) { '' } else { [string]$v } } catch { '' } }
function Release($o) { try { if ($null -ne $o) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } } catch { } }

$payload = @{}
try { $payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payloadB64}')) | ConvertFrom-Json } catch { }

$PR_SMTP  = 'http://schemas.microsoft.com/mapi/proptag/0x39FE001E'
$PR_MSGID = 'http://schemas.microsoft.com/mapi/proptag/0x1035001E'
$PR_HDR_W = 'http://schemas.microsoft.com/mapi/proptag/0x007D001F'
$PR_HDR_A = 'http://schemas.microsoft.com/mapi/proptag/0x007D001E'
$olFolderInbox = 6
$olMail = 43

function ResolveSmtp($item) {
    $addr = SafeStr { $item.SenderEmailAddress }
    $type = SafeStr { $item.SenderEmailType }
    $isEx = ($type -ieq 'EX') -or $addr.ToUpperInvariant().StartsWith('/O=')
    if (-not $isEx) { return $addr }
    $p = SafeStr { $item.PropertyAccessor.GetProperty($PR_SMTP) }
    if ($p) { return $p }
    $e = SafeStr { $item.Sender.GetExchangeUser().PrimarySmtpAddress }
    if ($e) { return $e }
    return $addr
}
function HasUnsub($item) {
    $h = SafeStr { $item.PropertyAccessor.GetProperty($PR_HDR_W) }
    if (-not $h) { $h = SafeStr { $item.PropertyAccessor.GetProperty($PR_HDR_A) } }
    if (-not $h) { return $false }
    return ($h -match 'List-Unsubscribe') -or ($h -match 'Precedence:\s*bulk')
}
# Recursively collect inbox subfolders as backslash-joined relative paths
# ("Clients", "Clients\Acme") so nested folders show up too — the original
# only ever filed under the inbox, so top-level names are unchanged.
function WalkFolders($folder, $prefix, $depth, $names) {
    if ($depth -gt 6) { return }
    $subs = $folder.Folders
    $c = 0
    try { $c = [int]$subs.Count } catch { $c = 0 }
    for ($i = 1; $i -le $c; $i++) {
        $f = $null
        try {
            $f = $subs.Item($i)
            $nm = [string]$f.Name
            $p = if ($prefix) { $prefix + '\' + $nm } else { $nm }
            [void]$names.Add($p)
            WalkFolders $f $p ($depth + 1) $names
        } catch { } finally { Release $f }
    }
    Release $subs
}
function ListSubfolders($ns) {
    $inbox = $ns.GetDefaultFolder($olFolderInbox)
    $names = New-Object System.Collections.ArrayList
    WalkFolders $inbox '' 0 $names
    Release $inbox
    $arr = @($names) | Sort-Object
    return ,@($arr)
}
# Resolve (creating as needed) a folder given a backslash path relative to the
# inbox, e.g. "Clients" or "Clients\Acme". A bare name resolves under the inbox,
# exactly as before.
function EnsureFolder($ns, $name) {
    $inbox = $ns.GetDefaultFolder($olFolderInbox)
    $parts = @(([string]$name).Split([char]0x5C) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    if ($parts.Count -eq 0) { return $inbox }
    $current = $inbox
    foreach ($part in $parts) {
        $fs = $current.Folders
        $c = 0
        try { $c = [int]$fs.Count } catch { $c = 0 }
        $found = $null
        for ($i = 1; $i -le $c; $i++) {
            $f = $fs.Item($i)
            if (([string]$f.Name) -ieq $part) { $found = $f; break }
            Release $f
        }
        if ($null -eq $found) { $found = $fs.Add($part) }
        Release $fs
        $current = $found
    }
    return $current
}
function FindByMsgId($ns, $folderEntry, $folderStore, $msgId) {
    if (-not $folderEntry -or -not $msgId) { return $null }
    $folder = $null; $items = $null; $restricted = $null
    try {
        $folder = $ns.GetFolderFromID($folderEntry, $folderStore)
        $items = $folder.Items
        $esc = $msgId.Replace("'", "''")
        $filter = '@SQL="' + $PR_MSGID + '" = ''' + $esc + ''''
        $restricted = $items.Restrict($filter)
        if ([int]$restricted.Count -gt 0) { return $restricted.Item(1) }
        return $null
    } catch { return $null }
    finally { Release $restricted; Release $items; Release $folder }
}

try { $app = New-Object -ComObject Outlook.Application } catch {
    Fail('Classic Outlook is not available. This module drives the classic Outlook desktop app over COM automation; the "new Outlook" app and webmail are not supported. Make sure classic Outlook is installed and can start under your account.')
}
try { $ns = $app.GetNamespace('MAPI') } catch {
    Fail('Could not open the Outlook MAPI session: ' + $_.Exception.Message)
}
`
}

/** Operation scripts, each appended to the prelude. */
const OPS: Record<string, string> = {
  connect: String.raw`
$inbox = $ns.GetDefaultFolder($olFolderInbox)
$acct = SafeStr { $ns.CurrentUser.Name }
$count = 0
try { $count = [int]$inbox.Items.Count } catch { }
Release $inbox
Emit(@{ ok = $true; account = $acct; folders = (ListSubfolders $ns); inboxCount = $count })
`,

  'list-folders': String.raw`
Emit(@{ ok = $true; folders = (ListSubfolders $ns) })
`,

  'create-folder': String.raw`
$name = [string]$payload.name
if (-not $name -or $name.Trim().Length -eq 0) { Fail('A folder name is required.') }
$t = EnsureFolder $ns $name.Trim()
Release $t
Emit(@{ ok = $true; folders = (ListSubfolders $ns) })
`,

  scan: String.raw`
$max = 0
try { $max = [int]$payload.max } catch { $max = 0 }
$inbox = $ns.GetDefaultFolder($olFolderInbox)
$items = $inbox.Items
try { $items.Sort('[ReceivedTime]', $true) } catch { }
$total = 0
try { $total = [int]$items.Count } catch { $total = 0 }
$list = New-Object System.Collections.ArrayList
$skipped = 0
$seen = 0
Progress('Reading inbox (' + $total + ' items)...')
# Walk the sorted collection with GetFirst/GetNext — Outlook's documented,
# stable iteration for Items. The current item is only released AFTER the next
# one has been fetched; releasing mid-enumeration (or indexing numerically
# after a Sort) is what silently drops items.
$it = $null
try { $it = $items.GetFirst() } catch { $it = $null }
while ($null -ne $it) {
    $seen++
    try {
        $cls = 0
        try { $cls = [int]$it.Class } catch { $cls = 0 }
        # olMail = 43. Guarded so an item whose .Class throws is counted, not
        # silently dropped.
        if ($cls -ne $olMail) { $skipped++ }
        else {
            $rt = $null
            try { $rt = $it.ReceivedTime.ToUniversalTime().ToString('o') } catch { $rt = $null }
            [void]$list.Add([pscustomobject]@{
                entryId = SafeStr { $it.EntryID }
                subject = SafeStr { $it.Subject }
                senderName = SafeStr { $it.SenderName }
                senderEmail = (ResolveSmtp $it)
                receivedTime = $rt
                hasListUnsubscribe = (HasUnsub $it)
            })
        }
    } catch { $skipped++ }
    if ($max -gt 0 -and $list.Count -ge $max) { Release $it; $it = $null; break }
    if ($seen % 50 -eq 0) { Progress('Scanned ' + $seen + ' of ' + $total + '...') }
    $next = $null
    try { $next = $items.GetNext() } catch { $next = $null }
    Release $it
    $it = $next
}
Release $items; Release $inbox
# NOTE: plain @($list), NOT ,@($list) — the unary comma nests the array inside
# another array in the JSON ("headers":[[...]]), which made the renderer count
# ONE header (the inner array) and then die parsing it: the infamous
# "Scanned 1 message(s)" + permanently blank Cleanup tab.
Emit(@{ ok = $true; headers = @($list); scanned = $list.Count; skipped = $skipped; inboxCount = $total })
`,

  'get-body': String.raw`
$id = [string]$payload.entryId
if (-not $id) { Fail('An entryId is required.') }
$item = $null
try {
    $item = $ns.GetItemFromID($id)
    $body = SafeStr { $item.Body }
    Emit(@{ ok = $true; body = $body })
} catch { Fail('Could not read the message: ' + $_.Exception.Message) }
finally { Release $item }
`,

  'save-draft': String.raw`
$id = [string]$payload.entryId
$text = [string]$payload.text
if (-not $id) { Fail('An entryId is required.') }
$item = $null; $reply = $null
try {
    $item = $ns.GetItemFromID($id)
    $reply = $item.Reply()
    $quoted = SafeStr { $reply.Body }
    $nl = [string][char]13 + [string][char]10
    $reply.Body = $text + $nl + $nl + $quoted
    $reply.Save()
    Emit(@{ ok = $true })
} catch { Fail('Could not save the reply draft: ' + $_.Exception.Message) }
finally { Release $reply; Release $item }
`,

  cleanup: String.raw`
$moves = @($payload.moves)
$records = New-Object System.Collections.ArrayList
$moved = 0
foreach ($m in $moves) {
    $folderName = [string]$m.folder
    if (-not $folderName) { continue }
    $ids = @($m.entryIds)
    if ($ids.Count -eq 0) { continue }
    Progress('Filing ' + $ids.Count + ' email(s) to "' + $folderName + '"...')
    $target = EnsureFolder $ns $folderName
    $tEntry = [string]$target.EntryID
    $tStore = [string]$target.StoreID
    foreach ($id in $ids) {
        if (-not $id) { continue }
        $item = $null; $parent = $null; $movedItem = $null
        try {
            $item = $ns.GetItemFromID([string]$id)
            $parent = $item.Parent
            $oEntry = [string]$parent.EntryID
            $oStore = [string]$parent.StoreID
            $label = SafeStr { $item.SenderName }
            $subj = SafeStr { $item.Subject }
            $msgId = SafeStr { $item.PropertyAccessor.GetProperty($PR_MSGID) }
            $movedItem = $item.Move($target)
            $postId = ''
            try { $postId = [string]$movedItem.EntryID } catch { $postId = '' }
            [void]$records.Add([pscustomobject]@{
                movedEntryId = if ($postId) { $postId } else { [string]$id }
                uncertain = [bool](-not $postId)
                originalFolderEntryId = $oEntry
                originalFolderStoreId = $oStore
                targetFolderEntryId = $tEntry
                targetFolderStoreId = $tStore
                messageId = $msgId
                senderLabel = $label
                subject = $subj
                targetFolderName = $folderName
            })
            $moved++
        } catch { } finally { Release $movedItem; Release $parent; Release $item }
    }
    Release $target
}
Emit(@{ ok = $true; moved = $moved; records = @($records) })
`,

  undo: String.raw`
$recs = @($payload.records)
$restored = 0
$retry = New-Object System.Collections.ArrayList
foreach ($r in $recs) {
    $item = $null; $orig = $null
    try {
        if ([string]$r.movedEntryId) {
            try { $item = $ns.GetItemFromID([string]$r.movedEntryId) } catch { $item = $null }
        }
        if ($null -eq $item) {
            $item = FindByMsgId $ns ([string]$r.targetFolderEntryId) ([string]$r.targetFolderStoreId) ([string]$r.messageId)
        }
        if ($null -eq $item) { continue }
        $orig = $ns.GetFolderFromID([string]$r.originalFolderEntryId, [string]$r.originalFolderStoreId)
        $back = $item.Move($orig)
        Release $back
        $restored++
    } catch { [void]$retry.Add($r) }
    finally { Release $orig; Release $item }
}
Emit(@{ ok = $true; restored = $restored; retry = @($retry) })
`
}

/* --------------------------------- register ------------------------------ */

export default function register(ctx: ModuleIpcContext): void {
  let child: ChildProcess | null = null
  let aiAbort: AbortController | null = null

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  /** Run one Outlook operation as a single PowerShell process; resolve its JSON. */
  function runOutlook(op: keyof typeof OPS | string, payload: unknown): Promise<Record<string, unknown>> {
    const script = outlookPrelude(payload) + (OPS[op] ?? '')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    return new Promise((resolve) => {
      if (child) {
        resolve({ ok: false, error: 'Another Outlook operation is already running.' })
        return
      }
      let proc: ChildProcess
      try {
        proc = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encoded
          ],
          { windowsHide: true }
        )
      } catch (err) {
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
        return
      }
      child = proc

      let out = ''
      let errText = ''
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      proc.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (line.startsWith('PROGRESS:')) send(`${ID}:progress`, line.slice('PROGRESS:'.length).trim())
          else if (line.trim()) errText += line + '\n'
        }
      })
      proc.on('error', (err) => {
        child = null
        resolve({ ok: false, error: 'Could not start PowerShell: ' + errMsg(err) })
      })
      proc.on('close', () => {
        const killed = proc.killed
        child = null
        if (killed) {
          resolve({ ok: false, cancelled: true, error: 'Cancelled.' })
          return
        }
        const jsonStart = out.indexOf('{')
        if (jsonStart < 0) {
          const detail = (errText || out || 'no output').trim().slice(0, 600)
          resolve({ ok: false, error: 'Outlook operation returned no data. ' + detail })
          return
        }
        try {
          resolve(JSON.parse(out.slice(jsonStart)) as Record<string, unknown>)
        } catch (err) {
          resolve({ ok: false, error: 'Could not parse the Outlook output: ' + errMsg(err) })
        }
      })
    })
  }

  /* ---- undo history persistence (module-owned store) ---- */

  const loadHistory = (): MoveBatch[] => {
    const raw = ctx.storeGet<unknown>(UNDO_KEY, [])
    if (!Array.isArray(raw)) return []
    const out: MoveBatch[] = []
    for (const b of raw) {
      if (typeof b !== 'object' || b === null) continue
      const rec = (b as Record<string, unknown>).records
      out.push({
        createdUtc: str((b as Record<string, unknown>).createdUtc),
        records: toArray(rec)
          .map(normalizeRecord)
          .filter((r): r is MoveRecord => r !== null)
      })
    }
    return out
  }
  const saveHistory = (h: MoveBatch[]): void => {
    const trimmed = h.length > MAX_UNDO_BATCHES ? h.slice(h.length - MAX_UNDO_BATCHES) : h
    ctx.storeSet(UNDO_KEY, trimmed)
  }

  /* ---- data paths (Settings → Modules) ---- */

  // Learned routes and undo history live in the shell's shared electron-store
  // (new Store({ name: 'wicked-modules' }) → <userData>/wicked-modules.json),
  // not in a module-owned file. Surface that store file so the user can find it.
  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    const storeFile = join(ctx.app.getPath('userData'), 'wicked-modules.json')
    return [
      {
        label: 'Learned rules',
        path: existsSync(storeFile) ? storeFile : null,
        note: 'Sender→folder routes and undo history, kept in the shared app settings store'
      }
    ]
  })

  /* ---- routes persistence ---- */

  ctx.ipcMain.handle(`${ID}:routes-load`, () => normalizeRoutes(ctx.storeGet<unknown>(ROUTES_KEY, {})))
  ctx.ipcMain.handle(`${ID}:routes-save`, (_e, raw: unknown) => {
    const routes = normalizeRoutes(raw)
    ctx.storeSet(ROUTES_KEY, routes)
    return { ok: true, routes }
  })

  /* ---- import rules from the standalone Inbox Cleanup app ---- */

  // Read-only: find the old app's rules files (%LOCALAPPDATA%\InboxCleanup)
  // and report what each contains. Live `routes` file first, then backups.
  ctx.ipcMain.handle(`${ID}:import-rules-scan`, () => {
    return { ok: true, candidates: scanLegacyRules() }
  })

  // Let the user point at a rules file anywhere (e.g. a copied backup folder).
  ctx.ipcMain.handle(`${ID}:import-rules-pick`, async () => {
    const win = ctx.getMainWindow()
    const opts = {
      title: 'Choose the standalone Inbox Cleanup rules file (routes / routes.json)',
      properties: ['openFile' as const],
      // "All files" FIRST: the old app's live rules file is named just
      // `routes` with no extension — a JSON-only default filter would hide it.
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'JSON', extensions: ['json', 'bak'] }
      ]
    }
    const res = win ? await ctx.dialog.showOpenDialog(win, opts) : await ctx.dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return { ok: false, cancelled: true }
    const candidates = scanLegacyRules(res.filePaths[0])
    const picked = candidates.find((c) => resolve(c.file) === resolve(res.filePaths[0]))
    if (!picked)
      return {
        ok: false,
        error:
          'No rules were recognized in that file. Pick the "routes" (or routes.json / routes.recovered-full) file from the old Inbox Cleanup app.'
      }
    return { ok: true, candidate: picked }
  })

  // Merge the old rules into the module's routes. ADDITIVE: rules you already
  // have in the new app are kept; only missing entries are added.
  ctx.ipcMain.handle(`${ID}:import-rules`, (_e, raw: unknown) => {
    const req = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    let file = typeof req.file === 'string' && req.file.trim() ? req.file.trim() : ''
    if (!file) {
      const found = scanLegacyRules()
      if (found.length === 0)
        return {
          ok: false,
          error:
            'No standalone Inbox Cleanup rules were found (looked in %LOCALAPPDATA%\\InboxCleanup). Use "Choose file…" to pick the routes file manually.'
        }
      file = found[0].file
    }
    const parsed = readLegacyFile(file)
    if (!parsed) return { ok: false, error: 'No rules were recognized in that file.' }

    const routes = normalizeRoutes(ctx.storeGet<unknown>(ROUTES_KEY, {}))
    let added = 0
    let skippedExisting = 0
    const merge = (from: Record<string, string>, into: Record<string, string>): void => {
      for (const [k, v] of Object.entries(from)) {
        if (k in into) skippedExisting++
        else {
          into[k] = v
          added++
        }
      }
    }
    merge(parsed.emails, routes.emails)
    merge(parsed.domains, routes.domains)
    merge(parsed.subjects, routes.subjects)
    ctx.storeSet(ROUTES_KEY, routes)
    return {
      ok: true,
      file,
      added,
      skippedExisting,
      counts: {
        emails: Object.keys(parsed.emails).length,
        domains: Object.keys(parsed.domains).length,
        subjects: Object.keys(parsed.subjects).length
      },
      routes
    }
  })

  /* ---- Outlook operations ---- */

  ctx.ipcMain.handle(`${ID}:connect`, () => runOutlook('connect', {}))
  ctx.ipcMain.handle(`${ID}:list-folders`, () => runOutlook('list-folders', {}))

  ctx.ipcMain.handle(`${ID}:scan`, (_e, rawMax: unknown) => {
    let max = num(rawMax)
    if (max <= 0) max = DEFAULT_SCAN_LIMIT
    if (max > MAX_SCAN_LIMIT) max = MAX_SCAN_LIMIT
    return runOutlook('scan', { max })
  })

  ctx.ipcMain.handle(`${ID}:create-folder`, (_e, rawName: unknown) => {
    const name = str(rawName).trim()
    if (!name) return Promise.resolve({ ok: false, error: 'A folder name is required.' })
    return runOutlook('create-folder', { name })
  })

  /**
   * Apply a cleanup: move the given emails into their target folders, then learn
   * the sender→folder routes and persist an undo batch. `moves` is a list of
   * { folder, entryIds }; `learn` is a list of { entry, target } route rules.
   */
  ctx.ipcMain.handle(`${ID}:cleanup`, async (_e, rawReq: unknown) => {
    const req = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const moves = toArray(req.moves)
      .map((m) => {
        const o = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>
        return {
          folder: str(o.folder).trim(),
          entryIds: toArray(o.entryIds)
            .map((x) => str(x))
            .filter((x) => x.length > 0)
        }
      })
      .filter((m) => m.folder.length > 0 && m.entryIds.length > 0)

    const learn = toArray(req.learn)
      .map((l) => {
        const o = (typeof l === 'object' && l !== null ? l : {}) as Record<string, unknown>
        return { entry: str(o.entry).trim().toLowerCase(), target: str(o.target) }
      })
      .filter((l) => l.entry.length > 0)

    if (moves.length === 0 && learn.length === 0)
      return { ok: false, error: 'Nothing to apply — file some senders first.' }

    let moved = 0
    if (moves.length > 0) {
      const res = await runOutlook('cleanup', { moves })
      if (res.ok !== true) return res
      moved = num(res.moved)
      const records = toArray(res.records)
        .map(normalizeRecord)
        .filter((r): r is MoveRecord => r !== null)
      if (records.length > 0) {
        const history = loadHistory()
        history.push({ createdUtc: new Date().toISOString(), records })
        saveHistory(history)
      }
    }

    // Learn routes (assign sender/domain → target), same as Apply_Click.
    if (learn.length > 0) {
      const routes = normalizeRoutes(ctx.storeGet<unknown>(ROUTES_KEY, {}))
      for (const { entry, target } of learn) {
        let value = entry
        let domainOnly = false
        if (entry.startsWith('*@')) {
          value = entry.slice(2)
          domainOnly = true
        } else if (entry.startsWith('@')) {
          value = entry.slice(1)
          domainOnly = true
        } else if (entry.includes('@')) {
          domainOnly = false
        } else {
          domainOnly = true
        }
        if (!value) continue
        if (domainOnly) routes.domains[value] = target
        else routes.emails[value] = target
      }
      ctx.storeSet(ROUTES_KEY, routes)
    }

    return { ok: true, moved, learned: learn.length }
  })

  ctx.ipcMain.handle(`${ID}:has-undo`, () => {
    const h = loadHistory()
    return { ok: true, hasUndo: h.some((b) => b.records.length > 0), batches: h.length }
  })

  ctx.ipcMain.handle(`${ID}:history`, () => {
    const h = loadHistory()
    return {
      ok: true,
      batches: [...h].reverse().map((b) => ({
        createdUtc: b.createdUtc,
        count: b.records.length,
        items: b.records.map((r) => ({
          senderLabel: r.senderLabel,
          subject: r.subject,
          targetFolderName: r.targetFolderName
        }))
      }))
    }
  })

  ctx.ipcMain.handle(`${ID}:undo`, async () => {
    const history = loadHistory()
    while (history.length > 0 && history[history.length - 1].records.length === 0) history.pop()
    if (history.length === 0) {
      saveHistory(history)
      return { ok: true, restored: 0, retry: 0, hasUndo: false }
    }
    const last = history[history.length - 1]
    const res = await runOutlook('undo', { records: last.records })
    if (res.ok !== true) return res
    const retry = toArray(res.retry)
      .map(normalizeRecord)
      .filter((r): r is MoveRecord => r !== null)
    if (retry.length === 0) history.pop()
    else history[history.length - 1] = { createdUtc: last.createdUtc, records: retry }
    saveHistory(history)
    return {
      ok: true,
      restored: num(res.restored),
      retry: retry.length,
      hasUndo: history.some((b) => b.records.length > 0)
    }
  })

  /* ---- AI reply drafting (AiDraftService.cs port) ---- */

  const buildPrompt = (
    subject: string,
    fromName: string,
    fromEmail: string,
    body: string,
    tone: string
  ): string => {
    const b = body.length > AI_BODY_CAP ? body.slice(0, AI_BODY_CAP) + '\n…(truncated)' : body
    return (
      'You are drafting a reply on behalf of the email account\'s owner. ' +
      `Write the reply in a ${tone} tone. Output ONLY the reply body text — no subject line, no 'Subject:' prefix, ` +
      'no surrounding quotes. Respond to the sender\'s points using the email/thread context below. End with a brief, ' +
      'polite closing line, but DO NOT invent or include a signature or any name — the owner will add their own. ' +
      'Keep it focused, helpful, and natural.\n\n' +
      `From: ${fromName} <${fromEmail}>\nSubject: ${subject}\n\nEmail / thread:\n${b}`
    )
  }

  const callGemini = async (prompt: string, key: string, signal: AbortSignal): Promise<string> => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const parsed = JSON.parse(text) as {
      candidates?: { content?: { parts?: { text?: unknown }[] } }[]
    }
    const out = parsed.candidates?.[0]?.content?.parts?.[0]?.text
    return typeof out === 'string' ? out : ''
  }

  const callDeepSeek = async (prompt: string, key: string, signal: AbortSignal): Promise<string> => {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You draft email replies. Output only the reply body.' },
          { role: 'user', content: prompt }
        ],
        stream: false
      }),
      signal
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const parsed = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }
    const out = parsed.choices?.[0]?.message?.content
    return typeof out === 'string' ? out : ''
  }

  /**
   * Draft a reply for one inbox message and save it to Drafts (nothing is sent).
   * Tries Gemini 2.5 Flash, then DeepSeek — the original's order. On the UI path
   * keys come from the central vault; the MCP path may override a single
   * provider's key (never auto-using the vault secret).
   */
  ctx.ipcMain.handle(`${ID}:draft-reply`, async (_e, rawReq: unknown) => {
    const req = (typeof rawReq === 'object' && rawReq !== null ? rawReq : {}) as Record<string, unknown>
    const entryId = str(req.entryId)
    if (!entryId) return { ok: false, error: 'An entryId is required.' }
    const tone = str(req.tone) || 'warm and professional'

    // Optional MCP override: { provider: 'gemini'|'deepseek', key }.
    const override =
      typeof req.keyOverride === 'object' && req.keyOverride !== null
        ? (req.keyOverride as Record<string, unknown>)
        : null
    const overrideProvider = override ? str(override.provider).toLowerCase() : ''
    const overrideKey = override ? str(override.key) : ''

    let geminiKey: string | null
    let deepseekKey: string | null
    if (overrideKey) {
      geminiKey = overrideProvider === 'gemini' ? overrideKey : null
      deepseekKey = overrideProvider === 'deepseek' ? overrideKey : null
    } else {
      geminiKey = ctx.getApiKey('gemini')
      deepseekKey = ctx.getApiKey('deepseek')
    }
    if (!geminiKey && !deepseekKey)
      return {
        ok: false,
        error: 'No AI key found. Set a Gemini or DeepSeek key in Settings → API Keys.'
      }

    // Pull the thread body from Outlook.
    const bodyRes = await runOutlook('get-body', { entryId })
    if (bodyRes.ok !== true) return bodyRes
    const body = str(bodyRes.body)

    const prompt = buildPrompt(str(req.subject), str(req.fromName), str(req.fromEmail), body, tone)

    if (aiAbort) return { ok: false, error: 'A draft request is already running.' }
    const controller = new AbortController()
    aiAbort = controller
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)
    let draft = ''
    const errors: string[] = []
    try {
      if (geminiKey) {
        try {
          const t = await callGemini(prompt, geminiKey, controller.signal)
          if (t.trim()) draft = t.trim()
        } catch (err) {
          if (controller.signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' }
          errors.push('Gemini: ' + errMsg(err))
        }
      }
      if (!draft && deepseekKey) {
        try {
          const t = await callDeepSeek(prompt, deepseekKey, controller.signal)
          if (t.trim()) draft = t.trim()
        } catch (err) {
          if (controller.signal.aborted) return { ok: false, cancelled: true, error: 'Cancelled.' }
          errors.push('DeepSeek: ' + errMsg(err))
        }
      }
    } finally {
      clearTimeout(timer)
      aiAbort = null
    }

    if (!draft)
      return {
        ok: false,
        error: errors.length ? 'AI draft failed — ' + errors.join(' | ') : 'The AI returned an empty draft.'
      }

    // Save the reply to Drafts via Outlook (never sent).
    const saveRes = await runOutlook('save-draft', { entryId, text: draft })
    if (saveRes.ok !== true) return saveRes
    return { ok: true }
  })

  /* ---- cancellation (running PowerShell + in-flight AI request) ---- */

  ctx.ipcMain.handle(`${ID}:cancel`, () => {
    let cancelled = false
    if (child) {
      child.kill()
      cancelled = true
    }
    if (aiAbort) {
      aiAbort.abort()
      cancelled = true
    }
    return { ok: true, cancelled }
  })
}

import { create } from 'zustand'

export const ID = 'event-viewer'

/* ------------------------------------------------------------------------ *
 *  Constants carried over from the standalone app (Config.cs / MainForm.cs)
 * ------------------------------------------------------------------------ */

/** Config.MaxDigestChars — how much of the digest we send to the AI. */
const MAX_DIGEST_CHARS = 120_000

/** MainForm.Presets — hours; null = custom range. Default index 3 (24 h). */
export const PRESETS: { label: string; hours: number | null }[] = [
  { label: 'Last hour', hours: 1 },
  { label: 'Last 6 hours', hours: 6 },
  { label: 'Last 12 hours', hours: 12 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 3 days', hours: 72 },
  { label: 'Last 7 days', hours: 168 },
  { label: 'Custom range', hours: null }
]
export const DEFAULT_PRESET_INDEX = 3

/** ChatSession.SystemPrompt — verbatim from AiClient.cs. */
const SYSTEM_PROMPT =
  'You are a senior Windows system administrator analysing the Windows Event Log digest below, ' +
  'collected from a single machine. Identical events have been de-duplicated into groups with ' +
  'occurrence counts and up to two sample messages each. Explain clearly, in plain English, what ' +
  'is going on with this machine. Be honest about severity: Windows machines log plenty of ' +
  'harmless noise, so do not invent problems, and never mention events that are not in the digest. ' +
  'When the user describes a specific problem they experienced, focus the investigation on it: ' +
  'correlate timestamps with their description, look for related event groups (e.g. Kernel-Power, ' +
  'WHEA, bugcheck, service failures, disk or driver errors), and give a concrete diagnosis with ' +
  'confidence levels. If the digest does not contain the events needed to answer, say exactly what ' +
  'to change (wider time range, extra logs or levels) and ask the user to re-run the collection. ' +
  'Answer follow-up questions concisely in Markdown. Never use Markdown tables.'

/** ChatSession.ReportInstructions — verbatim from AiClient.cs. */
const REPORT_INSTRUCTIONS =
  'Analyse the event log digest and write a health report in Markdown with exactly these sections:\n' +
  '# Windows Health Report\n' +
  '## Verdict\n' +
  '2-4 sentences: overall health of the machine and the single most important thing to do (or say ' +
  'clearly that nothing needs doing).\n' +
  '## Issues found\n' +
  "The real problems, ordered by real-world impact, numbered. For each use a '### N. Short title " +
  "— Severity: Critical/High/Medium/Low' heading, then short bullet points for: What's happening " +
  '(plain English), Evidence (provider, event IDs, counts from the digest), Likely cause, and How ' +
  'to fix (concrete steps). If there are no real problems, say so.\n' +
  '## Safe to ignore\n' +
  "Briefly list the groups that look like routine noise and why they're harmless.\n" +
  '## Recommended next steps\n' +
  'A short prioritised checklist.\n\n' +
  'Rules: plain English, explain any jargon in one phrase, no Markdown tables, and be specific ' +
  'about event IDs and counts.'

/** MainForm.ResetChat intro message. */
const CHAT_INTRO =
  'Describe the problem you\'re seeing — for example: *"The system crashed over the last ' +
  'couple of days. It seemed to be on but unresponsive. Please identify why."*\n\n' +
  "Tip: set the time range above to cover when the problem happened. If you haven't pressed " +
  'Analyse yet, events are collected automatically when you send a message.'

/* --------------------------------- types --------------------------------- */

export interface EventGroup {
  log: string
  provider: string
  eventId: number
  level: number
  count: number
  firstSeen: string | null
  lastSeen: string | null
  samples: string[]
}

export interface CollectionData {
  groups: EventGroup[]
  totalEvents: number
  warnings: string[]
  machine: string
  os: string
  fromIso: string
  toIso: string
}

export interface ChatItem {
  kind: 'user' | 'assistant' | 'info'
  markdown: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type BusyState = 'idle' | 'collecting' | 'analyzing'

interface CollectOk {
  ok: true
  groups: EventGroup[]
  totalEvents: number
  warnings: string[]
  truncatedLogs: string[]
  machine: string
  os: string
}
interface IpcErr {
  ok: false
  error?: string
  cancelled?: boolean
}
type CollectResult = CollectOk | IpcErr
type AiResult = { ok: true; content: string } | IpcErr

/* ------------------------- formatting + digest --------------------------- */

const pad = (n: number): string => String(n).padStart(2, '0')

export function num(n: number): string {
  return n.toLocaleString('en-US')
}

/** yyyy-MM-dd HH:mm in local time. */
export function fmtLong(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '(unknown)'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** MM-dd HH:mm in local time (digest group lines). */
export function fmtShort(iso: string | null): string {
  if (!iso) return '(unknown)'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '(unknown)'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** MMM d HH:mm in local time (chat "New collection" line). */
export function fmtChat(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '(unknown)'
  const month = d.toLocaleString('en-US', { month: 'short' })
  return `${month} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** EventGroup.LevelName from the original. */
export function levelName(level: number, log: string): string {
  switch (level) {
    case 1:
      return 'CRITICAL'
    case 2:
      return 'ERROR'
    case 3:
      return 'WARNING'
    case 4:
      return 'INFO'
    case 0:
      return log.toLowerCase() === 'security' ? 'AUDIT FAILURE' : 'INFO'
    default:
      return 'LEVEL ' + level
  }
}

/** EventGroup.Severity sort key: critical, error, audit failure, warning, info. */
export function severityRank(level: number): number {
  switch (level) {
    case 1:
      return 0
    case 2:
      return 1
    case 0:
      return 2
    case 3:
      return 3
    default:
      return 4
  }
}

/** Port of EventCollector.BuildDigest — the plain-text digest sent to the AI. */
export function buildDigest(d: CollectionData): string {
  const head: string[] = []
  head.push(`Machine: ${d.machine}`)
  head.push(`OS: ${d.os}`)
  head.push(`Time range analysed: ${fmtLong(d.fromIso)} to ${fmtLong(d.toIso)} (local time)`)
  head.push(
    `Total matching events: ${num(d.totalEvents)}, de-duplicated into ${num(d.groups.length)} groups`
  )

  const byLevel = new Map<string, number>()
  for (const g of d.groups) {
    const name = levelName(g.level, g.log)
    byLevel.set(name, (byLevel.get(name) ?? 0) + g.count)
  }
  head.push(
    'Event counts by level: ' +
      [...byLevel.entries()].map(([name, count]) => `${name}: ${num(count)}`).join(', ')
  )
  for (const w of d.warnings) head.push('Collection warning: ' + w)
  head.push('')
  head.push('Event groups (each line is one group of identical events):')
  head.push('')

  let out = head.join('\n') + '\n'
  for (let i = 0; i < d.groups.length; i++) {
    const g = d.groups[i]
    out +=
      `[${levelName(g.level, g.log)}] ${g.log} / ${g.provider} (Event ID ${g.eventId}) — ` +
      `${g.count} occurrence(s), first ${fmtShort(g.firstSeen)}, last ${fmtShort(g.lastSeen)}\n`
    for (const sample of g.samples) out += `    e.g. ${sample}\n`

    if (out.length > MAX_DIGEST_CHARS) {
      const omitted = d.groups.length - i - 1
      out += `\n[NOTE] Digest truncated to fit the AI context window; ${omitted} lower-severity group(s) omitted.\n`
      break
    }
  }
  return out
}

function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* --------------------------------- store --------------------------------- */

interface EventViewerState {
  logs: { application: boolean; system: boolean; security: boolean; setup: boolean }
  levels: { critical: boolean; error: boolean; warning: boolean; info: boolean }
  presetIndex: number
  customFrom: string
  customTo: string

  busy: BusyState
  status: string
  error: string

  data: CollectionData | null
  report: string
  reportGeneratedAt: string
  view: 'events' | 'report'
  levelFilter: string | null

  chatItems: ChatItem[]
  session: ChatMessage[] | null

  toggleLog: (key: keyof EventViewerState['logs']) => void
  toggleLevel: (key: keyof EventViewerState['levels']) => void
  setPresetIndex: (i: number) => void
  setCustomFrom: (v: string) => void
  setCustomTo: (v: string) => void
  setView: (v: 'events' | 'report') => void
  setLevelFilter: (name: string | null) => void
  setStatus: (s: string) => void
  dismissError: () => void

  analyse: () => Promise<void>
  askQuestion: (question: string) => Promise<void>
  cancel: () => Promise<void>
  exportReport: () => Promise<void>
  copyReport: () => Promise<void>
}

type Selection = { logs: string[]; levels: number[] } | { error: string }
type Range = { fromIso: string; toIso: string } | { error: string }

const initialNow = new Date()

export const useEventViewer = create<EventViewerState>((set, get) => {
  /** MainForm.ValidateSelection port. */
  const validateSelection = (): Selection => {
    const s = get()
    const logs: string[] = []
    if (s.logs.application) logs.push('Application')
    if (s.logs.system) logs.push('System')
    if (s.logs.security) logs.push('Security')
    if (s.logs.setup) logs.push('Setup')
    const levels: number[] = []
    if (s.levels.critical) levels.push(1)
    if (s.levels.error) levels.push(2)
    if (s.levels.warning) levels.push(3)
    if (s.levels.info) levels.push(4)
    if (logs.length === 0) return { error: 'Select at least one log to analyse.' }
    if (levels.length === 0 && !(logs.length === 1 && logs[0] === 'Security'))
      return {
        error: 'Select at least one event level (Critical / Error / Warning / Information).'
      }
    return { logs, levels }
  }

  /** MainForm.ApplyPreset port — "last X" presets are relative to now. */
  const resolveRange = (): Range => {
    const s = get()
    const preset = PRESETS[s.presetIndex]
    if (preset && preset.hours !== null) {
      const to = new Date()
      const from = new Date(to.getTime() - preset.hours * 3_600_000)
      return { fromIso: from.toISOString(), toIso: to.toISOString() }
    }
    const from = new Date(s.customFrom)
    const to = new Date(s.customTo)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      return { error: 'Enter valid From and To times.' }
    if (from.getTime() >= to.getTime())
      return { error: "The 'From' time must be before the 'To' time." }
    return { fromIso: from.toISOString(), toIso: to.toISOString() }
  }

  /**
   * MainForm.CollectAndStartSessionAsync port: collects events with the
   * current settings and pins the digest as the system message of a fresh
   * multi-turn chat session.
   */
  const collectAndStartSession = async (): Promise<CollectionData | null> => {
    const sel = validateSelection()
    if ('error' in sel) {
      set({ error: sel.error })
      return null
    }
    const range = resolveRange()
    if ('error' in range) {
      set({ error: range.error })
      return null
    }

    set({ busy: 'collecting', status: 'Collecting events…', error: '' })
    const res = (await window.wicked.invoke(`${ID}:collect`, {
      logs: sel.logs,
      levels: sel.levels,
      fromIso: range.fromIso,
      toIso: range.toIso
    })) as CollectResult

    if (!res.ok) {
      if (res.cancelled) set({ status: 'Cancelled.' })
      else set({ error: res.error ?? 'Event collection failed.', status: 'Collection failed.' })
      return null
    }

    // Same ordering as EventCollector.Collect: severity, then count desc.
    const groups = [...res.groups].sort(
      (a, b) => severityRank(a.level) - severityRank(b.level) || b.count - a.count
    )
    const warnings = [
      ...res.warnings,
      ...res.truncatedLogs.map(
        (l) =>
          `Only the newest 10,000 events were read from the ${l} log (safety cap); narrow the time range for full coverage.`
      )
    ]
    const data: CollectionData = {
      groups,
      totalEvents: res.totalEvents,
      warnings,
      machine: res.machine,
      os: res.os,
      fromIso: range.fromIso,
      toIso: range.toIso
    }

    const digest = buildDigest(data)
    const session: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n=== EVENT LOG DIGEST ===\n' + digest }
    ]
    const chatItems: ChatItem[] = [
      { kind: 'info', markdown: CHAT_INTRO },
      {
        kind: 'info',
        markdown:
          `— New collection: ${sel.logs.join(', ')} · ${fmtChat(range.fromIso)} → ` +
          `${fmtChat(range.toIso)} · ${num(data.totalEvents)} events in ${num(groups.length)} groups —`
      }
    ]
    set({ data, session, chatItems, view: 'events', levelFilter: null })
    return data
  }

  /**
   * ChatSession.ExchangeAsync port: appends the user turn, calls the API with
   * the whole history, appends the assistant turn. On failure the history is
   * left unchanged so the request can be retried.
   */
  const exchange = async (userContent: string): Promise<string | null> => {
    const session = get().session
    if (!session) return null
    const messages: ChatMessage[] = [...session, { role: 'user', content: userContent }]
    const res = (await window.wicked.invoke(`${ID}:ai-complete`, messages)) as AiResult
    if (!res.ok) {
      if (res.cancelled) set({ status: 'Cancelled.' })
      else set({ error: res.error ?? 'The analysis request failed.' })
      return null
    }
    set({ session: [...messages, { role: 'assistant', content: res.content }] })
    return res.content
  }

  return {
    // MainForm defaults: Application + System / Critical + Error + Warning.
    logs: { application: true, system: true, security: false, setup: false },
    levels: { critical: true, error: true, warning: true, info: false },
    presetIndex: DEFAULT_PRESET_INDEX,
    customFrom: toLocalInputValue(new Date(initialNow.getTime() - 24 * 3_600_000)),
    customTo: toLocalInputValue(initialNow),

    busy: 'idle',
    status: 'Ready.',
    error: '',

    data: null,
    report: '',
    reportGeneratedAt: '',
    view: 'events',
    levelFilter: null,

    chatItems: [{ kind: 'info', markdown: CHAT_INTRO }],
    session: null,

    toggleLog: (key) => set((s) => ({ logs: { ...s.logs, [key]: !s.logs[key] } })),
    toggleLevel: (key) => set((s) => ({ levels: { ...s.levels, [key]: !s.levels[key] } })),
    setPresetIndex: (i) => set({ presetIndex: i }),
    setCustomFrom: (v) => set({ customFrom: v }),
    setCustomTo: (v) => set({ customTo: v }),
    setView: (v) => set({ view: v }),
    setLevelFilter: (name) => set({ levelFilter: name }),
    setStatus: (s) => set({ status: s }),
    dismissError: () => set({ error: '' }),

    /** MainForm.RunAnalysisAsync port. */
    analyse: async () => {
      if (get().busy !== 'idle') return
      const started = Date.now()
      try {
        const data = await collectAndStartSession()
        if (!data) return

        if (data.totalEvents === 0) {
          set({
            session: null,
            status: 'No matching events found.',
            chatItems: [
              ...get().chatItems,
              {
                kind: 'info',
                markdown:
                  'No events matched the selected logs, levels and time range — nothing to ' +
                  'analyse. That usually means the machine has been healthy over this period.'
              }
            ]
          })
          return
        }

        set({
          busy: 'analyzing',
          status: `Collected ${num(data.totalEvents)} events (${num(data.groups.length)} groups). Analysing…`
        })
        const markdown = await exchange(REPORT_INSTRUCTIONS)
        if (markdown === null) {
          set({ status: 'Analysis failed.' })
          return
        }

        set({
          report: markdown,
          reportGeneratedAt: fmtLong(new Date().toISOString()),
          view: 'report',
          chatItems: [
            ...get().chatItems,
            { kind: 'info', markdown: 'Report generated — ask anything about it below.' }
          ],
          status: `Done — ${num(data.totalEvents)} events analysed in ${Math.round((Date.now() - started) / 1000)}s.`
        })
      } finally {
        set({ busy: 'idle' })
      }
    },

    /** MainForm.SendChatAsync port (auto-collects on the first message). */
    askQuestion: async (question) => {
      const trimmed = question.trim()
      if (trimmed.length === 0 || get().busy !== 'idle') return
      try {
        if (!get().session) {
          const data = await collectAndStartSession()
          if (!data) return
          if (data.totalEvents === 0) {
            set({
              session: null,
              status: 'No matching events found.',
              chatItems: [
                ...get().chatItems,
                {
                  kind: 'info',
                  markdown:
                    'No events matched the current settings, so there is nothing to investigate ' +
                    'yet. Try a wider time range or more logs/levels.'
                }
              ]
            })
            return
          }
        }

        set({
          busy: 'analyzing',
          status: 'Analysing…',
          chatItems: [...get().chatItems, { kind: 'user', markdown: trimmed }]
        })
        const reply = await exchange(trimmed)
        if (reply === null) {
          const why = get().error
          set({
            status: 'Request failed.',
            chatItems: [
              ...get().chatItems,
              { kind: 'info', markdown: 'Something went wrong: ' + (why || 'the request failed.') }
            ]
          })
          return
        }
        set({
          status: 'Ready.',
          chatItems: [...get().chatItems, { kind: 'assistant', markdown: reply }]
        })
      } finally {
        set({ busy: 'idle' })
      }
    },

    cancel: async () => {
      await window.wicked.invoke(`${ID}:cancel`)
    },

    exportReport: async () => {
      const report = get().report
      if (!report) return
      const res = (await window.wicked.invoke(`${ID}:export-report`, report)) as {
        ok: boolean
        path?: string
        canceled?: boolean
        error?: string
      }
      if (res.ok && res.path) set({ status: `Report saved to ${res.path}` })
      else if (!res.canceled && res.error) set({ error: res.error })
    },

    copyReport: async () => {
      const report = get().report
      if (!report) return
      await navigator.clipboard.writeText(report)
      set({ status: 'Report Markdown copied to clipboard.' })
    }
  }
})

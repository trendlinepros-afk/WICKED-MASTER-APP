import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Copy,
  FileDown,
  KeyRound,
  Loader2,
  Play,
  ScrollText,
  Send,
  Square,
  X
} from 'lucide-react'
import { SHELL_IPC, type ApiProviderId } from '@shared/types'
import {
  DEFAULT_PRESET_INDEX,
  ID,
  PRESETS,
  fmtLong,
  fmtShort,
  levelName,
  num,
  severityRank,
  useEventViewer,
  type EventGroup
} from './store'

/* ------------------------------ tiny pieces ------------------------------ */

function Markdown({ text, compact }: { text: string; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`prose dark:prose-invert max-w-none ${compact ? 'prose-sm' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function LevelBadge({ name }: { name: string }): React.JSX.Element {
  const cls =
    name === 'CRITICAL'
      ? 'bg-danger text-bg'
      : name === 'ERROR' || name === 'AUDIT FAILURE'
        ? 'bg-danger/15 text-danger'
        : name === 'WARNING'
          ? 'bg-warn/15 text-warn'
          : 'bg-raised text-muted'
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${cls}`}
    >
      {name}
    </span>
  )
}

function Check({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: () => void
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 accent-accent"
      />
      <span>{label}</span>
    </label>
  )
}

function Notice({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
      <span>{text}</span>
    </div>
  )
}

/* -------------------------------- chat panel ----------------------------- */

function ChatPanel(): React.JSX.Element {
  const chatItems = useEventViewer((s) => s.chatItems)
  const busy = useEventViewer((s) => s.busy)
  const askQuestion = useEventViewer((s) => s.askQuestion)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatItems, busy])

  const send = (): void => {
    const question = input.trim()
    if (!question || busy !== 'idle') return
    setInput('')
    void askQuestion(question)
  }

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-r border-edge">
      <div className="border-b border-edge px-4 py-2.5 text-sm font-semibold">Investigate</div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {chatItems.map((item, i) =>
          item.kind === 'user' ? (
            <div
              key={i}
              className="ml-6 whitespace-pre-wrap rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm"
            >
              {item.markdown}
            </div>
          ) : item.kind === 'assistant' ? (
            <div key={i} className="mr-6 rounded-lg border border-edge bg-raised px-3 py-2">
              <Markdown compact text={item.markdown} />
            </div>
          ) : (
            <div key={i} className="px-2 text-xs text-muted">
              <Markdown compact text={item.markdown} />
            </div>
          )
        )}
        {busy !== 'idle' && (
          <div className="flex items-center gap-2 px-2 text-xs text-muted">
            <Loader2 size={12} className="animate-spin text-accent" />
            {busy === 'collecting' ? 'Collecting events…' : 'Analysing…'}
          </div>
        )}
      </div>
      <div className="border-t border-edge p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={3}
            disabled={busy !== 'idle'}
            placeholder="Describe the problem… (Enter to send)"
            className="min-w-0 flex-1 resize-none rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={busy !== 'idle' || input.trim().length === 0}
            title="Send"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </aside>
  )
}

/* -------------------------------- events tab ----------------------------- */

function EventsTab(): React.JSX.Element {
  const data = useEventViewer((s) => s.data)
  const levelFilter = useEventViewer((s) => s.levelFilter)
  const setLevelFilter = useEventViewer((s) => s.setLevelFilter)

  if (!data) {
    return (
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-lg font-bold">Windows Event Viewer Analyser</h2>
          <p className="mt-2 text-sm text-muted">
            Pick a time range and the logs you care about, then press <strong>Analyse</strong> for
            a full health report — or just describe your problem in the panel on the left.
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>
              The analyser reads the selected Windows Event Logs, de-duplicates the entries and
              works out what actually matters.
            </li>
            <li>
              Reports are plain English: what&apos;s wrong, what caused it, and how to fix it.
            </li>
            <li>
              The <em>Security</em> log requires administrator rights, which WICKED never asks for
              — if it can&apos;t be read it is skipped with a notice. It is scanned for audit
              failures (e.g. failed logons).
            </li>
          </ul>
        </div>
      </div>
    )
  }

  const counts = new Map<string, number>()
  for (const g of data.groups) {
    const name = levelName(g.level, g.log)
    counts.set(name, (counts.get(name) ?? 0) + g.count)
  }
  const orderedLevels = [...counts.keys()].sort((a, b) => {
    const rank = (n: string): number =>
      n === 'CRITICAL' ? 0 : n === 'ERROR' ? 1 : n === 'AUDIT FAILURE' ? 2 : n === 'WARNING' ? 3 : 4
    return rank(a) - rank(b)
  })
  const filtered = levelFilter
    ? data.groups.filter((g) => levelName(g.level, g.log) === levelFilter)
    : data.groups

  const chip = (label: string, value: string | null, count: number): React.JSX.Element => (
    <button
      key={label}
      onClick={() => setLevelFilter(value)}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        levelFilter === value
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-edge bg-raised text-muted hover:text-ink'
      }`}
    >
      {label} · {num(count)}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          {num(data.totalEvents)} events in {num(data.groups.length)} groups ·{' '}
          {fmtLong(data.fromIso)} → {fmtLong(data.toIso)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {chip('All', null, data.totalEvents)}
          {orderedLevels.map((name) => chip(name, name, counts.get(name) ?? 0))}
        </div>
      </div>

      {data.warnings.length > 0 && (
        <div className="space-y-2">
          {data.warnings.map((w, i) => (
            <Notice key={i} text={w} />
          ))}
        </div>
      )}

      {data.totalEvents === 0 ? (
        <div className="rounded-lg border border-edge bg-raised/50 p-6 text-sm text-muted">
          No events matched the selected logs, levels and time range — nothing to analyse. That
          usually means the machine has been healthy over this period.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-edge">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="text-xs uppercase tracking-wide text-muted">
                <th className="border-b border-edge px-3 py-2">Level</th>
                <th className="border-b border-edge px-3 py-2">Count</th>
                <th className="border-b border-edge px-3 py-2">Last seen</th>
                <th className="border-b border-edge px-3 py-2">Log</th>
                <th className="border-b border-edge px-3 py-2">Source</th>
                <th className="border-b border-edge px-3 py-2">ID</th>
                <th className="border-b border-edge px-3 py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              {[...filtered]
                .sort((a, b) => severityRank(a.level) - severityRank(b.level) || b.count - a.count)
                .map((g: EventGroup, i: number) => (
                  <tr key={i} className="align-top hover:bg-raised/60">
                    <td className="border-b border-edge/60 px-3 py-2">
                      <LevelBadge name={levelName(g.level, g.log)} />
                    </td>
                    <td className="border-b border-edge/60 px-3 py-2 tabular-nums">
                      {num(g.count)}
                    </td>
                    <td className="whitespace-nowrap border-b border-edge/60 px-3 py-2 text-muted">
                      {fmtShort(g.lastSeen)}
                    </td>
                    <td className="border-b border-edge/60 px-3 py-2">{g.log}</td>
                    <td
                      className="max-w-[220px] truncate border-b border-edge/60 px-3 py-2"
                      title={g.provider}
                    >
                      {g.provider}
                    </td>
                    <td className="border-b border-edge/60 px-3 py-2 tabular-nums">{g.eventId}</td>
                    <td className="border-b border-edge/60 px-3 py-2 text-muted">
                      <span className="line-clamp-2" title={g.samples.join('\n\n')}>
                        {g.samples[0] ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* -------------------------------- report tab ----------------------------- */

function ReportTab(): React.JSX.Element {
  const report = useEventViewer((s) => s.report)
  const reportGeneratedAt = useEventViewer((s) => s.reportGeneratedAt)
  const data = useEventViewer((s) => s.data)

  if (!report) {
    return (
      <div className="flex-1 overflow-y-auto p-8 text-sm text-muted">
        No report yet — press <strong className="text-ink">Analyse</strong> to collect events and
        generate a Windows Health Report.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        {data && (
          <div className="mb-1 text-xs text-muted">
            Machine <span className="font-semibold text-ink">{data.machine}</span> ·{' '}
            {fmtLong(data.fromIso)} → {fmtLong(data.toIso)} · {num(data.totalEvents)} events in{' '}
            {num(data.groups.length)} groups · generated {reportGeneratedAt}
          </div>
        )}
        {data && data.warnings.length > 0 && (
          <div className="mb-3 mt-2 space-y-2">
            {data.warnings.map((w, i) => (
              <Notice key={i} text={w} />
            ))}
          </div>
        )}
        <div className="prose dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}

/* --------------------------------- module -------------------------------- */

export default function EventViewer(): React.JSX.Element {
  const s = useEventViewer()
  // Presence-only status from the shell's central key vault (never values).
  const [apiKeys, setApiKeys] = useState<Partial<Record<ApiProviderId, boolean>> | null>(null)

  // Per-log progress pushed from the main process during collection.
  useEffect(() => {
    return window.wicked.on(`${ID}:progress`, (msg) => {
      if (typeof msg === 'string') useEventViewer.setState({ status: msg })
    })
  }, [])

  useEffect(() => {
    let mounted = true
    void window.wicked.invoke(SHELL_IPC.apiKeysStatus).then((status) => {
      if (mounted) setApiKeys(status as Partial<Record<ApiProviderId, boolean>>)
    })
    const off = window.wicked.on(SHELL_IPC.apiKeysChanged, (status) => {
      setApiKeys(status as Partial<Record<ApiProviderId, boolean>>)
    })
    return () => {
      mounted = false
      off()
    }
  }, [])

  const missingKey = apiKeys !== null && apiKeys.deepseek !== true
  const custom = PRESETS[s.presetIndex]?.hours === null

  return (
    <div className="relative flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <ScrollText size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">Event Viewer Analyzer</h1>
          <p className="truncate text-xs text-muted">
            Windows Event Log health reports, powered by DeepSeek
          </p>
        </div>
      </header>

      {/* toolbar row 1: time range + actions */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-5 py-2.5">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-muted">Time range</span>
          <select
            value={s.presetIndex}
            onChange={(e) => s.setPresetIndex(Number(e.target.value))}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {custom && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted">From</span>
            <input
              type="datetime-local"
              value={s.customFrom}
              onChange={(e) => s.setCustomFrom(e.target.value)}
              className="rounded-md border border-edge bg-raised px-2 py-1 text-sm outline-none focus:border-accent"
            />
            <span className="text-xs text-muted">To</span>
            <input
              type="datetime-local"
              value={s.customTo}
              onChange={(e) => s.setCustomTo(e.target.value)}
              className="rounded-md border border-edge bg-raised px-2 py-1 text-sm outline-none focus:border-accent"
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => void s.analyse()}
            disabled={s.busy !== 'idle'}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy !== 'idle' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Analyse
          </button>
          <button
            onClick={() => void s.cancel()}
            disabled={s.busy === 'idle'}
            className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <Square size={13} />
            Cancel
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void s.exportReport()}
            disabled={!s.report}
            className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <FileDown size={14} />
            Save report…
          </button>
          <button
            onClick={() => void s.copyReport()}
            disabled={!s.report}
            className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <Copy size={14} />
            Copy Markdown
          </button>
        </div>
      </div>

      {/* toolbar row 2: logs + levels */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-edge px-5 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Logs</span>
        <Check
          label="Application"
          checked={s.logs.application}
          onChange={() => s.toggleLog('application')}
        />
        <Check label="System" checked={s.logs.system} onChange={() => s.toggleLog('system')} />
        <Check
          label="Security (audit failures)"
          checked={s.logs.security}
          onChange={() => s.toggleLog('security')}
        />
        <Check label="Setup" checked={s.logs.setup} onChange={() => s.toggleLog('setup')} />
        <span className="ml-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Levels
        </span>
        <Check
          label="Critical"
          checked={s.levels.critical}
          onChange={() => s.toggleLevel('critical')}
        />
        <Check label="Error" checked={s.levels.error} onChange={() => s.toggleLevel('error')} />
        <Check
          label="Warning"
          checked={s.levels.warning}
          onChange={() => s.toggleLevel('warning')}
        />
        <Check
          label="Information (can be slow)"
          checked={s.levels.info}
          onChange={() => s.toggleLevel('info')}
        />
      </div>

      {/* missing-key notice (key lives in the shell's central vault) */}
      {missingKey && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <KeyRound size={14} className="shrink-0 text-warn" />
          <span>
            No DeepSeek API key is set — event collection works, but the AI health report needs
            one. Add it under <strong>Settings → API Keys</strong>.
          </span>
        </div>
      )}

      {/* error bar */}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button
            onClick={s.dismissError}
            className="rounded p-1 hover:bg-danger/15"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* main: chat | tabs */}
      <div className="flex min-h-0 flex-1">
        <ChatPanel />
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-edge px-4 pt-2">
            {(['events', 'report'] as const).map((v) => (
              <button
                key={v}
                onClick={() => s.setView(v)}
                className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
                  s.view === v
                    ? 'border-accent font-medium text-ink'
                    : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {v === 'events'
                  ? `Events${s.data ? ` (${num(s.data.groups.length)})` : ''}`
                  : 'Report'}
              </button>
            ))}
          </div>
          {s.view === 'events' ? <EventsTab /> : <ReportTab />}
        </section>
      </div>

      {/* status bar */}
      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {s.busy !== 'idle' && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <span className="truncate">{s.status}</span>
        {s.presetIndex !== DEFAULT_PRESET_INDEX && (
          <span className="ml-auto shrink-0">{PRESETS[s.presetIndex]?.label}</span>
        )}
      </footer>
    </div>
  )
}

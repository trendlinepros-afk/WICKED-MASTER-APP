import { useEffect } from 'react'
import {
  AlertTriangle,
  FolderPlus,
  Loader2,
  MailCheck,
  Plug,
  RefreshCw,
  Reply,
  ScrollText,
  Sparkles,
  SquareStack,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { SHELL_IPC, type ApiProviderId } from '@shared/types'
import {
  ID,
  INBOX,
  REVIEW_FOLDER,
  TONES,
  fmtCount,
  fmtDateTime,
  rulesEvaluate,
  useCleanup,
  type SenderRoute,
  type Tab
} from './store'

/* ------------------------------ tiny pieces ------------------------------ */

function TargetLabel({ target }: { target: string | null }): React.JSX.Element {
  if (target === null) return <span className="text-muted">new sender</span>
  if (target === INBOX) return <span className="text-muted">→ Keep in Inbox</span>
  return <span className="text-accent">→ {target}</span>
}

function ConnDot({ state }: { state: string }): React.JSX.Element {
  const cls =
    state === 'connected'
      ? 'bg-ok'
      : state === 'connecting'
        ? 'bg-warn animate-pulse'
        : state === 'error'
          ? 'bg-danger'
          : 'bg-muted'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${cls}`} />
}

/* -------------------------------- cleanup tab ---------------------------- */

function CleanupTab(): React.JSX.Element {
  const s = useCleanup()
  const known = s.plan.filter((p) => p.isKnown)
  const unknown = s.plan.filter((p) => !p.isKnown)
  const autoFiling = known.filter((k) => k.currentTarget)
  const folderOptions = [...new Set([REVIEW_FOLDER, ...s.folders])]

  if (s.conn !== 'connected') {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-raised text-accent">
            <Plug size={26} />
          </span>
          <h2 className="mt-4 text-lg font-bold">Connect to classic Outlook</h2>
          <p className="mt-2 text-sm text-muted">
            This module drives your classic Outlook desktop over COM automation — everything runs
            inside WICKED. The &quot;new Outlook&quot; app and webmail are not supported.
          </p>
          <button
            onClick={() => void s.connect()}
            disabled={s.busy}
            className="mx-auto mt-5 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy ? <Loader2 size={15} className="animate-spin" /> : <Plug size={15} />}
            Connect
          </button>
        </div>
      </div>
    )
  }

  if (s.plan.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-raised text-accent">
            <MailCheck size={26} />
          </span>
          <h2 className="mt-4 text-lg font-bold">Scan your inbox</h2>
          <p className="mt-2 text-sm text-muted">
            Read the most recent {fmtCount(500)} inbox messages and group them by sender so you can
            bulk-file them. Nothing moves until you press Apply.
          </p>
          <button
            onClick={() => void s.scan()}
            disabled={s.busy}
            className="mx-auto mt-5 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Scan Inbox
          </button>
        </div>
      </div>
    )
  }

  const assignedCount = Object.keys(s.assignments).length

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {/* summary */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          {fmtCount(s.headers.length)} scanned · {fmtCount(unknown.length)} new sender(s) ·{' '}
          {fmtCount(autoFiling.length)} known auto-filing
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={s.fileSuggestedJunk}
            disabled={s.busy}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 font-medium text-ink hover:bg-edge/60 disabled:opacity-40"
          >
            <SquareStack size={13} /> File suggested junk
          </button>
          <button
            onClick={() => void s.apply()}
            disabled={s.busy || (assignedCount === 0 && autoFiling.length === 0)}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy ? <Loader2 size={13} className="animate-spin" /> : <MailCheck size={13} />} Apply
          </button>
        </div>
      </div>

      {/* new folder */}
      <div className="flex items-center gap-2">
        <input
          value={s.newFolderName}
          onChange={(e) => s.setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void s.createFolder()
          }}
          placeholder="New folder name…"
          className="w-56 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          onClick={() => void s.createFolder()}
          disabled={s.busy || s.newFolderName.trim().length === 0}
          className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
        >
          <FolderPlus size={14} /> Create folder
        </button>
      </div>

      {/* lists */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        {/* new senders */}
        <section className="flex min-h-0 flex-col rounded-lg border border-edge">
          <div className="border-b border-edge px-3 py-2 text-sm font-semibold">
            New senders to sort ({fmtCount(unknown.length)})
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {unknown.length === 0 ? (
              <div className="p-4 text-sm text-muted">No new senders — everything is already routed.</div>
            ) : (
              unknown.map((row) => <NewSenderRow key={row.key} row={row} folders={folderOptions} />)
            )}
          </div>
        </section>

        {/* already sorted */}
        <section className="flex min-h-0 flex-col rounded-lg border border-edge">
          <div className="border-b border-edge px-3 py-2 text-sm font-semibold">
            Already sorted — auto-files on Apply ({fmtCount(known.length)})
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {known.length === 0 ? (
              <div className="p-4 text-sm text-muted">No known senders yet — file some to teach the rules.</div>
            ) : (
              known.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center gap-2 border-b border-edge/50 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{row.senderName}</div>
                    <div className="truncate text-xs text-muted">{row.senderEmail || row.reason}</div>
                  </div>
                  <span className="shrink-0 tabular-nums text-xs text-muted">×{fmtCount(row.count)}</span>
                  <span className="shrink-0 text-xs">
                    <TargetLabel target={row.currentTarget} />
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function NewSenderRow({ row, folders }: { row: SenderRoute; folders: string[] }): React.JSX.Element {
  const assignments = useCleanup((s) => s.assignments)
  const assign = useCleanup((s) => s.assign)
  const unassign = useCleanup((s) => s.unassign)
  const assigned = row.key in assignments
  const value = assigned ? assignments[row.key] : '__leave__'

  return (
    <div className="flex items-center gap-2 border-b border-edge/50 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{row.senderName}</div>
        <div className="truncate text-xs text-muted">
          {row.senderEmail || '(no address)'} · {row.reason}
        </div>
      </div>
      {row.suggestedTarget === REVIEW_FOLDER && !assigned && (
        <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
          junk?
        </span>
      )}
      <span className="shrink-0 tabular-nums text-xs text-muted">×{fmtCount(row.count)}</span>
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '__leave__') unassign(row.key)
          else assign(row.key, e.target.value)
        }}
        className={`shrink-0 rounded-md border px-2 py-1 text-xs outline-none focus:border-accent ${
          assigned ? 'border-accent bg-accent/10' : 'border-edge bg-raised'
        }`}
      >
        <option value="__leave__">— leave —</option>
        <option value={INBOX}>Keep in Inbox</option>
        {folders.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  )
}

/* -------------------------------- drafts tab ----------------------------- */

function DraftsTab(): React.JSX.Element {
  const s = useCleanup()
  const rows = s.headers.filter((h) => !rulesEvaluate(h.senderEmail, h.hasListUnsubscribe).isLikelyJunk)
  const selectedCount = Object.values(s.draftSelection).filter(Boolean).length

  if (s.conn !== 'connected') {
    return <div className="flex-1 p-8 text-sm text-muted">Connect to Outlook (Cleanup tab) first.</div>
  }
  if (s.headers.length === 0) {
    return (
      <div className="flex-1 p-8 text-sm text-muted">
        Scan your inbox (Cleanup tab) to load repliable messages here.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {!s.hasAiKey && (
        <div className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-warn" />
          <span>
            No AI key set — drafting needs one. Add a Gemini or DeepSeek key in{' '}
            <strong>Settings → API Keys</strong>.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          {fmtCount(rows.length)} repliable · {fmtCount(selectedCount)} selected
        </span>
        <div className="flex items-center gap-1.5">
          {(['today', 7, 30, 'all'] as const).map((r) => (
            <button
              key={String(r)}
              onClick={() => s.selectDraftRange(r)}
              className="rounded-full border border-edge bg-raised px-2.5 py-1 text-xs font-medium text-muted hover:text-ink"
            >
              {r === 'today' ? 'Today' : r === 'all' ? 'All' : `${r}d`}
            </button>
          ))}
          <button
            onClick={s.clearDraftSelection}
            className="rounded-full border border-edge bg-raised px-2.5 py-1 text-xs font-medium text-muted hover:text-ink"
          >
            Clear
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={s.tone}
            onChange={(e) => s.setTone(e.target.value)}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-xs outline-none focus:border-accent"
          >
            {TONES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            onClick={() => void s.draftSelected()}
            disabled={s.busy || selectedCount === 0 || !s.hasAiKey}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            Draft selected ({fmtCount(selectedCount)})
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-edge">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-muted">No repliable (non-automated) messages in the scan.</div>
        ) : (
          rows.map((r) => (
            <label
              key={r.entryId}
              className="flex cursor-pointer items-center gap-2.5 border-b border-edge/50 px-3 py-2 text-sm hover:bg-raised/60"
            >
              <input
                type="checkbox"
                checked={s.draftSelection[r.entryId] === true}
                onChange={() => s.toggleDraft(r.entryId)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span className="w-28 shrink-0 truncate text-xs text-muted">{fmtDateTime(r.receivedTime)}</span>
              <span className="w-44 shrink-0 truncate">{r.senderName || r.senderEmail}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{r.subject || '(no subject)'}</span>
            </label>
          ))
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Reply size={12} /> Drafts are saved to your Outlook Drafts folder for review — nothing is sent.
      </p>
    </div>
  )
}

/* -------------------------------- rules tab ------------------------------ */

function RulesTab(): React.JSX.Element {
  const s = useCleanup()
  const folderOptions = [...new Set([INBOX, REVIEW_FOLDER, ...s.folders])]
  const emailEntries = Object.entries(s.routes.emails)
  const domainEntries = Object.entries(s.routes.domains)
  const subjectEntries = Object.entries(s.routes.subjects)

  const targetName = (t: string): string => (t === INBOX ? 'Keep in Inbox' : t)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* sender rule editor */}
      <section className="rounded-lg border border-edge p-3">
        <div className="text-sm font-semibold">Sender / domain rules</div>
        <p className="mt-1 text-xs text-muted">
          Route a sender to a folder. Use <code>bob@acme.com</code> for one address or{' '}
          <code>acme.com</code> / <code>@acme.com</code> for a whole domain.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={s.ruleEntry}
            onChange={(e) => s.setRuleEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.addRoute()
            }}
            placeholder="bob@acme.com or acme.com"
            className="w-56 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <select
            value={s.ruleTarget}
            onChange={(e) => s.setRuleTarget(e.target.value)}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {folderOptions.map((f) => (
              <option key={f || 'inbox'} value={f}>
                {targetName(f)}
              </option>
            ))}
          </select>
          <button
            onClick={() => void s.addRoute()}
            disabled={s.ruleEntry.trim().length === 0}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            Add rule
          </button>
        </div>
        <div className="mt-3 space-y-1">
          {emailEntries.length + domainEntries.length === 0 ? (
            <div className="text-xs text-muted">No sender rules yet.</div>
          ) : (
            <>
              {emailEntries.map(([k, t]) => (
                <RuleLine key={'e:' + k} label={k} target={targetName(t)} onRemove={() => void s.removeRoute(k, 'email')} />
              ))}
              {domainEntries.map(([k, t]) => (
                <RuleLine key={'d:' + k} label={'@' + k} target={targetName(t)} onRemove={() => void s.removeRoute(k, 'domain')} />
              ))}
            </>
          )}
        </div>
      </section>

      {/* subject rule editor */}
      <section className="rounded-lg border border-edge p-3">
        <div className="text-sm font-semibold">Subject rules</div>
        <p className="mt-1 text-xs text-muted">
          Any email whose subject <em>contains</em> the pattern routes to the folder (overrides sender
          rules). Minimum 3 characters.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={s.subjectPattern}
            onChange={(e) => s.setSubjectPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.addSubjectRule()
            }}
            placeholder="e.g. Invoice"
            className="w-56 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
          <select
            value={s.subjectTarget}
            onChange={(e) => s.setSubjectTarget(e.target.value)}
            className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm outline-none focus:border-accent"
          >
            {folderOptions.map((f) => (
              <option key={f || 'inbox'} value={f}>
                {targetName(f)}
              </option>
            ))}
          </select>
          <button
            onClick={() => void s.addSubjectRule()}
            disabled={s.subjectPattern.trim().length < 3}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            Add rule
          </button>
        </div>
        <div className="mt-3 space-y-1">
          {subjectEntries.length === 0 ? (
            <div className="text-xs text-muted">No subject rules yet.</div>
          ) : (
            subjectEntries.map(([k, t]) => (
              <RuleLine
                key={'s:' + k}
                label={`"${k}"`}
                target={targetName(t)}
                onRemove={() => void s.removeSubjectRule(k)}
              />
            ))
          )}
        </div>
      </section>
    </div>
  )
}

function RuleLine({
  label,
  target,
  onRemove
}: {
  label: string
  target: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-md bg-raised/50 px-2.5 py-1 text-sm">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs text-accent">→ {target}</span>
      <button onClick={onRemove} className="shrink-0 rounded p-1 text-muted hover:bg-danger/15 hover:text-danger">
        <Trash2 size={13} />
      </button>
    </div>
  )
}

/* -------------------------------- history tab ---------------------------- */

function HistoryTab(): React.JSX.Element {
  const history = useCleanup((s) => s.history)
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {history.length === 0 ? (
        <div className="text-sm text-muted">No cleanup runs recorded yet.</div>
      ) : (
        <div className="space-y-3">
          {history.map((b, i) => (
            <div key={i} className="rounded-lg border border-edge">
              <div className="border-b border-edge px-3 py-2 text-sm font-semibold">
                {fmtDateTime(b.createdUtc)} — {fmtCount(b.count)} email(s) filed
              </div>
              <div className="max-h-56 overflow-y-auto">
                {b.items.map((it, j) => (
                  <div key={j} className="flex items-center gap-2 border-b border-edge/40 px-3 py-1.5 text-xs">
                    <span className="w-40 shrink-0 truncate">{it.senderLabel || '(unknown)'}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{it.subject || '(no subject)'}</span>
                    <span className="shrink-0 text-accent">→ {it.targetFolderName}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* --------------------------------- module -------------------------------- */

const TABS: { id: Tab; label: string }[] = [
  { id: 'cleanup', label: 'Cleanup' },
  { id: 'drafts', label: 'AI Drafts' },
  { id: 'rules', label: 'Rules' },
  { id: 'history', label: 'History' }
]

export default function EmailCleanup365(): React.JSX.Element {
  const s = useCleanup()

  // Per-operation progress pushed from the main process.
  useEffect(() => {
    return window.wicked.on(`${ID}:progress`, (msg) => {
      if (typeof msg === 'string') useCleanup.setState({ status: msg })
    })
  }, [])

  // Presence-only API-key status from the shell's central vault (never values).
  useEffect(() => {
    let mounted = true
    void window.wicked.invoke(SHELL_IPC.apiKeysStatus).then((status) => {
      if (!mounted) return
      const st = status as Partial<Record<ApiProviderId, boolean>>
      s.setHasAiKey(st.gemini === true || st.deepseek === true)
    })
    const off = window.wicked.on(SHELL_IPC.apiKeysChanged, (status) => {
      const st = status as Partial<Record<ApiProviderId, boolean>>
      s.setHasAiKey(st.gemini === true || st.deepseek === true)
    })
    return () => {
      mounted = false
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load undo history when opening the History tab.
  useEffect(() => {
    if (s.tab === 'history') void s.loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.tab])

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <MailCheck size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">365 Email Cleanup</h1>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted">
            <ConnDot state={s.conn} />
            {s.conn === 'connected'
              ? `Connected${s.account ? ` as ${s.account}` : ''} · ${fmtCount(s.inboxCount)} in inbox`
              : s.conn === 'connecting'
                ? 'Connecting…'
                : s.conn === 'error'
                  ? 'Not connected'
                  : 'Classic Outlook, in-app'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void (s.conn === 'connected' ? s.scan() : s.connect())}
            disabled={s.busy}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {s.busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : s.conn === 'connected' ? (
              <RefreshCw size={14} />
            ) : (
              <Plug size={14} />
            )}
            {s.conn === 'connected' ? 'Scan Inbox' : 'Connect'}
          </button>
          <button
            onClick={() => void s.undo()}
            disabled={s.busy || !s.hasUndo}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            <Undo2 size={14} /> Undo
          </button>
          {s.busy && (
            <button
              onClick={() => void s.cancel()}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
            >
              Cancel
            </button>
          )}
        </div>
      </header>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-edge px-4 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => s.setTab(t.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
              s.tab === t.id
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* error bar */}
      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col">
        {s.tab === 'cleanup' && <CleanupTab />}
        {s.tab === 'drafts' && <DraftsTab />}
        {s.tab === 'rules' && <RulesTab />}
        {s.tab === 'history' && <HistoryTab />}
      </div>

      {/* status bar */}
      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {s.busy && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <ScrollText size={12} className="shrink-0" />
        <span className="truncate">{s.status}</span>
      </footer>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeftRight,
  ArrowUpDown,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  ClipboardCopy,
  Copy,
  Eye,
  FileText,
  FilterX,
  FolderOpen,
  FolderSearch,
  Gauge,
  Globe,
  Info,
  Play,
  Save,
  Shield,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  ALL_FLAGS,
  FLAG_CATEGORIES,
  buildArguments,
  normalizePath,
  useRobocopyStore
} from './store'
import type { FlagCategory, FlagDefinition, FlagSelection, VerdictSeverity } from './store'
import type {
  ExitPayload,
  JobProfileJson,
  LoadProfileResult,
  OkResult,
  ProbeResult,
  ProfileListEntry,
  SaveProfileResult
} from './types'

const ID = 'robocopy-gui'

/* ---------------------------------------------------------------------- *
 *  Module-scope event wiring: the store must keep receiving output and the
 *  exit verdict even while the user is on another module's route (the
 *  component unmounts, the zustand store and the running job do not).
 * ---------------------------------------------------------------------- */
let eventsWired = false
function wireRunEvents(): void {
  if (eventsWired) return
  eventsWired = true
  window.wicked.on(`${ID}:output`, (...args: unknown[]) => {
    useRobocopyStore.getState().appendOutput(args[0] as string[])
  })
  window.wicked.on(`${ID}:exit`, (...args: unknown[]) => {
    useRobocopyStore.getState().finishRun((args[0] as ExitPayload).code)
  })
}

/* ---------------------------------------------------------------------- */
/*  shared bits                                                            */
/* ---------------------------------------------------------------------- */

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Copy,
  ArrowLeftRight,
  FilterX,
  Gauge,
  Globe,
  FileText
}

const inputCls =
  'rounded-lg border border-edge bg-raised px-3 py-2 font-mono text-xs text-ink outline-none placeholder:text-muted/70 focus:border-accent'
const btnSecondaryCls =
  'inline-flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium text-ink hover:bg-edge/60 disabled:cursor-not-allowed disabled:opacity-40'
const btnPrimaryCls =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40'

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

interface PendingRun {
  dry: boolean
  insideSource: boolean
  dangerous: FlagDefinition[]
}

/* ---------------------------------------------------------------------- */
/*  flag rows / categories                                                 */
/* ---------------------------------------------------------------------- */

function FlagRow({ def }: { def: FlagDefinition }): React.JSX.Element {
  const state = useRobocopyStore((s) => s.flags[def.switch])
  const setFlagOn = useRobocopyStore((s) => s.setFlagOn)
  const setFlagValue = useRobocopyStore((s) => s.setFlagValue)

  const browseLogFile = async (): Promise<void> => {
    const picked = (await window.wicked.invoke(`${ID}:pick-log-file`)) as string | null
    if (picked) {
      setFlagValue(def.switch, picked)
      setFlagOn(def.switch, true)
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <input
        type="checkbox"
        checked={state.on}
        onChange={(e) => setFlagOn(def.switch, e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--wk-accent))]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm font-semibold ${def.dangerous ? 'text-danger' : 'text-ink'}`}>
            {def.title}
          </span>
          <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {def.switch}
          </code>
          {def.needsAdmin && (
            <span className="inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 text-[11px] text-muted">
              <Shield size={11} />
              admin
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted">{def.description}</p>

        {def.kind === 'numeric' && (
          <input
            type="number"
            value={state.value}
            min={def.minNumber}
            max={def.maxNumber}
            onChange={(e) => setFlagValue(def.switch, e.target.value)}
            className={`mt-2 w-40 ${inputCls}`}
          />
        )}
        {def.kind === 'text' && !def.isFilePath && (
          <input
            value={state.value}
            placeholder={def.textHint}
            onChange={(e) => setFlagValue(def.switch, e.target.value)}
            className={`mt-2 w-full ${inputCls}`}
          />
        )}
        {def.kind === 'text' && def.isFilePath && (
          <div className="mt-2 flex gap-2">
            <input
              value={state.value}
              placeholder={def.textHint}
              onChange={(e) => setFlagValue(def.switch, e.target.value)}
              className={`min-w-0 flex-1 ${inputCls}`}
            />
            <button onClick={browseLogFile} className={btnSecondaryCls}>
              Browse…
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function CategoryCard({ category }: { category: FlagCategory }): React.JSX.Element {
  const Icon = CATEGORY_ICONS[category.icon] ?? Copy
  return (
    <section className="rounded-xl border border-edge bg-surface">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
        <Icon size={15} className="text-accent" />
        <h2 className="text-sm font-semibold text-ink">{category.name}</h2>
        {category.isDanger && (
          <span className="text-xs text-danger">can delete data — read carefully</span>
        )}
      </header>
      <div className="divide-y divide-edge/60">
        {category.flags.map((def) => (
          <FlagRow key={def.switch} def={def} />
        ))}
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------------- */
/*  verdict bar                                                            */
/* ---------------------------------------------------------------------- */

const VERDICT_STYLE: Record<VerdictSeverity, { icon: LucideIcon; text: string; border: string }> =
  {
    success: { icon: CircleCheck, text: 'text-ok', border: 'border-ok/40' },
    warning: { icon: TriangleAlert, text: 'text-warn', border: 'border-warn/40' },
    error: { icon: CircleX, text: 'text-danger', border: 'border-danger/40' }
  }

/* ---------------------------------------------------------------------- */
/*  main component                                                         */
/* ---------------------------------------------------------------------- */

export default function RobocopyGui(): React.JSX.Element {
  const st = useRobocopyStore()

  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([])
  const [profileName, setProfileName] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirm, setConfirm] = useState<PendingRun | null>(null)
  const [notice, setNotice] = useState('')
  const [, forceTick] = useState(0)

  const outRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  /* ----- mount: event wiring, probe, profiles, last session ----- */
  useEffect(() => {
    wireRunEvents()
    void (async () => {
      setProbe((await window.wicked.invoke(`${ID}:probe`)) as ProbeResult)
      await refreshProfiles()
      const s = useRobocopyStore.getState()
      if (!s.sessionRestored) {
        s.setSessionRestored()
        const session = (await window.wicked.invoke(`${ID}:session-load`)) as JobProfileJson | null
        if (session) useRobocopyStore.getState().applyProfile(session)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----- elapsed-time ticker while running ----- */
  useEffect(() => {
    if (!st.running) return undefined
    const t = setInterval(() => forceTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [st.running])

  /* ----- debounced last-session save (replaces save-on-close) ----- */
  useEffect(() => {
    if (!st.sessionRestored) return undefined
    const t = setTimeout(() => {
      void window.wicked.invoke(`${ID}:session-save`, useRobocopyStore.getState().collectProfile())
    }, 800)
    return () => clearTimeout(t)
  }, [st.source, st.destination, st.customFlags, st.flags, st.sessionRestored])

  /* ----- auto-scroll the output pane while pinned to the bottom ----- */
  useEffect(() => {
    const el = outRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [st.output])

  /* ----- derived ----- */
  const selections: FlagSelection[] = ALL_FLAGS.map((def) => ({
    def,
    on: st.flags[def.switch].on,
    value: st.flags[def.switch].value
  }))

  const previewCommand =
    'robocopy ' +
    buildArguments(
      st.source.trim() ? st.source : '<source>',
      st.destination.trim() ? st.destination : '<destination>',
      selections,
      st.customFlags,
      false
    )

  const adminFlagOn = ALL_FLAGS.some((d) => d.needsAdmin && st.flags[d.switch].on)
  const canRun = probe?.available === true && !st.running

  let status = 'Ready.'
  if (st.running && st.startedAt !== null) {
    status = `${st.runIsDry ? 'Previewing…' : 'Copying…'}  ${st.filesCopied.toLocaleString()} files copied${
      st.errors > 0 ? ` · ${st.errors} error(s)` : ''
    } · ${fmtElapsed(Date.now() - st.startedAt)} elapsed`
  } else if (notice) {
    status = notice
  } else if (st.finishedAt !== null && st.startedAt !== null) {
    status = `Done in ${fmtElapsed(st.finishedAt - st.startedAt)} — ${st.filesCopied.toLocaleString()} files copied${
      st.errors > 0 ? `, ${st.errors} error(s)` : ''
    }.`
  }

  /* ----- handlers ----- */
  async function refreshProfiles(): Promise<void> {
    setProfiles((await window.wicked.invoke(`${ID}:profiles-list`)) as ProfileListEntry[])
  }

  const browse = async (which: 'source' | 'dest'): Promise<void> => {
    const title = which === 'source' ? 'Pick the folder to copy FROM' : 'Pick the folder to copy TO'
    const current = which === 'source' ? st.source : st.destination
    const picked = (await window.wicked.invoke(`${ID}:pick-folder`, title, current)) as
      | string
      | null
    if (picked) (which === 'source' ? st.setSource : st.setDestination)(picked)
  }

  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(previewCommand)
      setNotice('Command copied to clipboard.')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNotice("Couldn't access the clipboard — try again.")
    }
  }

  const fail = (message: string): void => {
    st.setVerdict({ severity: 'error', title: message, details: [] })
  }

  /** Same validation + confirmation flow as StartJob() in MainWindow.xaml.cs. */
  const startJob = async (dry: boolean): Promise<void> => {
    if (st.running) return
    setNotice('')

    const source = normalizePath(st.source)
    const dest = normalizePath(st.destination)
    if (source.length === 0)
      return fail("Pick a source folder first — that's the folder you want to copy.")
    if (dest.length === 0)
      return fail("Pick a destination folder — that's where the files should go.")
    if (source.toLowerCase() === dest.toLowerCase())
      return fail('Source and destination are the same folder.')
    const sourceExists = (await window.wicked.invoke(`${ID}:dir-exists`, source)) as boolean
    if (!sourceExists) return fail(`The source folder doesn't exist: ${source}`)

    const insideSource = dest.toLowerCase().startsWith(source.toLowerCase() + '\\')
    const dangerous = dry
      ? []
      : ALL_FLAGS.filter((d) => d.dangerous && st.flags[d.switch].on)

    if (insideSource || dangerous.length > 0) {
      setConfirm({ dry, insideSource, dangerous })
      return
    }
    await launch(dry)
  }

  const launch = async (dry: boolean): Promise<void> => {
    const state = useRobocopyStore.getState()
    const sels: FlagSelection[] = ALL_FLAGS.map((def) => ({
      def,
      on: state.flags[def.switch].on,
      value: state.flags[def.switch].value
    }))
    const args = buildArguments(state.source, state.destination, sels, state.customFlags, dry)

    if (state.runElevated) {
      setNotice('Waiting for the UAC prompt…')
      const res = (await window.wicked.invoke(`${ID}:run-elevated`, args)) as OkResult
      setNotice(
        res.ok
          ? 'Elevated job launched in its own console window — output and results appear there.'
          : `Elevated launch failed: ${res.error}`
      )
      return
    }

    state.startRun(args, dry)
    const res = (await window.wicked.invoke(`${ID}:run`, args)) as OkResult
    if (!res.ok) {
      const now = useRobocopyStore.getState()
      now.appendOutput([`Failed to start robocopy: ${res.error ?? 'unknown error'}`])
      now.finishRun(16)
    }
  }

  const cancel = (): void => {
    void window.wicked.invoke(`${ID}:cancel`)
  }

  const saveProfile = async (): Promise<void> => {
    const name = profileName.trim()
    if (!name) return
    const res = (await window.wicked.invoke(
      `${ID}:profile-save`,
      name,
      st.collectProfile()
    )) as SaveProfileResult
    if (res.ok) {
      setNotice(`Job saved to ${res.file}.`)
      setProfileName('')
      await refreshProfiles()
    } else {
      setNotice(`Couldn't save the job file: ${res.error}`)
    }
  }

  const applyProfileFile = async (p: ProfileListEntry): Promise<void> => {
    const res = (await window.wicked.invoke(`${ID}:profile-load`, p.file)) as LoadProfileResult
    if (res.ok && res.profile) {
      st.applyProfile(res.profile)
      setNotice(`Job loaded from ${p.file}.`)
    } else {
      setNotice(`Couldn't load the job file: ${res.error}`)
    }
  }

  const deleteProfile = async (p: ProfileListEntry): Promise<void> => {
    const res = (await window.wicked.invoke(`${ID}:profile-delete`, p.file)) as OkResult
    if (res.ok) {
      setNotice(`Deleted ${p.file}.`)
      await refreshProfiles()
    } else {
      setNotice(`Couldn't delete: ${res.error}`)
    }
  }

  const verdictStyle = st.verdict ? VERDICT_STYLE[st.verdict.severity] : null
  const VerdictIcon = verdictStyle?.icon ?? Info

  /* ----- render ----- */
  return (
    <div className="relative flex h-full min-h-0 gap-4 overflow-hidden p-4 text-ink">
      {/* ================= LEFT: paths + flags + profiles ================= */}
      <div className="flex min-w-0 flex-[11] flex-col gap-3 overflow-y-auto pr-1">
        {/* paths */}
        <div className="rounded-xl border border-edge bg-surface p-4">
          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-sm font-semibold">Source</label>
            <input
              value={st.source}
              onChange={(e) => st.setSource(e.target.value)}
              placeholder="Folder to copy FROM  (e.g. D:\Photos or \\server\share)"
              className={`min-w-0 flex-1 ${inputCls}`}
            />
            <button onClick={() => void browse('source')} className={btnSecondaryCls}>
              <FolderSearch size={14} />
              Browse…
            </button>
            <button
              onClick={st.swapPaths}
              title="Swap source and destination"
              className={btnSecondaryCls}
            >
              <ArrowUpDown size={14} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label className="w-24 shrink-0 text-sm font-semibold">Destination</label>
            <input
              value={st.destination}
              onChange={(e) => st.setDestination(e.target.value)}
              placeholder="Folder to copy TO  (created if it doesn't exist)"
              className={`min-w-0 flex-1 ${inputCls}`}
            />
            <button onClick={() => void browse('dest')} className={btnSecondaryCls}>
              <FolderSearch size={14} />
              Browse…
            </button>
          </div>
        </div>

        {/* flag categories */}
        {FLAG_CATEGORIES.map((cat) => (
          <CategoryCard key={cat.name} category={cat} />
        ))}

        {/* custom flags */}
        <div className="rounded-xl border border-edge bg-surface p-4">
          <h2 className="text-sm font-semibold">Extra flags (advanced)</h2>
          <p className="mt-0.5 text-xs text-muted">
            Anything you type here is added to the command exactly as written.
          </p>
          <input
            value={st.customFlags}
            onChange={(e) => st.setCustomFlags(e.target.value)}
            placeholder="e.g.  /MAXAGE:30 /XA:H"
            className={`mt-2 w-full ${inputCls}`}
          />
        </div>

        {/* profiles */}
        <section className="rounded-xl border border-edge bg-surface">
          <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
            <Save size={15} className="text-accent" />
            <h2 className="text-sm font-semibold">Job profiles</h2>
            <span className="hidden text-xs text-muted xl:inline">
              *.rcjob.json — compatible with the standalone app
            </span>
            <button
              onClick={() => void window.wicked.invoke(`${ID}:open-profiles-folder`)}
              title="Open the profiles folder"
              className="ml-auto rounded p-1 text-muted hover:bg-raised hover:text-ink"
            >
              <FolderOpen size={14} />
            </button>
          </header>
          <div className="p-4">
            <div className="flex gap-2">
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveProfile()
                }}
                placeholder="Profile name"
                className={`min-w-0 flex-1 ${inputCls}`}
              />
              <button
                onClick={() => void saveProfile()}
                disabled={!profileName.trim()}
                className={btnSecondaryCls}
              >
                <Save size={14} />
                Save current job
              </button>
            </div>
            {profiles.length === 0 ? (
              <p className="mt-3 text-xs text-muted">No saved profiles yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-edge/60 overflow-hidden rounded-lg border border-edge">
                {profiles.map((p) => (
                  <li key={p.file} className="flex items-center gap-2 bg-raised/30 px-3 py-2">
                    <FileText size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={p.file}>
                      {p.name}
                    </span>
                    <button
                      onClick={() => void applyProfileFile(p)}
                      className="rounded bg-raised px-2 py-1 text-xs font-medium hover:bg-edge/60"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => void deleteProfile(p)}
                      title={`Delete ${p.file}`}
                      className="rounded p-1 text-muted hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* ================= RIGHT: command + run + output ================= */}
      <div className="flex min-w-0 flex-[9] flex-col gap-3">
        {/* command preview */}
        <div className="rounded-xl border border-edge bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Command</h2>
            <button
              onClick={() => void copyCommand()}
              title="Copy the command to the clipboard"
              className={btnSecondaryCls}
            >
              {copied ? <ClipboardCheck size={14} className="text-ok" /> : <ClipboardCopy size={14} />}
              Copy
            </button>
          </div>
          <div className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-raised/50 p-2.5">
            <code className="whitespace-pre-wrap break-all font-mono text-xs">{previewCommand}</code>
          </div>
        </div>

        {/* run buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void startJob(false)} disabled={!canRun} className={btnPrimaryCls}>
            <Play size={15} />
            Run
          </button>
          <button
            onClick={() => void startJob(true)}
            disabled={!canRun}
            title="Runs robocopy in list-only mode (/L) — shows what WOULD happen without copying or deleting anything"
            className={btnSecondaryCls}
          >
            <Eye size={14} />
            Preview (no changes)
          </button>
          <button onClick={cancel} disabled={!st.running} className={btnSecondaryCls}>
            <Square size={13} />
            Cancel
          </button>
          <span className="mx-1 h-6 w-px bg-edge" />
          <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={st.runElevated}
              onChange={(e) => st.setRunElevated(e.target.checked)}
              className="h-4 w-4 accent-[rgb(var(--wk-accent))]"
            />
            <Shield size={14} className={st.runElevated ? 'text-accent' : 'text-muted'} />
            Run elevated (UAC)
          </label>
        </div>

        {/* info / warning bars */}
        {probe !== null && !probe.available && (
          <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-surface p-3 text-sm">
            <CircleX size={16} className="mt-0.5 shrink-0 text-danger" />
            <div>
              <div className="font-semibold text-danger">
                robocopy.exe was not found on this computer
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Robocopy ships with Windows Vista/Server 2008 and newer. You can still build a
                command here and copy it to another machine.
              </div>
            </div>
          </div>
        )}

        {adminFlagOn && !st.runElevated && (
          <div className="flex items-start gap-2 rounded-xl border border-warn/40 bg-surface p-3 text-sm">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <div className="font-semibold text-warn">Administrator needed</div>
              <div className="mt-0.5 text-xs text-muted">
                A selected flag needs admin rights to work fully. Turn on “Run elevated (UAC)” to
                launch this job in an elevated console — WICKED itself stays unelevated.
              </div>
            </div>
          </div>
        )}

        {st.runElevated && (
          <div className="flex items-start gap-2 rounded-xl border border-edge bg-surface p-3 text-sm">
            <Info size={16} className="mt-0.5 shrink-0 text-accent" />
            <div className="text-xs text-muted">
              Elevated jobs run in their own console window after a UAC prompt. Live output can’t
              be streamed back into this pane — the console stays open with the full report, or add
              a /LOG file above.
            </div>
          </div>
        )}

        {st.verdict && verdictStyle && (
          <div
            className={`flex items-start gap-2 rounded-xl border bg-surface p-3 text-sm ${verdictStyle.border}`}
          >
            <VerdictIcon size={16} className={`mt-0.5 shrink-0 ${verdictStyle.text}`} />
            <div className="min-w-0 flex-1">
              <div className={`font-semibold ${verdictStyle.text}`}>{st.verdict.title}</div>
              {st.verdict.details.length > 0 && (
                <div className="mt-0.5 text-xs text-muted">{st.verdict.details.join('  ')}</div>
              )}
            </div>
            <button
              onClick={() => st.setVerdict(null)}
              className="rounded p-0.5 text-muted hover:bg-raised hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* progress + status */}
        <div>
          {st.running && (
            <div className="mb-1.5 h-1 w-full overflow-hidden rounded bg-raised">
              <div className="h-full w-full animate-pulse rounded bg-accent" />
            </div>
          )}
          <p className="text-xs text-muted">{status}</p>
        </div>

        {/* output console */}
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-edge bg-surface">
          <header className="flex items-center gap-2 border-b border-edge px-4 py-2">
            <Terminal size={14} className="text-accent" />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Output</h2>
          </header>
          <div
            ref={outRef}
            onScroll={(e) => {
              const el = e.currentTarget
              pinnedRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
            }}
            className="min-h-0 flex-1 overflow-auto p-3"
          >
            <pre
              className={`whitespace-pre font-mono text-[11px] leading-4 ${st.output ? 'text-ink' : 'text-muted'}`}
            >
              {st.output || 'Output will appear here when a job runs.'}
            </pre>
          </div>
        </div>
      </div>

      {/* ================= confirm modal ================= */}
      {confirm && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-6">
          <div className="w-full max-w-lg rounded-xl border border-edge bg-surface p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <TriangleAlert size={18} className="text-danger" />
              <h3 className="text-base font-bold">
                {confirm.dangerous.length > 0
                  ? 'This job can delete files'
                  : 'Destination inside source'}
              </h3>
            </div>

            {confirm.insideSource && (
              <p className="mt-3 text-sm">
                The destination is INSIDE the source folder. Robocopy can end up copying the folder
                into itself over and over.
              </p>
            )}

            {confirm.dangerous.length > 0 && (
              <div className="mt-3">
                <p className="text-sm font-semibold">This job uses flags that DELETE files:</p>
                <ul className="mt-2 space-y-1.5">
                  {confirm.dangerous.map((d) => (
                    <li key={d.switch} className="flex items-baseline gap-2 text-sm">
                      <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-danger">
                        {d.switch}
                      </code>
                      <span>{d.title}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-muted">
                  Double-check the source and destination before continuing.
                </p>
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirm(null)} className={btnSecondaryCls}>
                Cancel
              </button>
              <button
                onClick={() => {
                  const pending = confirm
                  setConfirm(null)
                  void launch(pending.dry)
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
              >
                <Play size={14} />
                Run it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

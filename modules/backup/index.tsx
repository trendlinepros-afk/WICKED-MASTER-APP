import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cloud,
  DatabaseBackup,
  FolderSearch,
  Layers,
  Loader2,
  Network,
  Pencil,
  Play,
  Plus,
  Power,
  RotateCcw,
  Trash2,
  UploadCloud,
  X,
  XCircle
} from 'lucide-react'
import { useBackup } from './store'
import type { PlanView } from './types'
import { describeSchedule } from './lib/schedule'
import PlanEditor from './components/PlanEditor'
import Overview from './components/Overview'
import Recovery from './components/Recovery'
import Activity from './components/Activity'
import { btn, btnAccent, btnDanger, fmtAgo, fmtShort, JobProgressView, Modal, StatusIcon, Toggle } from './components/ui'

/* -------------------------------- sidebar -------------------------------- */

function PlanCard({ p, active, running }: { p: PlanView; active: boolean; running: boolean }): React.JSX.Element {
  const select = useBackup((s) => s.select)
  const status = running ? 'running' : (p.lastRun?.status ?? null)
  return (
    <button
      onClick={() => select(p.id)}
      className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-transparent hover:bg-raised'
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={status} size={15} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.name}</span>
        {p.cloud.enabled && <Cloud size={12} className="shrink-0 text-muted" />}
      </div>
      <div className="mt-0.5 pl-[23px] text-[11px] text-muted">
        {running
          ? 'Running now…'
          : !p.isLocalMachine
            ? `Runs on ${p.machine}`
            : p.nextRun
              ? `Next: ${fmtShort(p.nextRun)}`
              : p.enabled
                ? 'Manual'
                : 'Schedule paused'}
        {p.lastRun && !running ? ` · last ${fmtAgo(p.lastRun.at)}` : ''}
      </div>
    </button>
  )
}

/* ------------------------------- welcome ------------------------------- */

function Welcome(): React.JSX.Element {
  const openEditor = useBackup((s) => s.openEditor)
  const openExisting = useBackup((s) => s.openExisting)
  const feat = (icon: React.ReactNode, title: string, body: string): React.JSX.Element => (
    <div className="flex gap-3 rounded-xl border border-edge bg-surface p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">{icon}</div>
      <div>
        <div className="text-sm font-semibold text-ink">{title}</div>
        <p className="mt-0.5 text-xs text-muted">{body}</p>
      </div>
    </div>
  )
  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15">
          <DatabaseBackup size={28} className="text-accent" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-ink">Backup</h1>
          <p className="text-sm text-muted">Protect your files and folders — on a schedule, with every version one click from a restore.</p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
        {feat(<Layers size={18} />, 'Full or incremental', 'Choose complete copies every time, or copy only what changed after the first full backup.')}
        {feat(<Network size={18} />, 'Local, USB or network share', 'Back up to another drive or a NAS share (\\\\server\\share) with its own login.')}
        {feat(<Cloud size={18} />, 'Offsite copy in Google Drive', 'Each version is also uploaded to your Drive (via File Vault) and checksum-verified.')}
        {feat(<RotateCcw size={18} />, 'Browse & restore', 'Open any version, search for a file, see its history, restore it anywhere.')}
      </div>
      <div className="mt-6 flex gap-2">
        <button className={btnAccent} onClick={() => openEditor(null)}>
          <Plus size={15} /> Create your first backup
        </button>
        <button className={btn} onClick={() => void openExisting()}>
          <FolderSearch size={15} /> Open existing backup…
        </button>
      </div>
    </div>
  )
}

/* ------------------------------- plan pane ------------------------------- */

function DeletePlanModal({ plan, onClose }: { plan: PlanView; onClose: () => void }): React.JSX.Element {
  const deletePlan = useBackup((s) => s.deletePlan)
  const showToast = useBackup((s) => s.showToast)
  const [withData, setWithData] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Modal title={`Delete “${plan.name}”?`} onClose={onClose}>
      <p className="text-sm text-muted">The plan and its schedule are removed from WICKED.</p>
      <label className="mt-3 flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" className="mt-1" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
        <span>
          Also delete all of its backup versions from <span className="font-mono text-xs">{plan.destination.path}</span>
          {plan.cloud.enabled ? ' and move its Google Drive copy to the Drive trash' : ''}. <b className="text-danger">This can’t be undone.</b>
        </span>
      </label>
      {!withData && <p className="mt-2 text-xs text-muted">Backups stay on disk — you can bring them back later with “Open existing backup”.</p>}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={btn} onClick={onClose}>
          Cancel
        </button>
        <button
          className={btnDanger}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await deletePlan(plan.id, withData)
            setBusy(false)
            if (!r.ok) setError(r.error ?? 'Could not delete')
            else {
              if (r.note) showToast('warn', `Plan deleted${r.note}`)
              onClose()
            }
          }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
        </button>
      </div>
    </Modal>
  )
}

function PlanPane({ plan }: { plan: PlanView }): React.JSX.Element {
  const s = useBackup()
  const [menu, setMenu] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const running = s.queue.running?.planId === plan.id ? s.queue.running : null
  const queued = s.queue.queued.filter((q) => q.planId === plan.id)

  const tab = (id: typeof s.tab, label: string): React.JSX.Element => (
    <button
      onClick={() => s.setTab(id)}
      className={`border-b-2 px-1 pb-2 text-sm ${s.tab === id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-edge px-6 pt-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold text-ink">{plan.name}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {plan.mode === 'incremental' ? 'Incremental' : 'Full'} · {describeSchedule(plan.schedule)}
              {!plan.enabled && plan.schedule.kind !== 'manual' ? ' (paused)' : ''}
              {plan.cloud.enabled ? ' · + Google Drive copy' : ''}
            </p>
          </div>
          <label className="flex items-center gap-2 pt-1 text-xs text-muted" title="Pause or resume the schedule">
            Schedule <Toggle on={plan.enabled} onChange={(v) => void s.setEnabled(plan.id, v)} disabled={plan.schedule.kind === 'manual'} />
          </label>
          <button className={btn} onClick={() => s.openEditor(plan)}>
            <Pencil size={14} /> Edit
          </button>
          <button className={btn} onClick={() => setDeleting(true)} title="Delete plan">
            <Trash2 size={14} />
          </button>
          <div className="relative flex">
            <button className={`${btnAccent} rounded-r-none`} disabled={plan.busy} onClick={() => void s.run(plan.id)}>
              {plan.busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} {plan.busy ? (running ? 'Running' : 'Queued') : 'Back up now'}
            </button>
            <button className={`${btnAccent} rounded-l-none border-l border-accent-ink/20 px-2`} disabled={plan.busy} onClick={() => setMenu(!menu)}>
              <ChevronDown size={14} />
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-xl border border-edge bg-surface p-1 shadow-xl">
                  <button
                    className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-raised"
                    onClick={() => {
                      setMenu(false)
                      void s.run(plan.id, true)
                    }}
                  >
                    <div className="font-medium">Run a full backup now</div>
                    <div className="text-xs text-muted">Starts a new chain regardless of the scheme</div>
                  </button>
                  {plan.cloud.enabled && (
                    <button
                      className="w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-raised"
                      onClick={() => {
                        setMenu(false)
                        void s.cloudSync(plan.id)
                      }}
                    >
                      <div className="flex items-center gap-1.5 font-medium">
                        <UploadCloud size={14} /> Upload to Google Drive now
                      </div>
                      <div className="text-xs text-muted">Send any versions that aren’t in Drive yet</div>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 flex gap-5">
          {tab('overview', 'Overview')}
          {tab('recovery', 'Browse & restore')}
          {tab('activity', 'Activity')}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className={`flex flex-col gap-4 ${s.tab === 'recovery' ? 'h-full' : ''}`}>
          {!plan.isLocalMachine && (
            <div className="flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
              <AlertTriangle size={16} className="shrink-0 text-warn" />
              <span className="flex-1 text-ink">
                This plan belongs to <b>{plan.machine}</b>, so its schedule doesn’t run on this PC. You can still browse and restore.
              </span>
              <button className={btn} onClick={() => void s.adopt(plan.id)}>
                Run it from this PC instead
              </button>
            </div>
          )}
          {running && <JobProgressView p={running} onCancel={() => void s.cancel(running.jobId)} />}
          {!running && queued.length > 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-edge bg-surface px-4 py-3 text-sm text-muted">
              <Loader2 size={15} className="animate-spin" /> Waiting for another job to finish…
              <button className="ml-auto text-xs text-accent hover:underline" onClick={() => queued.forEach((q) => void s.cancel(q.jobId))}>
                Remove from queue
              </button>
            </div>
          )}
          {s.tab === 'overview' && <Overview plan={plan} />}
          {s.tab === 'recovery' && (
            <div className="min-h-[480px] flex-1">
              <Recovery plan={plan} />
            </div>
          )}
          {s.tab === 'activity' && <Activity plan={plan} />}
        </div>
      </div>
      {deleting && <DeletePlanModal plan={plan} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/* --------------------------------- root --------------------------------- */

export default function Backup(): React.JSX.Element {
  const s = useBackup()

  useEffect(() => {
    let off: (() => void) | undefined
    let dead = false
    void s.init().then((f) => {
      if (dead) f()
      else off = f
    })
    return () => {
      dead = true
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const plan = s.plans.find((p) => p.id === s.selectedId) ?? null
  const otherRunning = s.queue.running && s.queue.running.planId !== s.selectedId ? s.queue.running : null

  if (!s.ready)
    return (
      <div className="flex h-full items-center justify-center bg-bg text-muted">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )

  return (
    <div className="flex h-full bg-bg">
      {s.plans.length > 0 && (
        <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-surface">
          <div className="flex items-center gap-2 px-4 pb-3 pt-5">
            <DatabaseBackup size={20} className="text-accent" />
            <span className="flex-1 text-lg font-bold text-ink">Backup</span>
            <button className={btnAccent} onClick={() => s.openEditor(null)} title="New backup">
              <Plus size={15} /> New
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2">
            {s.plans.map((p) => (
              <PlanCard key={p.id} p={p} active={p.id === s.selectedId} running={s.queue.running?.planId === p.id} />
            ))}
          </div>
          {otherRunning && (
            <button
              className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-left text-xs text-accent"
              onClick={() => s.select(otherRunning.planId)}
            >
              <Loader2 size={13} className="animate-spin" />
              <span className="truncate">
                {otherRunning.kind === 'restore' ? 'Restoring' : 'Backing up'} {otherRunning.planName}…
              </span>
            </button>
          )}
          <div className="space-y-2 border-t border-edge p-3">
            <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-raised hover:text-ink" onClick={() => void s.openExisting()}>
              <FolderSearch size={14} /> Open existing backup…
            </button>
            <label className="flex items-center gap-2 px-2 text-xs text-muted" title="Scheduled backups only run while WICKED is open">
              <Power size={14} />
              <span className="flex-1">Start WICKED with Windows</span>
              <Toggle on={s.settings.openAtLogin} onChange={(v) => void s.setOpenAtLogin(v)} />
            </label>
          </div>
        </aside>
      )}

      <main className="min-w-0 flex-1">{plan ? <PlanPane plan={plan} /> : <div className="h-full overflow-y-auto"><Welcome /></div>}</main>

      {s.editing && <PlanEditor />}

      {s.toast && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-xl ${
            s.toast.kind === 'ok'
              ? 'border-ok/40 bg-surface text-ink'
              : s.toast.kind === 'warn'
                ? 'border-warn/40 bg-surface text-ink'
                : 'border-danger/40 bg-surface text-ink'
          }`}
        >
          {s.toast.kind === 'ok' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
          ) : s.toast.kind === 'warn' ? (
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
          ) : (
            <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          )}
          <span className="flex-1">{s.toast.text}</span>
          <button className="text-muted hover:text-ink" onClick={() => useBackup.setState({ toast: null })}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CheckCircle2,
  Cloud,
  File as FileIcon,
  Folder,
  FolderPlus,
  FilePlus,
  HardDrive,
  Layers,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  Save,
  X,
  XCircle
} from 'lucide-react'
import { useBackup, inv, type PlanDraft } from '../store'
import type { BackupMode, RetentionKind, Schedule, ScheduleKind } from '../types'
import { computeNextRun, DEFAULT_SCHEDULE, describeSchedule } from '../lib/schedule'
import { DEFAULT_EXCLUSIONS } from '../lib/paths'
import { btn, btnAccent, fmtBytes, fmtShort, input, inputSm, Section, Toggle } from './ui'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Draft {
  id?: string
  name: string
  sources: string[]
  exclusions: string[]
  destPath: string
  username: string
  hasPassword: boolean
  /** undefined = keep the saved one; '' + clear = remove */
  password: string
  clearPassword: boolean
  mode: BackupMode
  fullEvery: number
  schedule: Schedule
  retentionKind: RetentionKind
  retentionCount: number
  retentionDays: number
  cloud: boolean
  verifyAfter: boolean
  enabled: boolean
}

function toDraft(p: PlanDraft): Draft {
  return {
    id: p.id,
    name: p.name ?? '',
    sources: p.sources ?? [],
    exclusions: p.exclusions ?? DEFAULT_EXCLUSIONS,
    destPath: p.destination?.path ?? '',
    username: p.destination?.username ?? '',
    hasPassword: p.destination?.hasPassword ?? false,
    password: '',
    clearPassword: false,
    mode: p.mode ?? 'incremental',
    fullEvery: p.fullEvery ?? 6,
    schedule: { ...DEFAULT_SCHEDULE, ...(p.schedule ?? {}) },
    retentionKind: p.retention?.kind ?? 'count',
    retentionCount: p.retention?.count ?? 3,
    retentionDays: p.retention?.days ?? 30,
    cloud: p.cloud?.enabled ?? false,
    verifyAfter: p.verifyAfter ?? true,
    enabled: p.enabled ?? true
  }
}

const isUnc = (p: string): boolean => /^\\\\[^\\]+\\[^\\]+/.test(p.trim())

function SchemeCard({
  active,
  onClick,
  title,
  body,
  icon
}: {
  active: boolean
  onClick: () => void
  title: string
  body: string
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 gap-3 rounded-xl border p-4 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-edge bg-bg hover:border-accent/50'
      }`}
    >
      <div className={`mt-0.5 ${active ? 'text-accent' : 'text-muted'}`}>{icon}</div>
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          {title}
          {active && <CheckCircle2 size={14} className="text-accent" />}
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
      </div>
    </button>
  )
}

function ChainPreview({ mode, fullEvery }: { mode: BackupMode; fullEvery: number }): React.JSX.Element {
  const n = 12
  const blocks: ('F' | 'I')[] = []
  for (let i = 0; i < n; i++) {
    if (mode === 'full') blocks.push('F')
    else if (fullEvery <= 0) blocks.push(i === 0 ? 'F' : 'I')
    else blocks.push(i % (fullEvery + 1) === 0 ? 'F' : 'I')
  }
  return (
    <div className="flex items-end gap-1">
      {blocks.map((b, i) => (
        <div
          key={i}
          title={b === 'F' ? 'Full' : 'Incremental'}
          className={`flex w-5 items-end justify-center rounded-sm text-[9px] font-bold ${
            b === 'F' ? 'h-7 bg-accent text-accent-ink' : 'h-3.5 bg-accent/35 text-transparent'
          } ${b === 'F' && i > 0 ? 'ml-2' : ''}`}
        >
          {b === 'F' ? 'F' : ''}
        </div>
      ))}
      <span className="ml-2 text-[11px] text-muted">→ time</span>
    </div>
  )
}

export default function PlanEditor(): React.JSX.Element {
  const editing = useBackup((s) => s.editing)!
  const drive = useBackup((s) => s.drive)
  const savePlan = useBackup((s) => s.savePlan)
  const closeEditor = useBackup((s) => s.closeEditor)
  const run = useBackup((s) => s.run)
  const refreshDrive = useBackup((s) => s.refreshDrive)
  const navigate = useNavigate()

  const [d, setD] = useState<Draft>(() => toDraft(editing))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [excl, setExcl] = useState('')
  const [showExcl, setShowExcl] = useState(false)
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false })
  const [dragOver, setDragOver] = useState(false)
  const isNew = !d.id

  const up = (patch: Partial<Draft>): void => setD((cur) => ({ ...cur, ...patch }))
  const upSched = (patch: Partial<Schedule>): void => setD((cur) => ({ ...cur, schedule: { ...cur.schedule, ...patch } }))

  const nextRun = useMemo(
    () => (d.enabled ? computeNextRun(d.schedule, Date.now()) : null),
    [d.enabled, d.schedule]
  )

  const addSources = (paths: string[]): void => {
    const cur = new Set(d.sources.map((s) => s.toLowerCase()))
    const add = paths.filter((p) => p && !cur.has(p.toLowerCase()))
    if (!add.length) return
    const sources = [...d.sources, ...add]
    const patch: Partial<Draft> = { sources }
    if (!d.name.trim() && sources.length === 1) {
      const leaf = sources[0].replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      if (leaf) patch.name = leaf.replace(/:$/, ' drive')
    }
    up(patch)
  }

  const pick = async (kind: 'folders' | 'files'): Promise<void> => {
    addSources((await inv('pick-sources', { kind })) as string[])
  }

  const pickDest = async (): Promise<void> => {
    const p = (await inv('pick-folder', { title: 'Where should backups be stored?' })) as string | null
    if (p) up({ destPath: p })
  }

  const testDest = async (): Promise<void> => {
    setTest({ busy: true })
    const r = (await inv('test-destination', {
      path: d.destPath,
      username: isUnc(d.destPath) ? d.username : '',
      password: d.password ? d.password : null,
      planId: d.id
    })) as { ok: boolean; error?: string; free?: number | null }
    setTest(
      r.ok
        ? { busy: false, ok: true, text: `Connected and writable${r.free ? ` · ${fmtBytes(r.free)} free` : ''}` }
        : { busy: false, ok: false, text: r.error ?? 'Not reachable' }
    )
  }

  const save = async (andRun: boolean): Promise<void> => {
    setSaving(true)
    setError('')
    const unc = isUnc(d.destPath)
    const draft: PlanDraft = {
      id: d.id,
      name: d.name,
      sources: d.sources,
      exclusions: d.exclusions,
      destination: { path: d.destPath.trim(), username: unc ? d.username.trim() : '', hasPassword: d.hasPassword },
      mode: d.mode,
      fullEvery: d.fullEvery,
      schedule: d.schedule,
      retention: { kind: d.retentionKind, count: d.retentionCount, days: d.retentionDays },
      cloud: { enabled: d.cloud },
      verifyAfter: d.verifyAfter,
      enabled: d.enabled
    }
    if (d.password) draft.password = d.password
    else if (d.clearPassword || !unc) draft.password = null
    const r = await savePlan(draft)
    setSaving(false)
    if (!r.ok) {
      setError(r.error ?? 'Could not save')
      return
    }
    if (andRun && r.plan) await run(r.plan.id)
  }

  const unc = isUnc(d.destPath)
  const unit = d.mode === 'full' ? 'backups' : 'version chains'

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onMouseDown={closeEditor}>
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-edge bg-bg shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-edge bg-surface px-6 py-4">
          <h2 className="text-lg font-semibold text-ink">{isNew ? 'New backup' : `Edit “${editing.name}”`}</h2>
          <button className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink" onClick={closeEditor}>
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <Section title="Name">
            <input className={input} value={d.name} onChange={(e) => up({ name: e.target.value })} placeholder="e.g. Documents & Photos" autoFocus={isNew} />
          </Section>

          {/* ------------------------------ sources ------------------------------ */}
          <Section
            title="What to back up"
            hint="Folders are backed up with everything inside them. Drag folders or files here, or use the buttons."
            right={
              <div className="flex gap-2">
                <button className={btn} onClick={() => void pick('folders')}>
                  <FolderPlus size={14} /> Add folders
                </button>
                <button className={btn} onClick={() => void pick('files')}>
                  <FilePlus size={14} /> Add files
                </button>
              </div>
            }
          >
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                addSources([...e.dataTransfer.files].map((f) => window.wicked.getPathForFile(f)).filter(Boolean))
              }}
              className={`min-h-[72px] rounded-lg border border-dashed p-2 ${dragOver ? 'border-accent bg-accent/5' : 'border-edge'}`}
            >
              {d.sources.length === 0 ? (
                <div className="flex h-14 items-center justify-center text-sm text-muted">Nothing selected yet — drop folders here</div>
              ) : (
                <ul className="space-y-1">
                  {d.sources.map((s) => (
                    <li key={s} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
                      {/\.[a-z0-9]{1,6}$/i.test(s) ? <FileIcon size={15} className="text-muted" /> : <Folder size={15} className="text-accent" />}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={s}>
                        {s}
                      </span>
                      <button
                        className="rounded p-1 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
                        onClick={() => up({ sources: d.sources.filter((x) => x !== s) })}
                        title="Remove"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="mt-3 text-xs font-medium text-accent hover:underline" onClick={() => setShowExcl(!showExcl)}>
              {showExcl ? 'Hide' : 'Show'} exclusions ({d.exclusions.length})
            </button>
            {showExcl && (
              <div className="mt-2 rounded-lg border border-edge bg-bg p-3">
                <p className="mb-2 text-xs text-muted">
                  Skipped files and folders. A plain name or wildcard (<code>*.iso</code>, <code>node_modules</code>) matches anywhere; a full path
                  (<code>C:\Users\me\Downloads</code>) matches that exact place.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {d.exclusions.map((x) => (
                    <span key={x} className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-0.5 font-mono text-[11px] text-ink">
                      {x}
                      <button className="text-muted hover:text-danger" onClick={() => up({ exclusions: d.exclusions.filter((y) => y !== x) })}>
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    className={`${inputSm} flex-1`}
                    value={excl}
                    placeholder="Add a pattern, e.g. *.mp4"
                    onChange={(e) => setExcl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && excl.trim()) {
                        up({ exclusions: [...new Set([...d.exclusions, excl.trim()])] })
                        setExcl('')
                      }
                    }}
                  />
                  <button
                    className={btn}
                    disabled={!excl.trim()}
                    onClick={() => {
                      up({ exclusions: [...new Set([...d.exclusions, excl.trim()])] })
                      setExcl('')
                    }}
                  >
                    <Plus size={14} /> Add
                  </button>
                  <button className={btn} onClick={() => up({ exclusions: DEFAULT_EXCLUSIONS })} title="Reset to defaults">
                    <RotateCcw size={14} />
                  </button>
                </div>
              </div>
            )}
          </Section>

          {/* ---------------------------- destination ---------------------------- */}
          <Section title="Where to store backups" hint="A local folder, an external drive (E:\Backups) or a network share (\\nas\backups).">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                  {unc ? <Network size={15} /> : <HardDrive size={15} />}
                </span>
                <input
                  className={`${input} pl-9 font-mono text-xs`}
                  value={d.destPath}
                  onChange={(e) => {
                    up({ destPath: e.target.value })
                    setTest({ busy: false })
                  }}
                  placeholder="D:\Backups  or  \\server\share\Backups"
                />
              </div>
              <button className={btn} onClick={() => void pickDest()}>
                Browse…
              </button>
              <button className={btn} disabled={!d.destPath.trim() || test.busy} onClick={() => void testDest()}>
                {test.busy ? <Loader2 size={14} className="animate-spin" /> : null} Test
              </button>
            </div>
            {test.text && (
              <div className={`mt-2 flex items-center gap-1.5 text-xs ${test.ok ? 'text-ok' : 'text-danger'}`}>
                {test.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {test.text}
              </div>
            )}
            {unc && (
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-edge bg-bg p-3">
                <div className="col-span-2 text-xs text-muted">
                  Network login (optional) — leave blank if Windows can already open this share. The password is encrypted on this PC and never
                  leaves it.
                </div>
                <label className="text-xs text-muted">
                  User name
                  <input className={`${input} mt-1`} value={d.username} onChange={(e) => up({ username: e.target.value })} placeholder="NAS\backupuser" />
                </label>
                <label className="text-xs text-muted">
                  Password
                  <input
                    className={`${input} mt-1`}
                    type="password"
                    value={d.password}
                    onChange={(e) => up({ password: e.target.value, clearPassword: false })}
                    placeholder={d.hasPassword && !d.clearPassword ? '•••••••• (saved)' : ''}
                  />
                  {d.hasPassword && !d.clearPassword && (
                    <button className="mt-1 text-[11px] text-muted hover:text-danger" onClick={() => up({ clearPassword: true, password: '' })}>
                      Forget saved password
                    </button>
                  )}
                </label>
              </div>
            )}
            {!isNew && editing.destination?.path && d.destPath.trim() !== editing.destination.path && (
              <p className="mt-2 text-xs text-warn">
                Existing backups stay at the old location. The next backup at the new location starts with a full backup.
              </p>
            )}

            <div className="mt-4 flex items-start gap-3 rounded-lg border border-edge bg-bg p-3">
              <Cloud size={18} className={`mt-0.5 shrink-0 ${d.cloud ? 'text-accent' : 'text-muted'}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">Also keep an offsite copy in Google Drive</div>
                <p className="mt-0.5 text-xs text-muted">
                  After each backup finishes, new versions are uploaded to <b>My Drive › WICKED Backups</b> and checksum-verified. If this PC or
                  the backup drive is lost, you can still browse and restore from Drive.
                </p>
                {d.cloud &&
                  (drive.connected ? (
                    <p className="mt-1.5 text-xs text-ok">Using the Google Drive connected in File Vault{drive.email ? ` (${drive.email})` : ''}.</p>
                  ) : (
                    <p className="mt-1.5 text-xs text-warn">
                      Google Drive isn’t connected yet.{' '}
                      <button className="font-medium text-accent hover:underline" onClick={() => navigate('/m/file-vault')}>
                        Open File Vault to connect
                      </button>{' '}
                      ·{' '}
                      <button className="text-accent hover:underline" onClick={() => void refreshDrive()}>
                        Re-check
                      </button>
                    </p>
                  ))}
              </div>
              <Toggle on={d.cloud} onChange={(v) => up({ cloud: v })} />
            </div>
          </Section>

          {/* ------------------------------- scheme ------------------------------ */}
          <Section title="Backup scheme" hint="How each run is stored.">
            <div className="flex flex-col gap-3 sm:flex-row">
              <SchemeCard
                active={d.mode === 'incremental'}
                onClick={() => up({ mode: 'incremental' })}
                icon={<Layers size={18} />}
                title="Incremental"
                body="The first backup copies everything; each later one copies only files that changed. Fast and space-efficient — recommended."
              />
              <SchemeCard
                active={d.mode === 'full'}
                onClick={() => up({ mode: 'full' })}
                icon={<HardDrive size={18} />}
                title="Full"
                body="Every backup is a complete, independent copy of everything. Simplest to reason about, uses the most space and time."
              />
            </div>
            {d.mode === 'incremental' && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink">
                Start a new full backup after every
                <input
                  type="number"
                  min={0}
                  max={365}
                  className={`${inputSm} w-16`}
                  value={d.fullEvery}
                  onChange={(e) => up({ fullEvery: Math.max(0, Number(e.target.value) || 0) })}
                />
                incremental backups
                <span className="text-xs text-muted">(0 = never)</span>
              </div>
            )}
            <div className="mt-3">
              <ChainPreview mode={d.mode} fullEvery={d.fullEvery} />
            </div>
          </Section>

          {/* ------------------------------ schedule ----------------------------- */}
          <Section
            title="Schedule"
            right={
              <label className="flex items-center gap-2 text-xs text-muted">
                Enabled <Toggle on={d.enabled} onChange={(v) => up({ enabled: v })} />
              </label>
            }
          >
            <div className="flex flex-wrap gap-1 rounded-lg bg-raised p-1">
              {(['manual', 'hourly', 'daily', 'weekly', 'monthly'] as ScheduleKind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => upSched({ kind: k })}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize ${
                    d.schedule.kind === k ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  {k === 'manual' ? 'Manual' : k}
                </button>
              ))}
            </div>
            {d.schedule.kind !== 'manual' && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-ink">
                {d.schedule.kind === 'hourly' && (
                  <>
                    Every
                    <select className={inputSm} value={d.schedule.everyHours} onChange={(e) => upSched({ everyHours: Number(e.target.value) })}>
                      {[1, 2, 3, 4, 6, 8, 12].map((h) => (
                        <option key={h} value={h}>
                          {h} hour{h === 1 ? '' : 's'}
                        </option>
                      ))}
                    </select>
                    starting at
                  </>
                )}
                {d.schedule.kind === 'weekly' && (
                  <div className="flex gap-1">
                    {WEEKDAYS.map((w, i) => {
                      const on = d.schedule.weekdays.includes(i)
                      return (
                        <button
                          key={w}
                          onClick={() =>
                            upSched({ weekdays: on ? d.schedule.weekdays.filter((x) => x !== i) : [...d.schedule.weekdays, i] })
                          }
                          className={`w-11 rounded-md border py-1 text-xs ${on ? 'border-accent bg-accent/15 text-accent' : 'border-edge text-muted hover:text-ink'}`}
                        >
                          {w}
                        </button>
                      )
                    })}
                  </div>
                )}
                {d.schedule.kind === 'monthly' && (
                  <>
                    On day
                    <select className={inputSm} value={d.schedule.monthDay} onChange={(e) => upSched({ monthDay: Number(e.target.value) })}>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                {d.schedule.kind !== 'hourly' && 'at'}
                <input type="time" className={inputSm} value={d.schedule.time} onChange={(e) => upSched({ time: e.target.value || '21:00' })} />
              </div>
            )}
            {d.schedule.kind !== 'manual' && (
              <>
                <label className="mt-3 flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={d.schedule.runMissed} onChange={(e) => upSched({ runMissed: e.target.checked })} />
                  If WICKED was closed at the scheduled time, run the backup a minute after it next starts
                </label>
                <p className="mt-2 text-xs text-muted">
                  {describeSchedule(d.schedule)}
                  {d.enabled && nextRun ? ` · next run ${fmtShort(nextRun)}` : d.enabled ? '' : ' · paused'}. Scheduled backups run while WICKED
                  is open — turn on “Start WICKED with Windows” on the Backup screen so none are missed.
                </p>
              </>
            )}
          </Section>

          {/* ------------------------------ cleanup ------------------------------ */}
          <Section
            title="Cleanup"
            hint={
              d.mode === 'incremental'
                ? 'A version chain is a full backup plus the incrementals built on it. Chains are removed whole (an incremental is useless without its full), and the newest chain is always kept.'
                : 'Old backups are removed after each successful backup. The newest one is always kept.'
            }
          >
            <div className="space-y-2 text-sm text-ink">
              <label className="flex items-center gap-2">
                <input type="radio" checked={d.retentionKind === 'count'} onChange={() => up({ retentionKind: 'count' })} />
                Keep the last
                <input
                  type="number"
                  min={1}
                  className={`${inputSm} w-16`}
                  value={d.retentionCount}
                  onChange={(e) => up({ retentionKind: 'count', retentionCount: Math.max(1, Number(e.target.value) || 1) })}
                />
                {unit}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={d.retentionKind === 'days'} onChange={() => up({ retentionKind: 'days' })} />
                Delete {unit} older than
                <input
                  type="number"
                  min={1}
                  className={`${inputSm} w-16`}
                  value={d.retentionDays}
                  onChange={(e) => up({ retentionKind: 'days', retentionDays: Math.max(1, Number(e.target.value) || 1) })}
                />
                days
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={d.retentionKind === 'all'} onChange={() => up({ retentionKind: 'all' })} />
                Keep everything (never delete old backups)
              </label>
            </div>
            {d.mode === 'incremental' && d.fullEvery === 0 && d.retentionKind !== 'all' && (
              <p className="mt-2 text-xs text-warn">
                With “never” start a new full backup, everything is one chain, so cleanup can never remove anything. Set a full-backup interval to
                let old chains expire.
              </p>
            )}
          </Section>

          <Section title="Options">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={d.verifyAfter} onChange={(e) => up({ verifyAfter: e.target.checked })} />
              Validate each backup after it’s created (re-reads the copies and checks their SHA-256 checksums)
            </label>
          </Section>

          {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-edge bg-surface px-6 py-4">
          <button className={btn} onClick={closeEditor}>
            Cancel
          </button>
          <button className={btn} disabled={saving} onClick={() => void save(false)}>
            <Save size={14} /> Save
          </button>
          <button className={btnAccent} disabled={saving} onClick={() => void save(true)}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {isNew ? 'Save & back up now' : 'Save & run now'}
          </button>
        </div>
      </div>
    </div>
  )
}

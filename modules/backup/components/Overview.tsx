import { useEffect } from 'react'
import { ArrowRight, CalendarClock, Cloud, CloudOff, Database, FolderOpen, Folder, HardDrive, History, Laptop, Network } from 'lucide-react'
import { useBackup, inv } from '../store'
import type { PlanView, VersionInfo } from '../types'
import { describeSchedule } from '../lib/schedule'
import { chainsFrom } from './chains'
import { btn, card, fmtAgo, fmtBytes, fmtCount, fmtDateTime, fmtShort, StatusIcon, statusLabel } from './ui'

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`${card} p-4`}>
      <div className="flex items-center gap-2 text-xs text-muted">
        {icon} {label}
      </div>
      <div className="mt-1.5 text-lg font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  )
}

function FlowBox({ icon, title, lines, tone = 'default' }: { icon: React.ReactNode; title: string; lines: React.ReactNode[]; tone?: 'default' | 'off' }): React.JSX.Element {
  return (
    <div className={`min-w-0 flex-1 rounded-xl border p-4 ${tone === 'off' ? 'border-dashed border-edge bg-bg' : 'border-edge bg-surface'}`}>
      <div className="flex items-center gap-2">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone === 'off' ? 'bg-raised text-muted' : 'bg-accent/15 text-accent'}`}>{icon}</div>
        <div className="text-sm font-semibold text-ink">{title}</div>
      </div>
      <div className="mt-2 space-y-0.5">
        {lines.map((l, i) => (
          <div key={i} className="truncate text-xs text-muted">
            {l}
          </div>
        ))}
      </div>
    </div>
  )
}

function Timeline({ versions, onPick }: { versions: VersionInfo[]; onPick: (id: string) => void }): React.JSX.Element {
  const chains = chainsFrom(versions).slice(-8)
  return (
    <div className="flex flex-wrap items-end gap-3">
      {chains.map((c) => (
        <div key={c[0].id} className="flex items-end gap-0.5 rounded-lg bg-raised/50 p-1.5">
          {c.map((v) => (
            <button
              key={v.id}
              onClick={() => onPick(v.id)}
              title={`${v.kind === 'full' ? 'Full' : 'Incremental'} · ${fmtDateTime(v.createdAt)} · ${fmtCount(v.stats.newFiles)} files stored`}
              className={`w-3.5 rounded-sm transition-opacity hover:opacity-70 ${v.kind === 'full' ? 'h-8 bg-accent' : 'h-4 bg-accent/40'} ${
                v.local ? '' : 'opacity-50'
              }`}
            />
          ))}
        </div>
      ))}
      <span className="pb-1 text-[11px] text-muted">oldest → newest · click to browse</span>
    </div>
  )
}

export default function Overview({ plan }: { plan: PlanView }): React.JSX.Element {
  const vs = useBackup((s) => s.versions[plan.id])
  const loadVersions = useBackup((s) => s.loadVersions)
  const history = useBackup((s) => s.history)
  const drive = useBackup((s) => s.drive)
  const openRecovery = useBackup((s) => s.openRecovery)
  const setTab = useBackup((s) => s.setTab)

  useEffect(() => {
    void loadVersions(plan.id)
  }, [plan.id, loadVersions])

  const list = vs?.list ?? []
  const newest = list[0]
  const localList = list.filter((v) => v.local)
  const used = localList.reduce((a, v) => a + v.stats.newBytes, 0)
  const chains = chainsFrom(list).length
  const recent = history.filter((h) => h.planId === plan.id).slice(0, 5)
  const unc = /^\\\\/.test(plan.destination.path)
  const folders = plan.sources.length

  return (
    <div className="space-y-4">
      {/* flow */}
      <div className="flex flex-col items-stretch gap-2 lg:flex-row lg:items-center">
        <FlowBox
          icon={<Folder size={18} />}
          title="Source"
          lines={[
            `${folders} item${folders === 1 ? '' : 's'}: ${plan.sources.map((s) => s.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || s).join(', ')}`,
            newest ? `${fmtCount(newest.stats.files)} files · ${fmtBytes(newest.stats.bytes)}` : 'Not backed up yet'
          ]}
        />
        <ArrowRight size={18} className="mx-auto shrink-0 rotate-90 text-muted lg:rotate-0" />
        <FlowBox
          icon={unc ? <Network size={18} /> : <HardDrive size={18} />}
          title={unc ? 'Network share' : 'Backup location'}
          lines={[plan.destination.path, localList.length ? `${localList.length} version${localList.length === 1 ? '' : 's'} · ${fmtBytes(used)} used` : vs?.localError ? 'Not reachable right now' : 'No versions yet']}
        />
        <ArrowRight size={18} className="mx-auto shrink-0 rotate-90 text-muted lg:rotate-0" />
        <FlowBox
          icon={plan.cloud.enabled ? <Cloud size={18} /> : <CloudOff size={18} />}
          title="Google Drive copy"
          tone={plan.cloud.enabled ? 'default' : 'off'}
          lines={
            plan.cloud.enabled
              ? [
                  drive.connected ? drive.email || 'Connected' : 'Not connected — open File Vault',
                  `${list.filter((v) => v.cloud === 'complete').length} version(s) offsite`
                ]
              : ['Off', 'Turn on in Edit for an offsite copy']
          }
        />
      </div>

      {/* stats */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat
          icon={<StatusIcon status={plan.lastRun?.status ?? null} size={13} />}
          label="Last backup"
          value={plan.lastRun ? fmtAgo(plan.lastRun.at) : 'Never'}
          sub={plan.lastRun ? statusLabel(plan.lastRun.status) : 'Run it to create the first version'}
        />
        <Stat
          icon={<CalendarClock size={13} />}
          label="Next backup"
          value={!plan.isLocalMachine ? 'Other PC' : plan.nextRun ? fmtShort(plan.nextRun) : plan.enabled ? 'Manual' : 'Paused'}
          sub={describeSchedule(plan.schedule)}
        />
        <Stat
          icon={<History size={13} />}
          label="Versions"
          value={fmtCount(list.length)}
          sub={plan.mode === 'incremental' ? `${chains} chain${chains === 1 ? '' : 's'} · incremental` : 'full backups'}
        />
        <Stat icon={<Database size={13} />} label="Space used" value={fmtBytes(used)} sub="at the backup location" />
      </div>

      {list.length > 0 && (
        <div className={`${card} p-4`}>
          <div className="mb-3 text-sm font-semibold text-ink">Backup chain</div>
          <Timeline versions={list} onPick={(id) => openRecovery(id)} />
        </div>
      )}

      <div className={`${card} p-4`}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink">Recent activity</span>
          <div className="flex gap-2">
            <button className={btn} onClick={() => void inv('reveal', { planId: plan.id })} disabled={!localList.length}>
              <FolderOpen size={14} /> Open backup folder
            </button>
            <button className={btn} onClick={() => setTab('activity')}>
              View all
            </button>
          </div>
        </div>
        {recent.length === 0 ? (
          <p className="py-3 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {recent.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2 text-sm">
                <StatusIcon status={h.status} />
                <span className="w-40 shrink-0 text-xs text-muted">{fmtDateTime(h.endedAt)}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={h.message}>
                  {h.message}
                </span>
                {h.trigger !== 'manual' && (
                  <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">{h.trigger === 'mcp' ? 'AI agent' : h.trigger === 'missed' ? 'missed run' : 'scheduled'}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {!plan.isLocalMachine && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Laptop size={13} /> Created on {plan.machine}
        </div>
      )}
    </div>
  )
}

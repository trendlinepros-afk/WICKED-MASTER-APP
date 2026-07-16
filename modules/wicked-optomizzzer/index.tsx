import { useEffect } from 'react'
import {
  AppWindow,
  ArrowDownToLine,
  Cpu,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  Power,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import {
  fmtBytes,
  fmtUptime,
  ID,
  useOptimizer,
  type InstalledApp,
  type ServiceItem,
  type StartupItem,
  type ViewId
} from './store'

/* ------------------------------- shared bits ------------------------------ */

const NAV: { id: ViewId; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Gauge },
  { id: 'cleaner', label: 'Cleaner', icon: Trash2 },
  { id: 'services', label: 'Services', icon: Wrench },
  { id: 'startup', label: 'Startup', icon: Rocket },
  { id: 'apps', label: 'Installed Apps', icon: AppWindow },
  { id: 'updates', label: 'Updates', icon: ArrowDownToLine }
]

function AdminNote({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-muted">
      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" />
      <span>{text}</span>
    </div>
  )
}

function Notice(): React.JSX.Element | null {
  const notice = useOptimizer((s) => s.notice)
  const progress = useOptimizer((s) => s.progress)
  if (!notice && !progress) return null
  if (progress)
    return (
      <div className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
        <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
        <span>{progress}</span>
      </div>
    )
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm ${
        notice!.kind === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : 'border-danger/40 bg-danger/10 text-danger'
      }`}
    >
      {notice!.text}
    </div>
  )
}

function SectionHeader({
  title,
  subtitle,
  onRefresh,
  busy
}: {
  title: string
  subtitle: string
  onRefresh: () => void
  busy: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>
      <button
        onClick={onRefresh}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Refresh
      </button>
    </div>
  )
}

function Bar({ pct, tone }: { pct: number; tone?: 'accent' | 'warn' | 'danger' }): React.JSX.Element {
  const color = tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-accent'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}

function toneFor(pct: number): 'accent' | 'warn' | 'danger' {
  return pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'accent'
}

/* -------------------------------- dashboard ------------------------------- */

function DashboardView(): React.JSX.Element {
  const d = useOptimizer((s) => s.dashboard)
  const busy = useOptimizer((s) => s.dashboardBusy)
  const load = useOptimizer((s) => s.loadDashboard)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Dashboard"
        subtitle="Live CPU, memory, uptime and disk usage. Read-only — no elevation."
        onRefresh={() => void load()}
        busy={busy}
      />
      {!d ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" /> Reading system status…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-center gap-2 text-sm text-muted">
                <Cpu size={15} /> CPU
              </div>
              <div className="mt-2 text-3xl font-bold">{d.cpuLoad}%</div>
              <div className="mt-2">
                <Bar pct={d.cpuLoad} tone={toneFor(d.cpuLoad)} />
              </div>
              <div className="mt-2 truncate text-xs text-muted" title={d.cpuName}>
                {d.cpuName} · {d.cpuCores} threads
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-center gap-2 text-sm text-muted">
                <MemoryStick size={15} /> Memory
              </div>
              <div className="mt-2 text-3xl font-bold">{d.ramPct}%</div>
              <div className="mt-2">
                <Bar pct={d.ramPct} tone={toneFor(d.ramPct)} />
              </div>
              <div className="mt-2 text-xs text-muted">
                {fmtBytes(d.ramUsed)} / {fmtBytes(d.ramTotal)}
              </div>
            </div>
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-center gap-2 text-sm text-muted">
                <Power size={15} /> Uptime
              </div>
              <div className="mt-2 text-3xl font-bold">{fmtUptime(d.uptimeSec)}</div>
              <div className="mt-3 truncate text-xs text-muted" title={d.osName}>
                {d.osName}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-edge bg-surface p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <HardDrive size={15} /> Disks
            </div>
            <div className="space-y-3">
              {d.drives.map((drv) => {
                const used = drv.total - drv.free
                const pct = drv.total > 0 ? Math.round((used / drv.total) * 100) : 0
                return (
                  <div key={drv.name}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">
                        {drv.name} {drv.label && <span className="text-muted">· {drv.label}</span>}
                      </span>
                      <span className="text-xs text-muted">
                        {fmtBytes(drv.free)} free of {fmtBytes(drv.total)}
                      </span>
                    </div>
                    <Bar pct={pct} tone={toneFor(pct)} />
                  </div>
                )
              })}
              {d.drives.length === 0 && <div className="text-sm text-muted">No fixed drives detected.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* --------------------------------- cleaner -------------------------------- */

function CleanerView(): React.JSX.Element {
  const categories = useOptimizer((s) => s.categories)
  const selected = useOptimizer((s) => s.selected)
  const scanBusy = useOptimizer((s) => s.cleanScanBusy)
  const cleanBusy = useOptimizer((s) => s.cleanBusy)
  const results = useOptimizer((s) => s.cleanResults)
  const scan = useOptimizer((s) => s.scanCleaner)
  const toggle = useOptimizer((s) => s.toggleCategory)
  const runClean = useOptimizer((s) => s.runClean)

  useEffect(() => {
    void scan()
  }, [scan])

  const selectedTotal = categories.filter((c) => selected[c.key]).reduce((n, c) => n + c.sizeBytes, 0)
  const selectedCount = categories.filter((c) => selected[c.key]).length

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Cleaner"
        subtitle="Temp files, prefetch, update cache, recycle bin & more. Cleaning elevates on demand."
        onRefresh={() => void scan()}
        busy={scanBusy}
      />
      <AdminNote text="Cleaning runs as an elevated action — a single Windows UAC prompt appears when you click Clean, because temp, prefetch and update-cache folders are system-owned. WICKED itself stays unelevated." />

      <div className="space-y-2">
        {categories.map((c) => {
          const done = results?.find((r) => r.key === c.key)
          return (
            <label
              key={c.key}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-edge bg-surface px-4 py-3 hover:bg-raised/40"
            >
              <input
                type="checkbox"
                checked={!!selected[c.key]}
                onChange={() => toggle(c.key)}
                className="h-4 w-4 accent-accent"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {c.name}
                  {c.systemScope && (
                    <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
                      admin
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-muted">{c.description}</div>
                {done && (
                  <div className="mt-0.5 text-xs text-ok">
                    {done.outcome === 'empty'
                      ? 'Nothing to remove'
                      : `Freed ${fmtBytes(done.bytesFreed)} · ${done.itemsRemoved} item${done.itemsRemoved === 1 ? '' : 's'}${done.itemsFailed ? ` · ${done.itemsFailed} skipped` : ''}`}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold">{fmtBytes(c.sizeBytes)}</div>
                <div className="text-xs text-muted">{c.fileCount.toLocaleString()} files</div>
              </div>
            </label>
          )
        })}
        {categories.length === 0 && !scanBusy && <div className="text-sm text-muted">No categories.</div>}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void runClean()}
          disabled={cleanBusy || selectedCount === 0}
          className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {cleanBusy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
          Clean {selectedCount > 0 ? `(${fmtBytes(selectedTotal)})` : ''}
        </button>
        <span className="text-xs text-muted">{selectedCount} categor{selectedCount === 1 ? 'y' : 'ies'} selected</span>
      </div>
    </div>
  )
}

/* -------------------------------- services -------------------------------- */

function StatePill({ state }: { state: string }): React.JSX.Element {
  const on = state === 'Running'
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${on ? 'bg-ok/15 text-ok' : 'bg-raised text-muted'}`}
    >
      {state || '—'}
    </span>
  )
}

function ServiceRow({ item }: { item: ServiceItem }): React.JSX.Element {
  const acting = useOptimizer((s) => s.serviceActing) === item.name
  const setService = useOptimizer((s) => s.setService)
  const disabled = item.startMode === 'Disabled'
  return (
    <div className="flex items-center gap-3 border-b border-edge/60 px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium" title={item.displayName}>
            {item.displayName}
          </span>
          {item.isProtected && <ShieldCheck size={13} className="shrink-0 text-accent" />}
          {!item.isMicrosoft && (
            <span className="rounded bg-accent/15 px-1 py-0.5 text-[9px] font-semibold text-accent">3rd-party</span>
          )}
        </div>
        <div className="truncate text-xs text-muted" title={item.name}>
          {item.name} · {item.startMode}
        </div>
      </div>
      <StatePill state={item.state} />
      <div className="flex shrink-0 items-center gap-1.5">
        {acting ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : item.isProtected ? (
          <span className="text-[11px] text-muted">protected</span>
        ) : (
          <>
            {item.state === 'Running' && (
              <button
                onClick={() => void setService(item, '', true)}
                className="rounded bg-raised px-2 py-1 text-xs font-medium hover:bg-edge/60"
              >
                Stop
              </button>
            )}
            <button
              onClick={() => void setService(item, disabled ? 'demand' : 'disabled', !disabled)}
              className={`rounded px-2 py-1 text-xs font-medium ${
                disabled ? 'bg-ok/15 text-ok hover:bg-ok/25' : 'bg-danger/15 text-danger hover:bg-danger/25'
              }`}
            >
              {disabled ? 'Enable' : 'Disable'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function ServicesView(): React.JSX.Element {
  const services = useOptimizer((s) => s.services)
  const busy = useOptimizer((s) => s.servicesBusy)
  const load = useOptimizer((s) => s.loadServices)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Services"
        subtitle={`${services.length} Windows services. Enable / disable / stop elevates on demand.`}
        onRefresh={() => void load()}
        busy={busy}
      />
      <AdminNote text="Disabling, enabling or stopping a service is an elevated action (sc.exe config / Stop-Service). One UAC prompt fires per change. Core system services are protected and can't be weakened." />
      <div className="rounded-xl border border-edge bg-surface">
        {services.length === 0 && busy ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Listing services…
          </div>
        ) : (
          services.map((s) => <ServiceRow key={s.name} item={s} />)
        )}
      </div>
    </div>
  )
}

/* --------------------------------- startup -------------------------------- */

function StartupRow({ item }: { item: StartupItem }): React.JSX.Element {
  const acting = useOptimizer((s) => s.startupActing) === item.approvedValueName
  const toggle = useOptimizer((s) => s.toggleStartup)
  return (
    <div className="flex items-center gap-3 border-b border-edge/60 px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="truncate text-xs text-muted" title={item.command}>
          {item.command}
        </div>
        <div className="text-[11px] text-muted">
          {item.scope} · {item.source === 'StartupFolder' ? 'Startup folder' : 'Registry Run'}
        </div>
      </div>
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
          item.enabled ? 'bg-ok/15 text-ok' : 'bg-raised text-muted'
        }`}
      >
        {item.enabled ? 'Enabled' : 'Disabled'}
      </span>
      <div className="w-20 shrink-0 text-right">
        {acting ? (
          <Loader2 size={14} className="ml-auto animate-spin text-muted" />
        ) : (
          <button
            onClick={() => void toggle(item)}
            className={`rounded px-2 py-1 text-xs font-medium ${
              item.enabled ? 'bg-danger/15 text-danger hover:bg-danger/25' : 'bg-ok/15 text-ok hover:bg-ok/25'
            }`}
          >
            {item.enabled ? 'Disable' : 'Enable'}
          </button>
        )}
      </div>
    </div>
  )
}

function StartupView(): React.JSX.Element {
  const startup = useOptimizer((s) => s.startup)
  const busy = useOptimizer((s) => s.startupBusy)
  const load = useOptimizer((s) => s.loadStartup)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Startup"
        subtitle={`${startup.length} startup entries (registry Run keys + startup folders).`}
        onRefresh={() => void load()}
        busy={busy}
      />
      <AdminNote text="Enabling / disabling a startup entry writes the Explorer StartupApproved flag as an elevated action, so one UAC prompt appears per toggle." />
      <div className="rounded-xl border border-edge bg-surface">
        {startup.length === 0 && busy ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Reading startup entries…
          </div>
        ) : startup.length === 0 ? (
          <div className="p-4 text-sm text-muted">No startup entries found.</div>
        ) : (
          startup.map((s) => <StartupRow key={`${s.scope}-${s.approvedSubkey}-${s.approvedValueName}`} item={s} />)
        )}
      </div>
    </div>
  )
}

/* ------------------------------ installed apps ---------------------------- */

function AppRow({ app }: { app: InstalledApp }): React.JSX.Element {
  const acting = useOptimizer((s) => s.appActing) === app.name
  const uninstall = useOptimizer((s) => s.uninstallApp)
  return (
    <div className="flex items-center gap-3 border-b border-edge/60 px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={app.name}>
          {app.name}
        </div>
        <div className="truncate text-xs text-muted">
          {[app.publisher, app.version].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>
      {app.sizeBytes > 0 && <span className="shrink-0 text-xs text-muted">{fmtBytes(app.sizeBytes)}</span>}
      <div className="w-24 shrink-0 text-right">
        {acting ? (
          <Loader2 size={14} className="ml-auto animate-spin text-muted" />
        ) : (
          <button
            onClick={() => void uninstall(app)}
            className="rounded bg-danger/15 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/25"
          >
            Uninstall
          </button>
        )}
      </div>
    </div>
  )
}

function AppsView(): React.JSX.Element {
  const apps = useOptimizer((s) => s.apps)
  const busy = useOptimizer((s) => s.appsBusy)
  const load = useOptimizer((s) => s.loadApps)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Installed Apps"
        subtitle={`${apps.length} apps from the registry uninstall keys.`}
        onRefresh={() => void load()}
        busy={busy}
      />
      <AdminNote text="Uninstalling runs the app's registered uninstaller as an elevated action (msiexec /x for MSI products). A UAC prompt appears per uninstall; the vendor's own uninstaller may show additional dialogs." />
      <div className="rounded-xl border border-edge bg-surface">
        {apps.length === 0 && busy ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Scanning installed apps…
          </div>
        ) : apps.length === 0 ? (
          <div className="p-4 text-sm text-muted">No apps found.</div>
        ) : (
          apps.map((a) => <AppRow key={`${a.scope}-${a.name}-${a.version}`} app={a} />)
        )}
      </div>
    </div>
  )
}

/* --------------------------------- updates -------------------------------- */

function UpdatesView(): React.JSX.Element {
  const updates = useOptimizer((s) => s.updates)
  const busy = useOptimizer((s) => s.updatesBusy)
  const acting = useOptimizer((s) => s.updateActing)
  const load = useOptimizer((s) => s.loadUpdates)
  const apply = useOptimizer((s) => s.applyUpdate)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Updates"
        subtitle={`${updates.length} app update${updates.length === 1 ? '' : 's'} available via winget.`}
        onRefresh={() => void load()}
        busy={busy}
      />
      <AdminNote text="Applying an update runs winget upgrade as an elevated action, so one UAC prompt appears per update (or once for Update all)." />
      {updates.length > 0 && (
        <button
          onClick={() => void apply(null)}
          disabled={!!acting}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {acting === '*all*' ? <Loader2 size={15} className="animate-spin" /> : <ArrowDownToLine size={15} />}
          Update all
        </button>
      )}
      <div className="rounded-xl border border-edge bg-surface">
        {updates.length === 0 && busy ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Checking winget for upgrades…
          </div>
        ) : updates.length === 0 ? (
          <div className="p-4 text-sm text-muted">Everything is up to date (or winget found nothing).</div>
        ) : (
          updates.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border-b border-edge/60 px-3 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={u.name}>
                  {u.name}
                </div>
                <div className="truncate text-xs text-muted" title={u.id}>
                  {u.id}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs">
                <span className="text-muted">{u.current}</span>
                <span className="mx-1 text-muted">→</span>
                <span className="font-semibold text-ok">{u.available}</span>
              </div>
              <div className="w-20 shrink-0 text-right">
                {acting === u.id ? (
                  <Loader2 size={14} className="ml-auto animate-spin text-muted" />
                ) : (
                  <button
                    onClick={() => void apply(u.id)}
                    disabled={!!acting}
                    className="rounded bg-raised px-2 py-1 text-xs font-medium hover:bg-edge/60 disabled:opacity-40"
                  >
                    Update
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ---------------------------------- shell --------------------------------- */

export default function WickedOptomizzzer(): React.JSX.Element {
  const view = useOptimizer((s) => s.view)
  const setView = useOptimizer((s) => s.setView)

  // Progress stream from elevated actions (see ipc.ts sendProgress).
  useEffect(() => {
    const off = window.wicked.on(`${ID}:progress`, (payload: unknown) => {
      const p = (payload && typeof payload === 'object' ? payload : {}) as {
        phase?: string
        message?: string
      }
      useOptimizer.setState({ progress: p.phase === 'done' ? '' : p.message ?? '' })
    })
    return off
  }, [])

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-edge bg-surface/40 p-3">
        <div className="mb-3 flex items-center gap-2 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raised text-accent">
            <Gauge size={17} />
          </span>
          <span className="text-sm font-bold tracking-tight">Optomizzzer</span>
        </div>
        {NAV.map((n) => {
          const Icon = n.icon
          const active = view === n.id
          return (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised/60 hover:text-ink'
              }`}
            >
              <Icon size={16} />
              {n.label}
            </button>
          )
        })}
        <div className="mt-auto px-2 pt-3 text-[10px] leading-relaxed text-muted">
          WICKED runs unelevated. Individual system changes elevate on demand via a Windows UAC prompt.
        </div>
      </nav>

      <div className="h-full flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-6">
          <Notice />
          {view === 'dashboard' && <DashboardView />}
          {view === 'cleaner' && <CleanerView />}
          {view === 'services' && <ServicesView />}
          {view === 'startup' && <StartupView />}
          {view === 'apps' && <AppsView />}
          {view === 'updates' && <UpdatesView />}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ChevronDown, ChevronLeft, ChevronRight, Circle, FolderOpen, History, Loader2, Play, Radio, Search, Settings2, ShieldAlert, Square, Trash2, X } from 'lucide-react'
import type { AppMeta, AppSummary, Bucket, Metric, Unit } from './lib/compute'
import { Chart, Navigator, type Q } from './ui/chart'
import { AppIcon } from './ui/icon'
import { ID, LIST_LABEL, OVERLAY, RANGES, TAB_LABEL, appName, bytes, dayClock, duration, fmtApp, inv, pct, rate, type Tab } from './ui/format'

/* ---------------------------------------------------------------------------
 *  Performance Analyzer — capture on demand, browse every saved session.
 *  Nothing is sampled until "Start Capture"; "Stop Capture" ends it. The graph
 *  shows any time frame of what was recorded (gaps = not capturing), hovering
 *  names the apps behind each moment, clicking lists all of them.
 * ------------------------------------------------------------------------- */

interface Settings {
  intervalMs: number
  autoStopMin: number
  keepDays: number
}
interface Status {
  capturing: boolean
  startedAt: number | null
  intervalMs: number
  last: { t: number; c: number; m: number; mu: number; g: number | null; d: number | null; p: number; tc: number | null } | null
  settings: Settings
  firstStart: number | null
  sessionCount: number
  bytes: number
  error: string
  supported: boolean
  totalMem: number
}
interface Session {
  id: string
  start: number
  end: number
  intervalMs: number
  samples: number
  peakCpu: number
  peakMem: number
  peakGpu: number | null
  open: boolean
}

const TABS: Tab[] = ['cpu', 'mem', 'disk', 'gpu', 'procs']
const SORTS: { key: Metric | 'name'; label: string }[] = [
  { key: 'cpu', label: 'CPU activity' },
  { key: 'mem', label: 'Memory' },
  { key: 'gpu', label: 'GPU' },
  { key: 'disk', label: 'Disk & I/O' },
  { key: 'name', label: 'Name' }
]

const pref = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(`${ID}.${k}`)
    return v === null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
const savePref = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(`${ID}.${k}`, JSON.stringify(v))
  } catch {
    /* per-viewer convenience only */
  }
}

export default function PerfAnalyzer(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [tab, setTabState] = useState<Tab>(() => pref<Tab>('tab', 'cpu'))
  const [span, setSpanState] = useState<number>(() => pref('span', 3600_000))
  /** null = live (window ends now) */
  const [end, setEnd] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [q, setQ] = useState<Q | null>(null)
  const [lite, setLite] = useState<Q | null>(null)
  const [loading, setLoading] = useState(false)
  const [width, setWidth] = useState(900)
  const [overlays, setOverlays] = useState<string[]>([])
  const [moment, setMoment] = useState<{ b: Bucket } | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSortState] = useState<Metric | 'name'>(() => pref('sort', 'cpu'))
  const [panel, setPanel] = useState<'sessions' | 'settings' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rangeOpen, setRangeOpen] = useState(false)

  const setTab = (t: Tab): void => {
    setTabState(t)
    savePref('tab', t)
    if (t !== 'procs') {
      setSortState(t)
      savePref('sort', t)
    }
  }
  const setSpan = (ms: number): void => {
    setSpanState(ms)
    savePref('span', ms)
  }
  const setSort = (s: Metric | 'name'): void => {
    setSortState(s)
    savePref('sort', s)
  }

  const live = end === null
  const to = live ? now : end
  const from = to - span

  const loadStatus = useCallback(async () => setStatus(await inv<Status>('status')), [])
  useEffect(() => {
    void loadStatus()
    const offs = [
      window.wicked.on(`${ID}:state`, (s) => {
        setStatus(s as Status)
        if ((s as Status).error) setError((s as Status).error)
        setNow(Date.now())
      }),
      window.wicked.on(`${ID}:sample`, (p) => {
        setStatus((s) => (s ? { ...s, last: p as Status['last'] } : s))
        setNow(Date.now())
      }),
      window.wicked.on(`${ID}:meta`, () => setNow(Date.now()))
    ]
    return () => offs.forEach((o) => o())
  }, [])

  // keep "now" moving in live mode even when not capturing (slow), so the window slides
  useEffect(() => {
    if (!live || status?.capturing) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [live, status?.capturing])

  // chart data — live views refresh with each sample, long spans less often
  const lastQuery = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const buckets = Math.max(60, Math.min(900, Math.floor((width - 52) / 3)))
  useEffect(() => {
    const minGap = span <= 3600_000 ? 0 : span <= 86_400_000 ? 15_000 : 60_000
    const run = async (): Promise<void> => {
      lastQuery.current = Date.now()
      setLoading(true)
      const r = await inv<Q & { ok: boolean }>('query', { from, to, buckets })
      setLoading(false)
      if (r.ok) setQ(r)
    }
    const wait = live && status?.capturing ? Math.max(0, lastQuery.current + minGap - Date.now()) : 0
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void run(), wait)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [from, to, buckets, tab])

  // the navigator: all history at a glance
  const histFrom = Math.min(from, status?.firstStart ?? from, now - span)
  useEffect(() => {
    void inv<Q & { ok: boolean }>('query', { from: Math.min(histFrom, now - span * 3), to: Math.max(now, to), buckets: 240, lite: true }).then((r) => r.ok && setLite(r))
  }, [status?.sessionCount, status?.capturing, Math.floor(now / 60_000), span, end === null])

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await inv<{ ok: boolean; error?: string }>('start')
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Couldn’t start.')
    setEnd(null)
    void loadStatus()
  }
  const stop = async (): Promise<void> => {
    setBusy(true)
    await inv('stop')
    setBusy(false)
    void loadStatus()
  }

  const toggleOverlay = (k: string): void => setOverlays((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k].slice(-3)))

  const tabValue = (t: Tab): string => {
    const l = status?.capturing && live ? status.last : null
    if (t === 'procs') return l ? String(l.p) : q?.buckets.slice().reverse().find((b) => b.p !== null)?.p?.toString() ?? '—'
    if (l) return pct(t === 'cpu' ? l.c : t === 'mem' ? l.m : t === 'gpu' ? l.g : l.d)
    return pct(q?.totals.avg[t] ?? null)
  }

  const metric: Metric = tab === 'procs' ? 'cpu' : tab
  const listMetric: Metric = sort === 'name' ? metric : sort
  const apps = useMemo(() => {
    if (!q) return [] as AppSummary[]
    const s = search.trim().toLowerCase()
    const list = q.apps.filter((a) => !s || a.key.includes(s) || appName(a.key, q.meta[a.key]).toLowerCase().includes(s) || (q.meta[a.key]?.company ?? '').toLowerCase().includes(s))
    return list.sort((a, b) => (sort === 'name' ? appName(a.key, q.meta[a.key]).localeCompare(appName(b.key, q.meta[b.key])) : b.avg[sort] - a.avg[sort] || b.max[sort] - a.max[sort])).filter((a) => sort === 'name' || a.avg[sort] > 0 || a.max[sort] > 0 || !!s)
  }, [q, search, sort])

  const stepBy = (dir: -1 | 1): void => {
    const next = to + dir * span * 0.8
    setEnd(next >= Date.now() - 2000 ? null : next)
  }

  const supported = status?.supported !== false

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-ink">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface px-5 py-3">
        <Activity size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Performance Analyzer</div>
          <div className="text-xs text-muted">
            {status?.capturing && status.startedAt ? (
              <span className="flex items-center gap-1.5 text-danger">
                <Circle size={8} className="animate-pulse fill-current" /> Capturing · {duration(now - status.startedAt)} · every {(status.intervalMs / 1000).toFixed(0)}s
              </span>
            ) : (
              'Off — nothing is recorded until you start a capture.'
            )}
          </div>
        </div>
        <button onClick={() => setPanel(panel === 'sessions' ? null : 'sessions')} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium hover:border-accent ${panel === 'sessions' ? 'border-accent text-accent' : 'border-edge'}`}>
          <History size={14} /> Sessions{status?.sessionCount ? ` · ${status.sessionCount}` : ''}
        </button>
        <button onClick={() => setPanel(panel === 'settings' ? null : 'settings')} className={`rounded-lg border p-1.5 hover:border-accent ${panel === 'settings' ? 'border-accent text-accent' : 'border-edge text-muted'}`} title="Capture settings">
          <Settings2 size={15} />
        </button>
        {status?.capturing ? (
          <button onClick={() => void stop()} disabled={busy} className="flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} className="fill-current" />} Stop Capture
          </button>
        ) : (
          <button onClick={() => void start()} disabled={busy || !supported} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} className="fill-current" />} Start Capture
          </button>
        )}
      </div>

      {(error || !supported) && (
        <div className="flex items-center gap-2 border-b border-edge bg-danger/10 px-5 py-2 text-xs text-danger">
          <ShieldAlert size={14} /> <span className="flex-1">{!supported ? 'The Performance Analyzer reads Windows performance counters, so it only captures on Windows.' : error}</span>
          {error && (
            <button onClick={() => setError('')} className="text-muted hover:text-ink">
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {panel === 'settings' && status && <SettingsPanel s={status.settings} capturing={status.capturing} onClose={() => setPanel(null)} onSaved={() => void loadStatus()} />}
      {panel === 'sessions' && (
        <SessionsPanel
          onClose={() => setPanel(null)}
          onView={(s) => {
            const len = Math.max(60_000, s.end - s.start)
            const fit = RANGES.find((r) => r.ms >= len * 1.05) ?? RANGES[RANGES.length - 1]
            setSpan(fit.ms)
            const e = s.start + (fit.ms + len) / 2
            setEnd(e >= Date.now() ? null : e)
            setPanel(null)
          }}
          onChanged={() => void loadStatus()}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-5 pb-8 pt-4">
          {/* metric tabs */}
          <div className="flex flex-wrap items-center gap-1">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${tab === t ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-raised'}`}>
                {TAB_LABEL[t]} <span className={`ml-1 text-xs font-medium ${tab === t ? 'opacity-80' : 'text-muted'}`}>{tabValue(t)}</span>
              </button>
            ))}
            <span className="flex-1" />
            <span className="text-[11px] text-muted">{status?.capturing && live ? 'now' : 'average for this view'}</span>
          </div>

          {/* graph */}
          <div className="mt-3 rounded-2xl border border-edge bg-surface p-4">
            <Chart
              q={q}
              tab={tab}
              overlays={tab === 'disk' ? [] : overlays}
              onPick={(b) => setMoment({ b })}
              onWidth={setWidth}
              loading={loading && !q}
              empty={
                <div className="max-w-md rounded-xl border border-edge bg-surface/90 p-4 text-center text-sm">
                  {status?.capturing ? (
                    <span className="flex items-center justify-center gap-2 text-muted">
                      <Loader2 size={14} className="animate-spin" /> Collecting the first samples…
                    </span>
                  ) : (
                    <>
                      <div className="font-semibold">Nothing recorded in this time frame</div>
                      <div className="mt-1 text-xs text-muted">Press Start Capture — WICKED records CPU, memory, GPU and disk use and which apps caused it, until you press Stop. Nothing runs in the background otherwise. Earlier sessions show here whenever you scroll back to them.</div>
                    </>
                  )}
                </div>
              }
            />
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              {tab !== 'procs' && (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-4 rounded bg-accent" /> average
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-4 rounded-sm bg-accent/20" /> peak
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-0 w-4 border-t border-dashed border-danger" /> spike line
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-danger px-1 text-[9px] font-bold text-white">98%</span> spike
                  </span>
                </>
              )}
              <span className="flex items-center gap-1.5">
                <span className="rounded bg-ok px-1 text-[9px] font-bold text-white">+2</span> apps started
              </span>
              {overlays.length > 0 && tab !== 'disk' && tab !== 'procs' && q && overlays.map((k, i) => (
                <button key={k} onClick={() => toggleOverlay(k)} className="flex items-center gap-1.5 hover:text-ink" title="Remove from the graph">
                  <span className="h-0.5 w-4 rounded" style={{ background: OVERLAY[i] }} /> {appName(k, q.meta[k])} <X size={10} />
                </button>
              ))}
              <span className="flex-1" />
              {q && <span>{q.resolution === 'minute' ? 'per-minute summary' : `${q.totals.samples.toLocaleString()} samples`}</span>}
            </div>
          </div>

          {/* time frame */}
          <div className="mt-3 flex items-center gap-2">
            <div className="relative">
              <button onClick={() => setRangeOpen(!rangeOpen)} className="flex items-center gap-1 rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm font-semibold hover:border-accent">
                {RANGES.find((r) => r.ms === span)?.label ?? '1 Hour'} <ChevronDown size={14} />
              </button>
              {rangeOpen && (
                <div className="absolute bottom-full left-0 z-20 mb-1 w-36 rounded-xl border border-edge bg-surface py-1 shadow-xl" onMouseLeave={() => setRangeOpen(false)}>
                  {RANGES.map((r) => (
                    <button key={r.ms} onClick={() => (setSpan(r.ms), setRangeOpen(false))} className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-raised ${r.ms === span ? 'font-semibold text-accent' : ''}`}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => stepBy(-1)} className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-ink" title="Earlier">
              <ChevronLeft size={16} />
            </button>
            <span className="w-28 text-right text-xs tabular-nums text-muted">{dayClock(from)}</span>
            <Navigator lite={lite} from={from} to={to} span={span} onMove={(e) => setEnd(e >= Date.now() - 2000 ? null : Math.max((status?.firstStart ?? e) + span * 0.2, e))} />
            <span className="w-28 text-xs tabular-nums text-muted">{live ? 'Now' : dayClock(to)}</span>
            <button onClick={() => stepBy(1)} disabled={live} className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-ink disabled:opacity-30" title="Later">
              <ChevronRight size={16} />
            </button>
            <button onClick={() => setEnd(null)} disabled={live} className={`flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-semibold ${live ? 'border-accent text-accent' : 'border-edge hover:border-accent'}`}>
              <Radio size={12} /> Live
            </button>
          </div>

          {/* moment */}
          {moment && q && <MomentPanel b={moment.b} metric={metric} onClose={() => setMoment(null)} />}

          {/* apps */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search size={14} className="absolute left-0.5 top-1/2 -translate-y-1/2 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search app" className="w-full bg-transparent py-1.5 pl-6 text-sm outline-none placeholder:text-muted" />
            </div>
            <label className="flex items-center gap-1 text-sm text-muted">
              Sort by:
              <select value={sort} onChange={(e) => setSort(e.target.value as Metric | 'name')} className="bg-transparent font-medium text-ink outline-none">
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key} className="bg-surface">
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <div className="text-sm font-semibold">{LIST_LABEL[listMetric]}</div>
            <div className="text-xs text-muted">average over the time frame · click an app to draw it on the graph</div>
          </div>
          <div className="mt-2 space-y-1">
            {apps.length === 0 && <div className="rounded-xl border border-dashed border-edge p-6 text-center text-sm text-muted">{q?.totals.samples ? 'No apps match.' : 'Apps appear here once something has been recorded in this time frame.'}</div>}
            {apps.slice(0, 60).map((a) => (
              <AppRow key={a.key} a={a} meta={q!.meta[a.key]} m={listMetric} totalMem={q!.totalMem} color={overlays.includes(a.key) && tab !== 'disk' ? OVERLAY[overlays.indexOf(a.key)] : null} onClick={() => toggleOverlay(a.key)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Spark({ v, color }: { v: (number | null)[]; color: string }): React.JSX.Element {
  const max = Math.max(1e-9, ...v.map((x) => x ?? 0))
  const w = 100
  const h = 24
  const n = v.length
  let d = ''
  let pen = false
  v.forEach((x, i) => {
    if (x === null) {
      pen = false
      return
    }
    const px = (i / Math.max(1, n - 1)) * w
    const py = h - (x / max) * (h - 2)
    d += pen ? `L${px.toFixed(1)},${py.toFixed(1)}` : `M${px.toFixed(1)},${h}L${px.toFixed(1)},${py.toFixed(1)}`
    pen = true
  })
  return (
    <svg width={w} height={h} className="shrink-0">
      <path d={d} fill="none" stroke={color} strokeWidth={1.25} opacity={0.8} />
    </svg>
  )
}

function AppRow({ a, meta, m, totalMem, color, onClick }: { a: AppSummary; meta?: AppMeta; m: Metric; totalMem: number; color: string | null; onClick: () => void }): React.JSX.Element {
  const unsigned = meta?.signed === 'unsigned'
  const odd = meta && meta.signed !== 'valid' && meta.signed !== 'unsigned' && meta.signed !== 'unknown'
  return (
    <div onClick={onClick} className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition hover:border-accent/60 ${color ? 'border-accent/60 bg-accent/5' : 'border-transparent hover:bg-surface'}`}>
      <span className="h-6 w-1 rounded-full" style={{ background: color ?? 'transparent' }} />
      <AppIcon k={a.key} meta={meta} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium" title={meta?.path || a.key}>
          {appName(a.key, meta)}
        </span>
        {a.n > 1 && <span className="shrink-0 text-xs text-muted">×{a.n}</span>}
        {meta?.company && <span className="hidden truncate text-sm text-muted md:inline">{meta.company}</span>}
        {unsigned && <span className="shrink-0 rounded-md bg-warn/20 px-1.5 py-0.5 text-[11px] font-semibold text-warn">Unsigned</span>}
        {odd && <span className="shrink-0 rounded-md bg-danger/15 px-1.5 py-0.5 text-[11px] font-semibold text-danger" title="Authenticode status">{meta!.signed}</span>}
      </div>
      {meta?.path && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            void inv('reveal', meta.path)
          }}
          className="rounded-md p-1 text-muted opacity-0 hover:bg-raised hover:text-ink group-hover:opacity-100"
          title="Open file location"
        >
          <FolderOpen size={14} />
        </button>
      )}
      <Spark v={a.series[m]} color={color ?? 'rgb(var(--wk-accent))'} />
      <div className="w-24 text-right" title={`peak ${fmtApp(m, a.max[m], totalMem)}`}>
        <div className="text-sm font-semibold tabular-nums">{fmtApp(m, a.avg[m], totalMem)}</div>
        <div className="text-[10px] text-muted">peak {fmtApp(m, a.max[m], totalMem)}</div>
      </div>
    </div>
  )
}

function MomentPanel({ b, metric, onClose }: { b: Bucket; metric: Metric; onClose: () => void }): React.JSX.Element {
  const [r, setR] = useState<{ unit?: Unit; totalMem?: number; meta?: Record<string, AppMeta>; empty?: boolean } | null>(null)
  const [m, setM] = useState<Metric>(metric)
  useEffect(() => {
    setR(null)
    void inv<{ ok: boolean; unit?: Unit; totalMem?: number; meta?: Record<string, AppMeta>; empty?: boolean }>('moment', { from: b.t, to: b.t1 }).then(setR)
  }, [b.t, b.t1])
  useEffect(() => setM(metric), [metric])
  const idx: Record<Metric, number> = { cpu: 1, mem: 2, gpu: 3, disk: 4 }
  const rows = r?.unit ? [...r.unit.a].filter((x) => (x[idx[m]] as number) > 0).sort((x, y) => (y[idx[m]] as number) - (x[idx[m]] as number)) : []
  const tm = r?.totalMem ?? 1
  const val = (x: Unit['a'][number]): string => (m === 'mem' ? bytes(x[2]) : m === 'disk' ? rate(x[4]) : pct(x[idx[m]] as number))
  return (
    <div className="mt-3 rounded-2xl border border-accent/40 bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm font-semibold">{b.w > 1 ? `${dayClock(b.t, true)} – ${dayClock(b.t1, true)}` : dayClock(b.t, true)}</div>
        {r?.unit && (
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <span>CPU {pct(r.unit.c[0])} (peak {pct(r.unit.c[1])})</span>
            <span>Memory {pct(r.unit.m[0])} · {bytes(r.unit.mu)}</span>
            {r.unit.g && <span>GPU {pct(r.unit.g[0])}</span>}
            {r.unit.d && <span>Disk {pct(r.unit.d[0])} · R {rate(r.unit.dr)} · W {rate(r.unit.dw)}</span>}
            {r.unit.tc !== null && <span>{Math.round(r.unit.tc)}°C</span>}
            <span>{r.unit.p} processes</span>
          </div>
        )}
        <span className="flex-1" />
        <div className="flex gap-1">
          {(['cpu', 'mem', 'gpu', 'disk'] as Metric[]).map((x) => (
            <button key={x} onClick={() => setM(x)} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${m === x ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-raised'}`}>
              {TAB_LABEL[x]}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
          <X size={15} />
        </button>
      </div>
      {!r ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" /> Loading…
        </div>
      ) : !rows.length ? (
        <div className="mt-3 text-xs text-muted">No app used any {TAB_LABEL[m]} here.</div>
      ) : (
        <div className="mt-3 grid max-h-80 gap-x-6 gap-y-1 overflow-y-auto sm:grid-cols-2">
          {rows.map((x) => {
            const share = m === 'mem' ? (x[2] / tm) * 100 : m === 'disk' ? 0 : (x[idx[m]] as number)
            return (
              <div key={x[0]} className="relative flex items-center gap-2 overflow-hidden rounded-lg px-2 py-1 text-sm">
                {m !== 'disk' && <span className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: `${Math.min(100, share)}%` }} />}
                <AppIcon k={x[0]} meta={r.meta?.[x[0]]} />
                <span className="relative min-w-0 flex-1 truncate">
                  {appName(x[0], r.meta?.[x[0]])}
                  {x[5] > 1 && <span className="ml-1 text-xs text-muted">×{x[5]}</span>}
                </span>
                <span className="relative font-semibold tabular-nums">{val(x)}</span>
              </div>
            )
          })}
          {r.unit && r.unit.o[4] > 0 && <div className="px-2 py-1 text-xs text-muted">+ {r.unit.o[4]} more using next to nothing</div>}
        </div>
      )}
    </div>
  )
}

function SettingsPanel({ s, capturing, onClose, onSaved }: { s: Settings; capturing: boolean; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const [v, setV] = useState(s)
  const save = async (patch: Partial<Settings>): Promise<void> => {
    const next = { ...v, ...patch }
    setV(next)
    await inv('settings-set', next)
    onSaved()
  }
  const sel = 'rounded-lg border border-edge bg-raised px-2 py-1 text-sm outline-none focus:border-accent'
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-edge bg-surface px-5 py-3 text-sm">
      <label className="flex items-center gap-2">
        Sample every
        <select className={sel} value={v.intervalMs} onChange={(e) => void save({ intervalMs: Number(e.target.value) })}>
          <option value={1000}>1 second</option>
          <option value={2000}>2 seconds</option>
          <option value={5000}>5 seconds</option>
          <option value={10000}>10 seconds</option>
        </select>
        {capturing && <span className="text-xs text-muted">(next capture)</span>}
      </label>
      <label className="flex items-center gap-2">
        Stop on its own after
        <select className={sel} value={v.autoStopMin} onChange={(e) => void save({ autoStopMin: Number(e.target.value) })}>
          <option value={30}>30 minutes</option>
          <option value={60}>1 hour</option>
          <option value={240}>4 hours</option>
          <option value={480}>8 hours</option>
          <option value={1440}>24 hours</option>
          <option value={0}>Never — until I press Stop</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        Keep sessions for
        <select className={sel} value={v.keepDays} onChange={(e) => void save({ keepDays: Number(e.target.value) })}>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
          <option value={0}>Forever</option>
        </select>
      </label>
      <span className="flex-1" />
      <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
        <X size={15} />
      </button>
    </div>
  )
}

function SessionsPanel({ onClose, onView, onChanged }: { onClose: () => void; onView: (s: Session) => void; onChanged: () => void }): React.JSX.Element {
  const [items, setItems] = useState<Session[] | null>(null)
  const [size, setSize] = useState(0)
  const [confirm, setConfirm] = useState<string | 'all' | null>(null)
  const load = async (): Promise<void> => {
    const r = await inv<{ items: Session[]; bytes: number }>('sessions')
    setItems(r.items)
    setSize(r.bytes)
  }
  useEffect(() => {
    void load()
  }, [])
  const del = async (ids: string[] | 'all'): Promise<void> => {
    await inv('delete-sessions', ids === 'all' ? { all: true } : { ids })
    setConfirm(null)
    void load()
    onChanged()
  }
  return (
    <div className="max-h-[45vh] overflow-y-auto border-b border-edge bg-surface px-5 py-3">
      <div className="flex items-center gap-2">
        <div className="text-sm font-semibold">Saved sessions</div>
        <div className="text-xs text-muted">{items ? `${items.length} · ${bytes(size)} on disk` : ''}</div>
        <span className="flex-1" />
        {items && items.length > 1 && (confirm === 'all' ? (
          <span className="flex items-center gap-2 text-xs">
            Delete every session?
            <button onClick={() => void del('all')} className="rounded-md bg-danger px-2 py-0.5 font-semibold text-white">Delete all</button>
            <button onClick={() => setConfirm(null)} className="text-muted hover:text-ink">Cancel</button>
          </span>
        ) : (
          <button onClick={() => setConfirm('all')} className="text-xs text-muted hover:text-danger">Delete all</button>
        ))}
        <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
          <X size={15} />
        </button>
      </div>
      {!items ? (
        <Loader2 size={14} className="mt-3 animate-spin text-muted" />
      ) : !items.length ? (
        <div className="mt-2 text-xs text-muted">No sessions yet — press Start Capture to record one.</div>
      ) : (
        <div className="mt-2 divide-y divide-edge">
          {items.map((s) => (
            <div key={s.id} className="flex items-center gap-3 py-2 text-sm">
              <div className="w-60">
                <div className="font-medium">{new Date(s.start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                <div className="text-xs text-muted">
                  {s.open ? <span className="text-danger">capturing now · </span> : null}
                  {duration(s.end - s.start)} · every {s.intervalMs / 1000}s
                </div>
              </div>
              <div className="flex flex-1 flex-wrap gap-x-4 text-xs text-muted">
                <span>peak CPU <b className="text-ink">{pct(s.peakCpu)}</b></span>
                <span>peak memory <b className="text-ink">{pct(s.peakMem)}</b></span>
                {s.peakGpu !== null && <span>peak GPU <b className="text-ink">{pct(s.peakGpu)}</b></span>}
                <span>{s.samples.toLocaleString()} samples</span>
              </div>
              <button onClick={() => onView(s)} className="rounded-lg border border-edge px-2.5 py-1 text-xs font-medium hover:border-accent">
                View
              </button>
              {!s.open &&
                (confirm === s.id ? (
                  <span className="flex items-center gap-1 text-xs">
                    <button onClick={() => void del([s.id])} className="rounded-md bg-danger px-2 py-0.5 font-semibold text-white">Delete</button>
                    <button onClick={() => setConfirm(null)} className="text-muted">Cancel</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirm(s.id)} className="rounded-md p-1 text-muted hover:text-danger" title="Delete this session">
                    <Trash2 size={14} />
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

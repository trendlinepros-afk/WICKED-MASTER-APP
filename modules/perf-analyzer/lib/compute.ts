/**
 * Pure maths for the Performance Analyzer — no Electron, no fs, so it's unit-testable.
 *
 *  raw snapshot (what the PowerShell sampler prints each tick)
 *    → diffSamples(prev, cur) → Sample   (one line in <session>.jsonl)
 *    → Rollup.add(sample)     → Unit     (one line per minute in <session>.min.jsonl)
 *  Samples and minute units are both read back as `Unit`s, and bucketize()
 *  turns any span of them into the chart's buckets + per-app series.
 */

export type Metric = 'cpu' | 'mem' | 'gpu' | 'disk'
export const METRICS: Metric[] = ['cpu', 'mem', 'gpu', 'disk']

/* ------------------------------ raw snapshot ------------------------------ */

export interface RawProc {
  pid: number
  /** PerfProc instance name, e.g. "chrome#3" */
  name: string
  /** cumulative 100 ns CPU time, all cores */
  cpu: number
  /** private working set, bytes */
  ws: number
  /** cumulative I/O bytes (disk + network + device) */
  io: number
}

export interface RawSnapshot {
  /** Timestamp_Sys100NS of the process query */
  ts: number
  procs: RawProc[]
  /** `_Total` / `Idle` instances (cumulative 100 ns) */
  total: number | null
  idle: number | null
  /** GPU engine rows with utilisation > 0: [percent, instance name] */
  gpu: [number, string][] | null
  gpuMem: number | null
  disk: { idle: number; read: number; write: number } | null
  tempC: number | null
  meta: AppMeta[]
}

export interface AppMeta {
  key: string
  name: string
  company: string
  /** 'valid' | 'unsigned' | 'unknown' | other Authenticode status */
  signed: string
  path: string
}

/** Parse one S…E block of the sampler's tab-separated line protocol. */
export function parseBlock(lines: string[]): RawSnapshot {
  const snap: RawSnapshot = { ts: 0, procs: [], total: null, idle: null, gpu: null, gpuMem: null, disk: null, tempC: null, meta: [] }
  for (const line of lines) {
    const f = line.replace(/\r$/, '').split('\t')
    switch (f[0]) {
      case 'S':
        snap.ts = Number(f[1]) || 0
        break
      case 'P': {
        const name = f.slice(5).join('\t')
        const p = { pid: Number(f[1]) || 0, cpu: Number(f[2]) || 0, ws: Number(f[3]) || 0, io: Number(f[4]) || 0, name }
        if (name === '_Total') snap.total = p.cpu
        else if (name === 'Idle') snap.idle = p.cpu
        else if (name) snap.procs.push(p)
        break
      }
      case 'GOK':
        snap.gpu ??= []
        break
      case 'G':
        snap.gpu ??= []
        snap.gpu.push([Number(f[1]) || 0, f[2] ?? ''])
        break
      case 'GM':
        snap.gpuMem = Number(f[1]) || 0
        break
      case 'D':
        snap.disk = { idle: Number(f[1]) || 0, read: Number(f[2]) || 0, write: Number(f[3]) || 0 }
        break
      case 'T': {
        const t = Number(f[1])
        snap.tempC = Number.isFinite(t) && t > -50 && t < 150 ? t : null
        break
      }
      case 'M':
        if (f[1]) snap.meta.push({ key: appKey(f[1]), name: (f[2] || '').trim(), company: (f[3] || '').trim(), signed: (f[4] || 'unknown').trim(), path: (f[5] || '').trim() })
        break
    }
  }
  return snap
}

/** "chrome#12" → "chrome" (lower-case; one app = every instance of the exe) */
export const appKey = (instance: string): string => instance.replace(/#\d+$/, '').trim().toLowerCase()

/* --------------------------------- sample --------------------------------- */

/** one app in a sample: [key, cpu %, memory bytes, gpu %, disk/io bytes/s, instances] */
export type AppRow = [string, number, number, number, number, number]

export interface Sample {
  t: number
  /** cpu % (whole machine) */
  c: number
  /** memory in use, % of RAM */
  m: number
  /** memory in use, bytes */
  mu: number
  g: number | null
  gm: number | null
  /** disk active time % */
  d: number | null
  dr: number
  dw: number
  tc: number | null
  /** process count */
  p: number
  /** top apps */
  a: AppRow[]
  /** everything not in `a`: [cpu, mem, gpu, io, app count] */
  o: [number, number, number, number, number]
  /** apps seen for the first time this capture */
  ev?: string[]
}

export interface DiffEnv {
  t: number
  cores: number
  totalMem: number
  freeMem: number
  /** app keys already seen this capture (mutated: new ones are added) */
  known: Set<string> | null
  /** how many apps to keep per sample, by each metric */
  topN?: { cpu: number; mem: number; gpu: number; io: number }
}

const round = (v: number, d = 1): number => {
  const k = 10 ** d
  return Math.round(v * k) / k
}

const GPU_RE = /pid_(\d+)_luid_(\w+?)_(\w+?)_phys_(\d+)_eng_(\d+)_engtype_(.*)$/i

/** GPU %: busiest engine overall, and per pid the busiest engine it uses (Task Manager's method). */
export function gpuUsage(rows: [number, string][]): { total: number; byPid: Map<number, Map<string, number>> } {
  const perEngine = new Map<string, number>()
  const byPid = new Map<number, Map<string, number>>()
  for (const [util, name] of rows) {
    const m = GPU_RE.exec(name)
    if (!m || !(util > 0)) continue
    const pid = Number(m[1])
    const eng = `${m[2]}_${m[3]}_${m[4]}_${m[5]}`
    perEngine.set(eng, (perEngine.get(eng) ?? 0) + util)
    let pm = byPid.get(pid)
    if (!pm) byPid.set(pid, (pm = new Map()))
    pm.set(eng, (pm.get(eng) ?? 0) + util)
  }
  let total = 0
  for (const v of perEngine.values()) total = Math.max(total, v)
  return { total: Math.min(100, total), byPid }
}

/**
 * Two consecutive snapshots → one sample. CPU / I/O are deltas per pid (a pid
 * new in `cur` contributes 0 this tick); memory is the current private working set.
 */
export function diffSamples(prev: RawSnapshot, cur: RawSnapshot, env: DiffEnv): Sample | null {
  const dt = cur.ts - prev.ts // 100 ns
  if (!(dt > 0)) return null
  const cores = Math.max(1, env.cores)
  const cap = dt * cores
  const prevBy = new Map(prev.procs.map((p) => [p.pid, p]))
  const gpu = cur.gpu ? gpuUsage(cur.gpu) : null

  interface Acc {
    c: number
    m: number
    io: number
    n: number
    eng: Map<string, number>
  }
  const apps = new Map<string, Acc>()
  let sumCpu = 0
  for (const p of cur.procs) {
    const key = appKey(p.name)
    let a = apps.get(key)
    if (!a) apps.set(key, (a = { c: 0, m: 0, io: 0, n: 0, eng: new Map() }))
    a.n++
    a.m += p.ws
    const old = prevBy.get(p.pid)
    if (old && appKey(old.name) === key) {
      const dc = Math.max(0, p.cpu - old.cpu)
      a.c += dc
      sumCpu += dc
      a.io += Math.max(0, p.io - old.io)
    }
    const ge = gpu?.byPid.get(p.pid)
    if (ge) for (const [eng, v] of ge) a.eng.set(eng, (a.eng.get(eng) ?? 0) + v)
  }

  let cpu: number
  if (cur.total !== null && prev.total !== null && cur.idle !== null && prev.idle !== null) {
    cpu = ((cur.total - prev.total - (cur.idle - prev.idle)) / cap) * 100
  } else cpu = (sumCpu / cap) * 100
  cpu = Math.max(0, Math.min(100, cpu))

  const secs = dt / 1e7
  const rows: AppRow[] = []
  for (const [key, a] of apps) {
    let g = 0
    for (const v of a.eng.values()) g = Math.max(g, v)
    rows.push([key, round(Math.min(100, (a.c / cap) * 100), 2), Math.round(a.m), round(Math.min(100, g), 1), Math.round(a.io / secs), a.n])
  }

  const n = env.topN ?? { cpu: 12, mem: 8, gpu: 5, io: 5 }
  const keep = new Set<string>()
  const take = (idx: 1 | 2 | 3 | 4, k: number): void => {
    for (const r of [...rows].sort((x, y) => y[idx] - x[idx]).slice(0, k)) if (r[idx] > 0) keep.add(r[0])
  }
  take(1, n.cpu)
  take(2, n.mem)
  take(3, n.gpu)
  take(4, n.io)
  const top = rows.filter((r) => keep.has(r[0])).sort((x, y) => y[1] - x[1] || y[2] - x[2])
  const o: Sample['o'] = [0, 0, 0, 0, 0]
  for (const r of rows)
    if (!keep.has(r[0])) {
      o[0] += r[1]
      o[1] += r[2]
      o[2] = Math.max(o[2], r[3])
      o[3] += r[4]
      o[4]++
    }
  o[0] = round(o[0], 2)

  let ev: string[] | undefined
  if (env.known) {
    for (const key of apps.keys())
      if (!env.known.has(key)) {
        env.known.add(key)
        ;(ev ??= []).push(key)
      }
  }

  const used = Math.max(0, env.totalMem - env.freeMem)
  const s: Sample = {
    t: env.t,
    c: round(cpu),
    m: env.totalMem > 0 ? round((used / env.totalMem) * 100) : 0,
    mu: used,
    g: gpu ? round(gpu.total) : null,
    gm: cur.gpuMem,
    d: cur.disk ? round(Math.max(0, Math.min(100, 100 - cur.disk.idle))) : null,
    dr: cur.disk ? Math.round(cur.disk.read) : 0,
    dw: cur.disk ? Math.round(cur.disk.write) : 0,
    tc: cur.tempC,
    p: cur.procs.length,
    a: top,
    o
  }
  if (ev?.length) s.ev = ev
  return s
}

/* ------------------------------ units / rollup ----------------------------- */

/** [avg, max] */
export type AM = [number, number]

/**
 * A sample or a pre-aggregated minute, in one shape. App rows are averages
 * over `w` samples: [key, cpu, mem bytes, gpu, io B/s, max instances, cpu max].
 */
export interface Unit {
  t: number
  /** samples it stands for */
  w: number
  c: AM
  m: AM
  mu: number
  g: AM | null
  d: AM | null
  dr: number
  dw: number
  tc: number | null
  p: number
  a: [string, number, number, number, number, number, number][]
  o: [number, number, number, number, number]
  ev?: string[]
}

export function sampleToUnit(s: Sample): Unit {
  return {
    t: s.t,
    w: 1,
    c: [s.c, s.c],
    m: [s.m, s.m],
    mu: s.mu,
    g: s.g === null ? null : [s.g, s.g],
    d: s.d === null ? null : [s.d, s.d],
    dr: s.dr,
    dw: s.dw,
    tc: s.tc,
    p: s.p,
    a: s.a.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[1]]),
    o: s.o,
    ...(s.ev ? { ev: s.ev } : {})
  }
}

/** Merge units (weighted). Apps absent from a unit count as 0 there. */
export function mergeUnits(units: Unit[], t: number, appLimit = 20): Unit | null {
  if (!units.length) return null
  let w = 0
  const sum = { c: 0, m: 0, mu: 0, g: 0, gw: 0, d: 0, dw_: 0, dr: 0, dwr: 0, p: 0, o: [0, 0, 0, 0, 0] }
  const max = { c: 0, m: 0, g: 0, d: 0 }
  let tc: number | null = null
  const apps = new Map<string, [number, number, number, number, number, number]>() // sums: c, m, g, io, nMax, cMax
  const ev: string[] = []
  for (const u of units) {
    w += u.w
    sum.c += u.c[0] * u.w
    sum.m += u.m[0] * u.w
    sum.mu += u.mu * u.w
    max.c = Math.max(max.c, u.c[1])
    max.m = Math.max(max.m, u.m[1])
    if (u.g) {
      sum.g += u.g[0] * u.w
      sum.gw += u.w
      max.g = Math.max(max.g, u.g[1])
    }
    if (u.d) {
      sum.d += u.d[0] * u.w
      sum.dw_ += u.w
      max.d = Math.max(max.d, u.d[1])
    }
    sum.dr += u.dr * u.w
    sum.dwr += u.dw * u.w
    sum.p += u.p * u.w
    for (let i = 0; i < 4; i++) sum.o[i] += u.o[i] * u.w
    sum.o[4] = Math.max(sum.o[4], u.o[4])
    if (u.tc !== null) tc = tc === null ? u.tc : Math.max(tc, u.tc)
    for (const r of u.a) {
      let a = apps.get(r[0])
      if (!a) apps.set(r[0], (a = [0, 0, 0, 0, 0, 0]))
      a[0] += r[1] * u.w
      a[1] += r[2] * u.w
      a[2] += r[3] * u.w
      a[3] += r[4] * u.w
      a[4] = Math.max(a[4], r[5])
      a[5] = Math.max(a[5], r[6])
    }
    if (u.ev) ev.push(...u.ev)
  }
  const rows = [...apps].map(([k, a]) => [k, round(a[0] / w, 2), Math.round(a[1] / w), round(a[2] / w, 1), Math.round(a[3] / w), a[4], round(a[5], 2)] as Unit['a'][number])
  // keep the apps that matter for any metric
  const keep = new Set<string>()
  for (const idx of [1, 2, 3, 4] as const) for (const r of [...rows].sort((x, y) => y[idx] - x[idx]).slice(0, appLimit)) if (r[idx] > 0) keep.add(r[0])
  const o: Unit['o'] = [round(sum.o[0] / w, 2), Math.round(sum.o[1] / w), round(sum.o[2] / w, 1), Math.round(sum.o[3] / w), sum.o[4]]
  for (const r of rows)
    if (!keep.has(r[0])) {
      o[0] = round(o[0] + r[1], 2)
      o[1] += r[2]
      o[3] += r[4]
      o[4]++
    }
  const out: Unit = {
    t,
    w,
    c: [round(sum.c / w), max.c],
    m: [round(sum.m / w), max.m],
    mu: Math.round(sum.mu / w),
    g: sum.gw ? [round(sum.g / sum.gw), max.g] : null,
    d: sum.dw_ ? [round(sum.d / sum.dw_), max.d] : null,
    dr: Math.round(sum.dr / w),
    dw: Math.round(sum.dwr / w),
    tc,
    p: Math.round(sum.p / w),
    a: rows.filter((r) => keep.has(r[0])).sort((x, y) => y[1] - x[1]),
    o
  }
  if (ev.length) out.ev = [...new Set(ev)]
  return out
}

/** Collects samples and emits one Unit per wall-clock minute. */
export class Rollup {
  private minute = -1
  private units: Unit[] = []

  /** returns the finished minute when `s` starts a new one */
  add(s: Sample): Unit | null {
    const m = Math.floor(s.t / 60_000)
    let done: Unit | null = null
    if (m !== this.minute && this.units.length) done = this.flush()
    this.minute = m
    this.units.push(sampleToUnit(s))
    return done
  }

  /** the minute so far, without ending it (live views) */
  peek(): Unit | null {
    return mergeUnits(this.units, this.minute * 60_000)
  }

  flush(): Unit | null {
    const u = mergeUnits(this.units, this.minute * 60_000)
    this.units = []
    return u
  }
}

/* --------------------------------- query ---------------------------------- */

export interface Bucket {
  t: number
  t1: number
  /** samples in it (0 = not capturing) */
  w: number
  c: AM | null
  m: AM | null
  g: AM | null
  d: AM | null
  dr: number
  dw: number
  mu: number
  tc: number | null
  p: number | null
  /** top apps by each metric: [key, value] (cpu %, mem %, gpu %, io B/s) */
  top: Record<Metric, [string, number][]>
  /** apps beyond `top` that had any use of that metric */
  more: Record<Metric, number>
  ev: string[]
}

export interface AppSummary {
  key: string
  /** max instances seen */
  n: number
  avg: Record<Metric, number>
  max: Record<Metric, number>
  /** per bucket (null = no data) — mem as % of RAM */
  series: Record<Metric, (number | null)[]>
}

export interface SpikeEvent {
  metric: Metric
  t: number
  /** bucket index */
  i: number
  value: number
  app: string | null
  appValue: number
  /** how long it stayed above the line, ms */
  ms: number
}

export interface QueryResult {
  from: number
  to: number
  bucketMs: number
  resolution: 'raw' | 'minute'
  buckets: Bucket[]
  apps: AppSummary[]
  spikes: SpikeEvent[]
  totals: { avg: Record<Metric, number | null>; max: Record<Metric, number | null>; tempMax: number | null; samples: number }
}

export const SPIKE_AT: Record<Metric, number> = { cpu: 85, mem: 90, gpu: 85, disk: 90 }

const metricOf = (u: Unit, m: Metric): AM | null => (m === 'cpu' ? u.c : m === 'mem' ? u.m : m === 'gpu' ? u.g : u.d)

/**
 * Spread units over `n` equal buckets from..to. `totalMem` turns app memory
 * bytes into % of RAM.
 */
export function bucketize(units: Unit[], from: number, to: number, n: number, totalMem: number, opts: { appLimit?: number; topPerBucket?: number; resolution?: 'raw' | 'minute' } = {}): QueryResult {
  n = Math.max(1, Math.floor(n))
  const span = Math.max(1, to - from)
  const bucketMs = span / n
  const groups: Unit[][] = Array.from({ length: n }, () => [])
  for (const u of units) {
    if (u.t < from || u.t >= to) continue
    groups[Math.min(n - 1, Math.floor((u.t - from) / bucketMs))].push(u)
  }
  const memPct = (b: number): number => (totalMem > 0 ? (b / totalMem) * 100 : 0)
  const topK = opts.topPerBucket ?? 4

  const appAcc = new Map<string, { n: number; sum: Record<Metric, number>; max: Record<Metric, number>; series: Record<Metric, (number | null)[]> }>()
  const merged = groups.map((g, i) => mergeUnits(g, from + i * bucketMs, 40))
  let samples = 0
  merged.forEach((u, i) => {
    if (!u) return
    samples += u.w
    for (const r of u.a) {
      let a = appAcc.get(r[0])
      if (!a) {
        const blank = (): (number | null)[] => merged.map((x) => (x ? 0 : null))
        a = { n: 0, sum: { cpu: 0, mem: 0, gpu: 0, disk: 0 }, max: { cpu: 0, mem: 0, gpu: 0, disk: 0 }, series: { cpu: blank(), mem: blank(), gpu: blank(), disk: blank() } }
        appAcc.set(r[0], a)
      }
      const vals: Record<Metric, number> = { cpu: r[1], mem: memPct(r[2]), gpu: r[3], disk: r[4] }
      a.n = Math.max(a.n, r[5])
      for (const m of METRICS) {
        a.sum[m] += vals[m] * u.w
        a.series[m][i] = m === 'mem' ? round(vals[m], 2) : vals[m]
      }
      a.max.cpu = Math.max(a.max.cpu, r[6])
      a.max.mem = Math.max(a.max.mem, vals.mem)
      a.max.gpu = Math.max(a.max.gpu, r[3])
      a.max.disk = Math.max(a.max.disk, r[4])
    }
  })

  const buckets: Bucket[] = merged.map((u, i) => {
    const t = from + i * bucketMs
    if (!u) return { t, t1: t + bucketMs, w: 0, c: null, m: null, g: null, d: null, dr: 0, dw: 0, mu: 0, tc: null, p: null, top: { cpu: [], mem: [], gpu: [], disk: [] }, more: { cpu: 0, mem: 0, gpu: 0, disk: 0 }, ev: [] }
    const top = {} as Bucket['top']
    const more = {} as Bucket['more']
    const idx: Record<Metric, 1 | 2 | 3 | 4> = { cpu: 1, mem: 2, gpu: 3, disk: 4 }
    for (const m of METRICS) {
      const used = u.a.filter((r) => r[idx[m]] > 0).sort((x, y) => y[idx[m]] - x[idx[m]])
      top[m] = used.slice(0, topK).map((r) => [r[0], m === 'mem' ? round(memPct(r[2]), 1) : r[idx[m]]])
      more[m] = Math.max(0, used.length - topK) + (m === 'gpu' ? 0 : u.o[4])
    }
    return { t, t1: t + bucketMs, w: u.w, c: u.c, m: u.m, g: u.g, d: u.d, dr: u.dr, dw: u.dw, mu: u.mu, tc: u.tc, p: u.p, top, more, ev: u.ev ?? [] }
  })

  const apps: AppSummary[] = [...appAcc].map(([key, a]) => ({
    key,
    n: a.n,
    avg: { cpu: round(a.sum.cpu / Math.max(1, samples), 2), mem: round(a.sum.mem / Math.max(1, samples), 2), gpu: round(a.sum.gpu / Math.max(1, samples), 2), disk: Math.round(a.sum.disk / Math.max(1, samples)) },
    max: { cpu: round(a.max.cpu, 2), mem: round(a.max.mem, 2), gpu: round(a.max.gpu, 1), disk: Math.round(a.max.disk) },
    series: a.series
  }))
  // the most useful apps for every metric, so any sort shows real data
  const limit = opts.appLimit ?? 30
  const keep = new Set<string>()
  for (const m of METRICS) for (const a of [...apps].sort((x, y) => y.avg[m] - x.avg[m] || y.max[m] - x.max[m]).slice(0, limit)) keep.add(a.key)

  const totals: QueryResult['totals'] = { avg: { cpu: null, mem: null, gpu: null, disk: null }, max: { cpu: null, mem: null, gpu: null, disk: null }, tempMax: null, samples }
  for (const m of METRICS) {
    let s = 0
    let w = 0
    let mx: number | null = null
    for (const b of buckets) {
      const v = b[m === 'cpu' ? 'c' : m === 'mem' ? 'm' : m === 'gpu' ? 'g' : 'd']
      if (!v) continue
      s += v[0] * b.w
      w += b.w
      mx = mx === null ? v[1] : Math.max(mx, v[1])
    }
    totals.avg[m] = w ? round(s / w) : null
    totals.max[m] = mx
  }
  for (const b of buckets) if (b.tc !== null) totals.tempMax = totals.tempMax === null ? b.tc : Math.max(totals.tempMax, b.tc)

  return { from, to, bucketMs, resolution: opts.resolution ?? 'raw', buckets, apps: apps.filter((a) => keep.has(a.key)), spikes: findSpikes(buckets, merged), totals }
}

/** Runs of buckets whose peak crossed SPIKE_AT → one event at the highest point, with the app most to blame. */
export function findSpikes(buckets: Bucket[], units?: (Unit | null)[]): SpikeEvent[] {
  const out: SpikeEvent[] = []
  for (const m of METRICS) {
    let run: { start: number; best: number } | null = null
    const close = (end: number): void => {
      if (!run) return
      const b = buckets[run.best]
      const v = (m === 'cpu' ? b.c : m === 'mem' ? b.m : m === 'gpu' ? b.g : b.d)![1]
      const culprit = b.top[m][0] ?? null
      out.push({ metric: m, t: b.t, i: run.best, value: v, app: culprit?.[0] ?? null, appValue: culprit?.[1] ?? 0, ms: buckets[end - 1].t1 - buckets[run.start].t })
      run = null
    }
    buckets.forEach((b, i) => {
      const v = units?.[i] ? metricOf(units[i]!, m) : m === 'cpu' ? b.c : m === 'mem' ? b.m : m === 'gpu' ? b.g : b.d
      const hot = !!v && v[1] >= SPIKE_AT[m]
      if (hot) {
        if (!run) run = { start: i, best: i }
        else {
          const cur = (m === 'cpu' ? buckets[run.best].c : m === 'mem' ? buckets[run.best].m : m === 'gpu' ? buckets[run.best].g : buckets[run.best].d)![1]
          if (v![1] > cur) run.best = i
        }
      } else close(i)
    })
    close(buckets.length)
  }
  return out.sort((a, b) => a.t - b.t)
}

/** never more buckets than samples could fill — else every other bucket reads as "not capturing" */
export const bucketsFor = (from: number, to: number, n: number, intervalMs: number): number => Math.max(10, Math.min(Math.floor(n), Math.floor((to - from) / Math.max(1, intervalMs))))

/** Pick raw samples or minute units for a span drawn as `n` buckets. */
export const useMinutes = (from: number, to: number, n: number): boolean => (to - from) / Math.max(1, n) >= 60_000

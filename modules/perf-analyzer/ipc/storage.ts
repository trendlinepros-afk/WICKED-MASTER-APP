/**
 * Capture sessions on disk (main only):
 *
 *   <dir>/sessions.json          index: one entry per capture
 *   <dir>/apps.json              exe name → description / company / signature / path
 *   <dir>/sessions/<id>.jsonl    line 1 = header, then one Sample per tick
 *   <dir>/sessions/<id>.min.jsonl one Unit per minute (long time frames read these)
 *
 * Append-only JSONL so a crash or power cut loses at most the last tick; a
 * session left "open" is closed on the next launch (end time + minute file
 * rebuilt from the samples).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Rollup, sampleToUnit, type AppMeta, type Sample, type Unit } from '../lib/compute'

export interface SessionInfo {
  id: string
  start: number
  end: number
  intervalMs: number
  samples: number
  peakCpu: number
  peakMem: number
  peakGpu: number | null
  totalMem: number
  cores: number
  open: boolean
}

interface Header {
  v: 1
  id: string
  start: number
  intervalMs: number
  totalMem: number
  cores: number
  host: string
}

const readJson = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

const writeJson = (p: string, v: unknown): void => {
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(v), 'utf8')
  renameSync(tmp, p)
}

export class Store {
  readonly sessionsDir: string
  private indexPath: string
  private appsPath: string
  private index: SessionInfo[]
  private apps: Record<string, AppMeta>
  private cache = new Map<string, { size: number; mtime: number; units: Unit[] }>()

  constructor(readonly dir: string) {
    this.sessionsDir = join(dir, 'sessions')
    mkdirSync(this.sessionsDir, { recursive: true })
    this.indexPath = join(dir, 'sessions.json')
    this.appsPath = join(dir, 'apps.json')
    this.index = readJson<SessionInfo[]>(this.indexPath, [])
    if (!Array.isArray(this.index)) this.index = []
    this.apps = readJson<Record<string, AppMeta>>(this.appsPath, {})
    this.adoptOrphans()
  }

  /* ------------------------------- index ------------------------------- */

  sessions(): SessionInfo[] {
    return [...this.index].sort((a, b) => b.start - a.start)
  }

  get(id: string): SessionInfo | undefined {
    return this.index.find((s) => s.id === id)
  }

  private saveIndex(): void {
    try {
      writeJson(this.indexPath, this.index)
    } catch {
      /* next save retries */
    }
  }

  rawPath = (id: string): string => join(this.sessionsDir, `${id}.jsonl`)
  minPath = (id: string): string => join(this.sessionsDir, `${id}.min.jsonl`)

  /** session files on disk the index doesn't know (index lost/restored) */
  private adoptOrphans(): void {
    let names: string[] = []
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return
    }
    for (const n of names) {
      const m = /^(.+)\.jsonl$/.exec(n)
      if (!m || n.endsWith('.min.jsonl') || this.get(m[1])) continue
      const h = this.header(m[1])
      if (h) this.index.push({ id: h.id, start: h.start, end: h.start, intervalMs: h.intervalMs, samples: 0, peakCpu: 0, peakMem: 0, peakGpu: null, totalMem: h.totalMem, cores: h.cores, open: true })
    }
    // files gone → drop from the index
    this.index = this.index.filter((s) => existsSync(this.rawPath(s.id)))
  }

  private header(id: string): Header | null {
    try {
      const first = readFileSync(this.rawPath(id), 'utf8').split('\n', 1)[0]
      const h = JSON.parse(first) as Header
      return h?.v === 1 ? h : null
    } catch {
      return null
    }
  }

  /** close sessions a crash left open: end time, peaks and the minute file from the samples */
  repairOpen(exceptId?: string): number {
    let n = 0
    for (const s of this.index) {
      if (!s.open || s.id === exceptId) continue
      const samples = this.readSamples(s.id)
      const roll = new Rollup()
      const mins: Unit[] = []
      for (const x of samples) {
        const u = roll.add(x)
        if (u) mins.push(u)
      }
      const last = roll.flush()
      if (last) mins.push(last)
      try {
        writeFileSync(this.minPath(s.id), mins.map((u) => JSON.stringify(u)).join('\n') + (mins.length ? '\n' : ''), 'utf8')
      } catch {
        /* long views fall back to samples */
      }
      s.samples = samples.length
      s.end = samples.length ? samples[samples.length - 1].t : s.start
      s.peakCpu = Math.max(0, ...samples.map((x) => x.c))
      s.peakMem = Math.max(0, ...samples.map((x) => x.m))
      const g = samples.filter((x) => x.g !== null).map((x) => x.g!)
      s.peakGpu = g.length ? Math.max(...g) : null
      s.open = false
      n++
    }
    if (n) this.saveIndex()
    return n
  }

  /* ------------------------------ writing ------------------------------ */

  begin(h: Omit<Header, 'v'>): SessionInfo {
    const header: Header = { v: 1, ...h }
    writeFileSync(this.rawPath(h.id), JSON.stringify(header) + '\n', 'utf8')
    writeFileSync(this.minPath(h.id), '', 'utf8')
    const info: SessionInfo = { id: h.id, start: h.start, end: h.start, intervalMs: h.intervalMs, samples: 0, peakCpu: 0, peakMem: 0, peakGpu: null, totalMem: h.totalMem, cores: h.cores, open: true }
    this.index.push(info)
    this.saveIndex()
    return info
  }

  append(id: string, s: Sample): void {
    appendFileSync(this.rawPath(id), JSON.stringify(s) + '\n', 'utf8')
    const info = this.get(id)
    if (info) {
      info.samples++
      info.end = s.t
      info.peakCpu = Math.max(info.peakCpu, s.c)
      info.peakMem = Math.max(info.peakMem, s.m)
      if (s.g !== null) info.peakGpu = Math.max(info.peakGpu ?? 0, s.g)
    }
  }

  appendMinute(id: string, u: Unit): void {
    appendFileSync(this.minPath(id), JSON.stringify(u) + '\n', 'utf8')
  }

  /** persist the index now and then while capturing (and when it ends) */
  checkpoint(id: string, close = false): void {
    const info = this.get(id)
    if (info && close) info.open = false
    this.saveIndex()
  }

  /* ------------------------------ reading ------------------------------ */

  private readLines<T>(path: string, skipFirst: boolean, map: (raw: unknown) => T): T[] {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const out: T[] = []
    const lines = text.split('\n')
    for (let i = skipFirst ? 1 : 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l) continue
      try {
        out.push(map(JSON.parse(l)))
      } catch {
        /* a torn last line after a power cut */
      }
    }
    return out
  }

  readSamples(id: string): Sample[] {
    return this.readLines(this.rawPath(id), true, (x) => x as Sample)
  }

  /** samples (as units) or minute units of one session, cached until the file changes */
  units(id: string, minutes: boolean): Unit[] {
    const path = minutes ? this.minPath(id) : this.rawPath(id)
    let st: { size: number; mtimeMs: number }
    try {
      st = statSync(path)
    } catch {
      return []
    }
    const key = path
    const hit = this.cache.get(key)
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.units
    const units = minutes ? this.readLines(path, false, (x) => x as Unit) : this.readLines(path, true, (x) => sampleToUnit(x as Sample))
    this.cache.set(key, { size: st.size, mtime: st.mtimeMs, units })
    // keep memory modest: a handful of files
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value as string)
    return units
  }

  /** every unit from..to across sessions; `extra` = the live session's not-yet-written minute */
  range(from: number, to: number, minutes: boolean, extra?: Unit | null): { units: Unit[]; totalMem: number; sessions: SessionInfo[] } {
    const hit = this.index.filter((s) => s.start <= to && (s.open ? Date.now() : s.end) >= from - 60_000).sort((a, b) => a.start - b.start)
    const units: Unit[] = []
    let totalMem = 0
    for (const s of hit) {
      totalMem = Math.max(totalMem, s.totalMem)
      for (const u of this.units(s.id, minutes)) if (u.t >= from && u.t < to) units.push(u)
    }
    if (extra && extra.t >= from && extra.t < to) units.push(extra)
    return { units, totalMem, sessions: hit }
  }

  firstStart(): number | null {
    return this.index.length ? Math.min(...this.index.map((s) => s.start)) : null
  }

  /* -------------------------------- apps ------------------------------- */

  meta(): Record<string, AppMeta> {
    return this.apps
  }

  /** keep the best info we've seen for each exe; true when anything changed */
  mergeMeta(list: AppMeta[]): boolean {
    let changed = false
    for (const m of list) {
      const old = this.apps[m.key]
      const better = !old || (!old.path && m.path) || (!old.name && m.name) || (old.signed === 'unknown' && m.signed !== 'unknown')
      if (better) {
        this.apps[m.key] = { ...old, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '' && v !== 'unknown')), key: m.key } as AppMeta
        if (!this.apps[m.key].signed) this.apps[m.key].signed = 'unknown'
        changed = true
      }
    }
    if (changed)
      try {
        writeJson(this.appsPath, this.apps)
      } catch {
        /* retried with the next new app */
      }
    return changed
  }

  /* ------------------------------ deleting ----------------------------- */

  delete(ids: string[]): number {
    let n = 0
    for (const id of ids) {
      const s = this.get(id)
      if (!s || s.open) continue
      rmSync(this.rawPath(id), { force: true })
      rmSync(this.minPath(id), { force: true })
      this.cache.delete(this.rawPath(id))
      this.cache.delete(this.minPath(id))
      this.index = this.index.filter((x) => x.id !== id)
      n++
    }
    if (n) this.saveIndex()
    return n
  }

  /** drop finished sessions that ended more than `days` ago (0 = keep forever) */
  prune(days: number): number {
    if (!(days > 0)) return 0
    const cut = Date.now() - days * 86_400_000
    return this.delete(this.index.filter((s) => !s.open && s.end < cut).map((s) => s.id))
  }

  bytes(): number {
    let n = 0
    try {
      for (const f of readdirSync(this.sessionsDir))
        try {
          n += statSync(join(this.sessionsDir, f)).size
        } catch {
          /* vanished */
        }
    } catch {
      /* none */
    }
    return n
  }
}

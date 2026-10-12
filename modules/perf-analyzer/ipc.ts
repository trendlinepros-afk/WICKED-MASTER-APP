/**
 * Performance Analyzer — main process.
 *
 * Off until the user presses Start Capture: then one hidden PowerShell sampler
 * (ipc/sampler.ts) prints raw counters every tick, this file turns each pair of
 * snapshots into a Sample (lib/compute.ts) and appends it to the session's
 * JSONL file (ipc/storage.ts). Stop (or the auto-stop timer, or quitting the
 * app) kills the sampler. Saved sessions stay on disk, so any later visit can
 * scroll back through them.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { cpus, freemem, hostname, totalmem } from 'os'
import { basename, dirname, join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { Rollup, bucketize, bucketsFor, diffSamples, mergeUnits, useMinutes, type AppMeta, type RawSnapshot, type Sample } from './lib/compute'
import { buildReportHtml } from './lib/report'
import { Sampler } from './ipc/sampler'
import { Store, type SessionInfo } from './ipc/storage'

const ID = 'perf-analyzer'
const INTERVALS = [1000, 2000, 5000, 10000]

export interface PerfSettings {
  intervalMs: number
  /** stop on its own after this many minutes (0 = never) */
  autoStopMin: number
  /** delete sessions older than this many days (0 = keep forever) */
  keepDays: number
}
const DEFAULTS: PerfSettings = { intervalMs: 2000, autoStopMin: 240, keepDays: 30 }

export interface LivePoint {
  t: number
  c: number
  m: number
  mu: number
  g: number | null
  d: number | null
  p: number
  tc: number | null
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sessionId = (t: number): string => {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export default function register(ctx: ModuleIpcContext): void {
  const dir = join(ctx.app.getPath('userData'), 'modules', ID)
  const store = new Store(dir)
  store.repairOpen()

  const settings = (): PerfSettings => {
    const s = ctx.storeGet<Partial<PerfSettings>>(`${ID}.settings`, {})
    return {
      intervalMs: INTERVALS.includes(Number(s.intervalMs)) ? Number(s.intervalMs) : DEFAULTS.intervalMs,
      autoStopMin: Number.isFinite(Number(s.autoStopMin)) && Number(s.autoStopMin) >= 0 ? Number(s.autoStopMin) : DEFAULTS.autoStopMin,
      keepDays: Number.isFinite(Number(s.keepDays)) && Number(s.keepDays) >= 0 ? Number(s.keepDays) : DEFAULTS.keepDays
    }
  }
  store.prune(settings().keepDays)

  const send = (channel: string, payload: unknown): void => {
    ctx.getMainWindow()?.webContents.send(channel, payload)
  }

  /* -------------------------------- capture -------------------------------- */

  interface Capture {
    info: SessionInfo
    intervalMs: number
    prev: RawSnapshot | null
    known: Set<string>
    rollup: Rollup
    last: LivePoint | null
    lastCheckpoint: number
    autoStop: ReturnType<typeof setTimeout> | null
    error: string
  }
  let cap: Capture | null = null
  let lastError = ''

  const sampler = new Sampler({
    onSnapshot: (snap) => {
      if (!cap) return
      if (snap.meta.length && store.mergeMeta(snap.meta)) send(`${ID}:meta`, null)
      const c = cap
      if (!c.prev) {
        c.prev = snap
        for (const p of snap.procs) c.known.add(p.name.replace(/#\d+$/, '').toLowerCase())
        return
      }
      const s = diffSamples(c.prev, snap, { t: Date.now(), cores: cpus().length, totalMem: totalmem(), freeMem: freemem(), known: c.known })
      c.prev = snap
      if (!s) return
      record(c, s)
    },
    onExit: (error) => {
      lastError = error
      finishCapture(error)
    }
  })

  function record(c: Capture, s: Sample): void {
    try {
      store.append(c.info.id, s)
      const minute = c.rollup.add(s)
      if (minute) store.appendMinute(c.info.id, minute)
    } catch (err) {
      lastError = `Couldn’t save the capture: ${errMsg(err)}`
      return finishCapture(lastError)
    }
    c.last = { t: s.t, c: s.c, m: s.m, mu: s.mu, g: s.g, d: s.d, p: s.p, tc: s.tc }
    if (s.t - c.lastCheckpoint > 60_000) {
      c.lastCheckpoint = s.t
      store.checkpoint(c.info.id)
    }
    send(`${ID}:sample`, { ...c.last, top: s.a.slice(0, 3).map((r) => [r[0], r[1]]), ev: s.ev ?? [] })
  }

  function startCapture(raw?: { intervalMs?: unknown }): { ok: boolean; error?: string } {
    if (cap) return { ok: true }
    if (process.platform !== 'win32' && !process.env.WICKED_PERF_SAMPLER) return { ok: false, error: 'The Performance Analyzer reads Windows performance counters — it only runs on Windows.' }
    const st = settings()
    const intervalMs = INTERVALS.includes(Number(raw?.intervalMs)) ? Number(raw!.intervalMs) : st.intervalMs
    store.prune(st.keepDays)
    const start = Date.now()
    let info: SessionInfo
    try {
      // two captures in the same second must not share a file
      let id = sessionId(start)
      for (let k = 2; store.get(id) || existsSync(store.rawPath(id)); k++) id = `${sessionId(start)}-${k}`
      info = store.begin({ id, start, intervalMs, totalMem: totalmem(), cores: cpus().length, host: hostname() })
    } catch (err) {
      return { ok: false, error: `Couldn’t create the session file: ${errMsg(err)}` }
    }
    lastError = ''
    cap = { info, intervalMs, prev: null, known: new Set(), rollup: new Rollup(), last: null, lastCheckpoint: start, autoStop: null, error: '' }
    if (st.autoStopMin > 0) cap.autoStop = setTimeout(() => finishCapture(''), st.autoStopMin * 60_000)
    sampler.start(intervalMs)
    send(`${ID}:state`, statusPayload())
    return { ok: true }
  }

  function finishCapture(error: string): void {
    const c = cap
    if (!c) return
    cap = null
    sampler.stop()
    if (c.autoStop) clearTimeout(c.autoStop)
    try {
      const last = c.rollup.flush()
      if (last) store.appendMinute(c.info.id, last)
    } catch {
      /* repaired on next launch */
    }
    store.checkpoint(c.info.id, true)
    // a capture stopped before the first real sample: nothing worth keeping
    if (!store.get(c.info.id)?.samples) store.delete([c.info.id])
    send(`${ID}:state`, { ...statusPayload(), error })
  }

  ctx.app.on('before-quit', () => finishCapture(''))

  function statusPayload(): Record<string, unknown> {
    return {
      ok: true,
      capturing: !!cap,
      session: cap ? { ...cap.info } : null,
      intervalMs: cap?.intervalMs ?? settings().intervalMs,
      startedAt: cap?.info.start ?? null,
      last: cap?.last ?? null,
      settings: settings(),
      firstStart: store.firstStart(),
      sessionCount: store.sessions().length,
      bytes: store.bytes(),
      error: lastError,
      supported: process.platform === 'win32' || !!process.env.WICKED_PERF_SAMPLER,
      totalMem: totalmem(),
      cores: cpus().length
    }
  }

  ctx.ipcMain.handle(`${ID}:status`, () => statusPayload())
  ctx.ipcMain.handle(`${ID}:start`, (_e, raw: unknown) => startCapture((raw ?? {}) as { intervalMs?: unknown }))
  ctx.ipcMain.handle(`${ID}:stop`, () => {
    finishCapture('')
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:settings-set`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as Partial<PerfSettings>
    const cur = settings()
    const next: PerfSettings = {
      intervalMs: INTERVALS.includes(Number(r.intervalMs)) ? Number(r.intervalMs) : cur.intervalMs,
      autoStopMin: r.autoStopMin !== undefined && Number(r.autoStopMin) >= 0 ? Math.round(Number(r.autoStopMin)) : cur.autoStopMin,
      keepDays: r.keepDays !== undefined && Number(r.keepDays) >= 0 ? Math.round(Number(r.keepDays)) : cur.keepDays
    }
    ctx.storeSet(`${ID}.settings`, next)
    store.prune(next.keepDays)
    return { ok: true, settings: next }
  })

  /* --------------------------------- reading -------------------------------- */

  const metaFor = (keys: Iterable<string>): Record<string, AppMeta> => {
    const all = store.meta()
    const out: Record<string, AppMeta> = {}
    for (const k of keys) if (all[k]) out[k] = all[k]
    return out
  }

  /** the chart: buckets + per-app series + spikes for a time window */
  ctx.ipcMain.handle(`${ID}:query`, (_e, raw: unknown) => runQuery((raw ?? {}) as QueryArgs))

  type QueryArgs = { from?: unknown; to?: unknown; buckets?: unknown; lite?: unknown }
  function runQuery(r: QueryArgs) {
    const to = Number(r.to) || Date.now()
    const from = Math.min(to - 1000, Number(r.from) || to - 3600_000)
    const want = Math.max(10, Math.min(1500, Number(r.buckets) || 400))
    const minutes = useMinutes(from, to, want)
    const near = store.sessions().filter((s) => s.start <= to && (s.open ? Date.now() : s.end) >= from)
    const interval = minutes ? 60_000 : Math.min(...near.map((s) => s.intervalMs), 10_000)
    // a clock-aligned grid (bucket = whole seconds / minutes, starting on a multiple
    // of itself): the same sample always lands in the same bucket, so markers and
    // lines don't hop about as the live window slides
    const unit = minutes ? 60_000 : 1000
    const bucketMs = Math.ceil((to - from) / bucketsFor(from, to, want, interval * 1.5) / unit) * unit
    const gFrom = Math.floor(from / bucketMs) * bucketMs
    const gTo = Math.ceil(to / bucketMs) * bucketMs
    const { units, totalMem, sessions } = store.range(gFrom, gTo, minutes, minutes && cap ? cap.rollup.peek() : null)
    const res = bucketize(units, gFrom, gTo, Math.round((gTo - gFrom) / bucketMs), totalMem || totalmem(), { resolution: minutes ? 'minute' : 'raw', appLimit: r.lite ? 0 : 30 })
    const view = { viewFrom: from, viewTo: to }
    if (r.lite) return { ok: true, ...res, ...view, apps: [], meta: {}, sessions: sessions.map(span) }
    const keys = new Set(res.apps.map((a) => a.key))
    for (const b of res.buckets) for (const m of ['cpu', 'mem', 'gpu', 'disk'] as const) for (const [k] of b.top[m]) keys.add(k)
    for (const b of res.buckets) for (const k of b.ev) keys.add(k)
    return { ok: true, ...res, ...view, meta: metaFor(keys), sessions: sessions.map(span), totalMem: totalMem || totalmem() }
  }

  const span = (s: SessionInfo): { id: string; start: number; end: number; open: boolean } => ({ id: s.id, start: s.start, end: cap?.info.id === s.id ? Date.now() : s.end, open: s.open })

  /** everything recorded in one slice of the graph (the click-through list) */
  ctx.ipcMain.handle(`${ID}:moment`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { from?: unknown; to?: unknown }
    const from = Number(r.from)
    const to = Number(r.to)
    if (!(to > from)) return { ok: false, error: 'Bad time range.' }
    const minutes = to - from >= 120_000
    const { units, totalMem } = store.range(from, to, minutes, minutes && cap ? cap.rollup.peek() : null)
    const u = mergeUnits(units, from, 500)
    if (!u) return { ok: true, empty: true }
    return { ok: true, unit: u, totalMem: totalMem || totalmem(), meta: metaFor(u.a.map((x) => x[0])) }
  })

  /* ------------------------------ export summary ----------------------------- */

  /**
   * "Export Summary": a written PDF report of one session (default: the latest
   * one, a running capture included — it covers everything up to now). Built as
   * HTML (lib/report.ts) and printed by the shell's printHtmlToPdf, like Trade
   * Analytics' summary. mode 'dialog' asks where to save; 'auto' (MCP) saves to
   * Documents/WICKED Performance.
   */
  ctx.ipcMain.handle(`${ID}:export-summary`, async (_e, raw: unknown) => {
    const r = (raw ?? {}) as { id?: unknown; mode?: unknown }
    const all = store.sessions()
    const s = r.id ? store.get(String(r.id)) : all[0]
    if (!s) return { ok: false, error: all.length ? 'That session no longer exists.' : 'Nothing has been captured yet — press Start Capture first.' }
    const end = cap?.info.id === s.id ? Date.now() : Math.max(s.end, s.start + 1000)
    const q = runQuery({ from: s.start, to: end + 1, buckets: 360 }) as ReturnType<typeof runQuery> & { meta: Record<string, AppMeta> }
    const html = buildReportHtml({
      host: hostname(),
      cores: s.cores || cpus().length,
      totalMem: s.totalMem || totalmem(),
      session: { start: s.start, end, intervalMs: s.intervalMs, samples: s.samples, open: cap?.info.id === s.id },
      q: q as never,
      generatedAt: Date.now()
    })
    const d = new Date(s.start)
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const fileName = `Performance Summary ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}.pdf`
    const folder = join(ctx.app.getPath('documents'), 'WICKED Performance')
    let file = join(folder, fileName)
    try {
      if (r.mode === 'auto') mkdirSync(folder, { recursive: true })
      else {
        mkdirSync(folder, { recursive: true })
        const win = ctx.getMainWindow()
        const opts = { title: 'Export performance summary', defaultPath: file, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
        const picked = win ? await ctx.dialog.showSaveDialog(win, opts) : await ctx.dialog.showSaveDialog(opts)
        if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
        file = picked.filePath
        mkdirSync(dirname(file), { recursive: true })
      }
      writeFileSync(file, await ctx.printHtmlToPdf(html))
      if (r.mode !== 'auto') ctx.shell.showItemInFolder(file)
      return { ok: true, file, name: basename(file) }
    } catch (err) {
      return { ok: false, error: `Couldn’t make the PDF: ${errMsg(err)}` }
    }
  })

  ctx.ipcMain.handle(`${ID}:open-file`, async (_e, raw: unknown) => {
    const f = String((raw as { file?: unknown })?.file ?? '')
    if (!/\.pdf$/i.test(f) || !existsSync(f)) return { ok: false, error: 'That PDF is no longer there.' }
    const err = await ctx.shell.openPath(f)
    return err ? { ok: false, error: err } : { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:sessions`, () => ({ ok: true, items: store.sessions().map((s) => (cap?.info.id === s.id ? { ...s, end: Date.now() } : s)), bytes: store.bytes() }))

  ctx.ipcMain.handle(`${ID}:delete-sessions`, (_e, raw: unknown) => {
    const r = (raw ?? {}) as { ids?: unknown; all?: unknown }
    const ids = r.all === true ? store.sessions().map((s) => s.id) : Array.isArray(r.ids) ? r.ids.map(String) : []
    const deleted = store.delete(ids.filter((id) => id !== cap?.info.id))
    return { ok: true, deleted, total: store.sessions().length }
  })

  /* --------------------------------- extras --------------------------------- */

  const icons = new Map<string, string>()
  ctx.ipcMain.handle(`${ID}:icon`, async (_e, path: unknown) => {
    const p = String(path ?? '')
    if (!p || !/\.exe$/i.test(p)) return null
    if (icons.has(p)) return icons.get(p)
    try {
      const img = await ctx.app.getFileIcon(p, { size: 'small' })
      const url = img.isEmpty() ? '' : img.toDataURL()
      icons.set(p, url)
      return url || null
    } catch {
      icons.set(p, '')
      return null
    }
  })

  ctx.ipcMain.handle(`${ID}:reveal`, (_e, path: unknown) => {
    const p = String(path ?? '')
    if (!p) return { ok: false }
    ctx.shell.showItemInFolder(p)
    return { ok: true }
  })

  ctx.ipcMain.handle(
    `${ID}:data-paths`,
    (): ModuleDataPath[] => [
      { label: 'Capture sessions', path: store.sessionsDir, note: 'One .jsonl file per capture (+ a per-minute summary). Kept for the days set in the app.' },
      { label: 'App details', path: join(dir, 'apps.json'), note: 'Names, publishers and signature status of programs seen while capturing' }
    ]
  )
}

import type { AppMeta, Metric } from '../lib/compute'

export const ID = 'perf-analyzer'
export const inv = <T,>(action: string, arg?: unknown): Promise<T> => window.wicked.invoke(`${ID}:${action}`, arg) as Promise<T>

export type Tab = 'all' | Metric | 'procs'

export const TAB_LABEL: Record<Tab, string> = { all: 'All', cpu: 'CPU', mem: 'Memory', gpu: 'GPU', disk: 'Disk', procs: 'Processes' }
export const LIST_LABEL: Record<Metric, string> = { cpu: 'CPU usage', mem: 'Memory usage', gpu: 'GPU usage', disk: 'Disk & I/O activity' }

/** overlay colours for apps shown on the graph — fixed order, never cycled */
export const OVERLAY = ['#eb6834', '#1baf7a', '#eda100']

export const RANGES: { label: string; ms: number }[] = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '1 Hour', ms: 3600_000 },
  { label: '6 Hours', ms: 6 * 3600_000 },
  { label: '1 Day', ms: 86_400_000 },
  { label: '1 Week', ms: 7 * 86_400_000 },
  { label: '30 Days', ms: 30 * 86_400_000 }
]

/** the time-frame button: a preset's name, else a rounded length ("2.5 Hours", "40 min") */
export function spanLabel(ms: number): string {
  const preset = RANGES.find((r) => Math.abs(r.ms - ms) < 1000)
  if (preset) return preset.label
  const r1 = (v: number): string => (v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (ms < 3600_000) return `${Math.max(1, Math.round(ms / 60_000))} min`
  if (ms < 2 * 86_400_000) return `${r1(ms / 3600_000)} Hours`
  return `${r1(ms / 86_400_000)} Days`
}

export const pct = (v: number | null | undefined, d = 0): string => (v === null || v === undefined ? '—' : `${v > 0 && v < 1 ? v.toFixed(1) : v.toFixed(d)}%`)

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

export const rate = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${bytes(n)}/s`)

/** an app's value in a metric, as shown in lists / tooltips */
export function fmtApp(m: Metric, v: number, totalMem: number): string {
  if (m === 'mem') return bytes((v / 100) * totalMem)
  if (m === 'disk') return rate(v)
  return pct(v)
}

const SYSTEM_NAMES: Record<string, string> = {
  system: 'System',
  registry: 'Registry',
  'memory compression': 'Memory Compression',
  'secure system': 'Secure System',
  smss: 'Windows Session Manager',
  csrss: 'Client Server Runtime',
  wininit: 'Windows Start-Up',
  services: 'Services and Controller app',
  lsass: 'Local Security Authority',
  svchost: 'Service Host',
  dwm: 'Desktop Window Manager',
  'wmiprvse': 'WMI Provider Host',
  powershell: 'Windows PowerShell'
}

export function appName(key: string, meta?: AppMeta): string {
  if (meta?.name) return meta.name
  return SYSTEM_NAMES[key] ?? `${key}.exe`
}

export function clock(t: number, withSecs = false): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(withSecs ? { second: '2-digit' } : {}) })
}

export function dayClock(t: number, withSecs = false): string {
  const d = new Date(t)
  const today = new Date()
  const same = d.toDateString() === today.toDateString()
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return same ? clock(t, withSecs) : `${clock(t, withSecs)}, ${date}`
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

/** nice tick step for a span drawn `width` px wide */
export function tickStep(span: number, width: number): number {
  const steps = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3600_000, 2 * 3600_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000]
  const max = Math.max(2, Math.floor(width / 110))
  return steps.find((s) => span / s <= max) ?? steps[steps.length - 1]
}

export function tickLabel(t: number, step: number): string {
  const d = new Date(t)
  if (step >= 86_400_000) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  if (d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  return clock(t)
}

/** local-time-aligned ticks (whole hours/days line up with the clock) */
export function ticks(from: number, to: number, step: number): number[] {
  const off = new Date(from).getTimezoneOffset() * 60_000
  let t = Math.ceil((from - off) / step) * step + off
  const out: number[] = []
  for (; t <= to && out.length < 60; t += step) out.push(t)
  return out
}

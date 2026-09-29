/**
 * Charts in coach replies (pure — used by the chat bubble, the PDFs and tests).
 *
 * The model writes a fenced block:
 *
 *   ```chart
 *   {"type":"bar","title":"Net P&L by hour (ET)","source":"pnl_by_hour"}
 *   ```
 *
 * `source` charts are filled from the journal itself (exact numbers — the
 * model only picks what to show); custom charts carry the model's own
 * `labels`/`values`/`series` computed from the trade list. When a reply
 * finishes, source charts are FROZEN (their data embedded as `data`) so a
 * saved chat or PDF shows what the trader saw even after the account or date
 * range changes. The frozen data is stripped again before the conversation is
 * sent back to the model.
 *
 * Rendering is plain SVG strings with colours from a palette: CSS-variable
 * theme colours on screen, fixed print colours in PDFs.
 */
import type { Stats, Trade } from './analytics'
import type { TradeMetrics } from './metrics'
import { etParts } from './et'

export type ChartType = 'bar' | 'hbar' | 'line' | 'area' | 'donut' | 'pie' | 'stats'
export type Unit = '$' | '%' | 'count' | 'pts' | 'x' | ''

export interface ChartSeries {
  name: string
  values: number[]
}

export interface StatItem {
  label: string
  value: string
  tone: 'good' | 'bad' | 'neutral'
  sub?: string
}

export interface ChartData {
  type: ChartType
  title: string
  subtitle: string
  labels: string[]
  series: ChartSeries[]
  unit: Unit
  items: StatItem[]
  /** colour single-series bars/points by sign (P&L) */
  signed: boolean
  source: string
}

export interface ChartInputs {
  stats: Stats
  trades: Trade[]
  metrics: TradeMetrics | null
}

/* --------------------------------- sources -------------------------------- */

export const CHART_SOURCES: Record<string, { type: ChartType; title: string; about: string }> = {
  summary: { type: 'stats', title: 'Key numbers', about: 'stat tiles: net P&L, win rate, profit factor, expectancy, avg win/loss, fees, trades' },
  equity: { type: 'area', title: 'Equity curve (cumulative net P&L)', about: 'cumulative net P&L trade by trade' },
  daily_pnl: { type: 'bar', title: 'Net P&L by day', about: 'net P&L per trading day ("last": N days, default 30)' },
  trade_pnl: { type: 'bar', title: 'Net P&L per trade', about: 'each closed trade in order ("last": N trades, default 40)' },
  pnl_by_hour: { type: 'bar', title: 'Net P&L by hour (ET)', about: 'by hour of close' },
  pnl_by_15m: { type: 'bar', title: 'Net P&L by 15-minute slot (ET)', about: 'by 15-minute slot of close' },
  pnl_by_weekday: { type: 'bar', title: 'Net P&L by weekday', about: 'by weekday of close' },
  pnl_by_symbol: { type: 'hbar', title: 'Net P&L by symbol', about: 'per symbol ("top": N, default 12)' },
  pnl_by_hold_time: { type: 'bar', title: 'Net P&L by hold time', about: 'by how long trades were held' },
  win_loss: { type: 'donut', title: 'Wins vs losses', about: 'count of winning / losing / breakeven trades' },
  long_short: { type: 'bar', title: 'Longs vs shorts', about: 'net P&L of long vs short trades' },
  fees: { type: 'bar', title: 'Gross P&L, fees and net', about: 'what fees take out of the gross result' },
  drawdown: { type: 'area', title: 'Drawdown from the equity peak', about: 'daily distance below the running high-water mark' }
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayLabel = (ymd: string): string => {
  const [, m, d] = ymd.split('-').map(Number)
  return m && d ? `${MONTHS[m - 1]} ${d}` : ymd
}
const hourLabel = (h: number): string => `${h}:00`
const slotLabel = (slot: number): string => `${Math.floor(slot / 4)}:${String((slot % 4) * 15).padStart(2, '0')}`

const money2 = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedMoney = (n: number): string => (Math.abs(n) < 0.005 ? '$0.00' : `${n > 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const toneOf = (n: number): StatItem['tone'] => (n > 1e-9 ? 'good' : n < -1e-9 ? 'bad' : 'neutral')

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs
  const out: T[] = []
  const step = (xs.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)])
  return out
}

function fromSource(source: string, spec: Record<string, unknown>, inp: ChartInputs): Omit<ChartData, 'type' | 'title' | 'subtitle' | 'source'> | { error: string } {
  const s = inp.stats
  const m = inp.metrics
  const n = (k: string, dflt: number, max: number): number => {
    const v = Number(spec[k])
    return Number.isFinite(v) && v > 0 ? Math.min(max, Math.round(v)) : dflt
  }
  const one = (labels: string[], values: number[], unit: Unit = '$', signed = true) => ({ labels, series: [{ name: 'Net P&L', values }], unit, items: [], signed })
  switch (source) {
    case 'summary': {
      const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'
      return {
        labels: [],
        series: [],
        unit: '',
        signed: false,
        items: [
          { label: 'Net P&L', value: signedMoney(s.totalRealized), tone: toneOf(s.totalRealized), sub: `${s.closedTrades} closed trades` },
          { label: 'Win rate', value: `${s.winRate.toFixed(1)}%`, tone: s.winRate >= 50 ? 'good' : 'bad', sub: `${s.wins}W / ${s.losses}L${s.breakeven ? ` / ${s.breakeven}BE` : ''}` },
          { label: 'Profit factor', value: pf, tone: s.profitFactor >= 1 ? 'good' : 'bad', sub: 'gross win ÷ gross loss' },
          { label: 'Expectancy', value: `${signedMoney(s.expectancy)}`, tone: toneOf(s.expectancy), sub: 'per trade' },
          { label: 'Avg win', value: money2(s.avgWin), tone: 'good', sub: `largest ${money2(s.largestWin)}` },
          { label: 'Avg loss', value: money2(s.avgLoss), tone: 'bad', sub: `largest ${money2(s.largestLoss)}` },
          { label: 'Fees paid', value: money2(s.totalFees), tone: 'neutral', sub: `gross ${signedMoney(s.totalRealized + s.totalFees)}` },
          { label: 'Long / short', value: `${signedMoney(s.longPnl)} / ${signedMoney(s.shortPnl)}`, tone: 'neutral', sub: `${s.longTrades} long · ${s.shortTrades} short` }
        ]
      }
    }
    case 'equity': {
      const pts = downsample(s.equityCurve, 240)
      if (!pts.length) return { error: 'No closed trades in view' }
      return { ...one(pts.map((p) => dayLabel(etParts(p.at).ymd)), pts.map((p) => round2(p.cumulative))), signed: true }
    }
    case 'daily_pnl': {
      const days = s.byDay.slice(-n('last', 30, 250))
      if (!days.length) return { error: 'No closed trades in view' }
      return one(days.map((d) => dayLabel(d.label)), days.map((d) => round2(d.pnl)))
    }
    case 'trade_pnl': {
      const closed = inp.trades.filter((t) => !t.isOpen && t.closedQty > 0).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      const all = closed.length
      const shown = closed.slice(-n('last', 40, 300))
      if (!shown.length) return { error: 'No closed trades in view' }
      return one(
        shown.map((t, i) => `#${all - shown.length + i + 1} ${t.symbol}`),
        shown.map((t) => round2(t.realizedPnl))
      )
    }
    case 'pnl_by_hour': {
      if (!s.byHour.length) return { error: 'No closed trades in view' }
      return one(s.byHour.map((b) => b.label), s.byHour.map((b) => round2(b.pnl)))
    }
    case 'pnl_by_15m': {
      if (!m) return { error: 'Not available' }
      const tot = Array.from({ length: 96 }, (_, k) => m.weekdayQuarterPnl.reduce((a, row) => a + (row[k] ?? 0), 0))
      const cnt = Array.from({ length: 96 }, (_, k) => m.weekdayQuarterN.reduce((a, row) => a + (row[k] ?? 0), 0))
      const used = cnt.map((c, k) => (c > 0 ? k : -1)).filter((k) => k >= 0)
      if (!used.length) return { error: 'No closed trades in view' }
      const slots: number[] = []
      for (let k = used[0]; k <= used[used.length - 1]; k++) slots.push(k)
      return one(slots.map(slotLabel), slots.map((k) => round2(tot[k])))
    }
    case 'pnl_by_weekday': {
      if (!s.byDayOfWeek.length) return { error: 'No closed trades in view' }
      return one(s.byDayOfWeek.map((b) => b.label), s.byDayOfWeek.map((b) => round2(b.pnl)))
    }
    case 'pnl_by_symbol': {
      const syms = s.bySymbol.filter((b) => b.trades > 0)
      if (!syms.length) return { error: 'No closed trades in view' }
      const top = n('top', 12, 40)
      const pick = syms.length > top ? [...syms].sort((a, b) => Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl)).slice(0, top).sort((a, b) => b.realizedPnl - a.realizedPnl) : syms
      return one(pick.map((b) => b.symbol), pick.map((b) => round2(b.realizedPnl)))
    }
    case 'pnl_by_hold_time': {
      const bs = (m?.byDurationRange ?? []).filter((b) => b.trades > 0)
      if (!bs.length) return { error: 'No closed trades in view' }
      return one(bs.map((b) => b.label.replace(/\s+/g, '')), bs.map((b) => round2(b.pnl)))
    }
    case 'win_loss':
      return { labels: ['Wins', 'Losses', 'Breakeven'], series: [{ name: 'Trades', values: [s.wins, s.losses, s.breakeven] }], unit: 'count', items: [], signed: false }
    case 'long_short':
      return one([`Long (${s.longTrades})`, `Short (${s.shortTrades})`], [round2(s.longPnl), round2(s.shortPnl)])
    case 'fees':
      return one(['Gross P&L', 'Fees', 'Net P&L'], [round2(s.totalRealized + s.totalFees), -round2(s.totalFees), round2(s.totalRealized)])
    case 'drawdown': {
      const dd = m?.drawdown ?? []
      if (!dd.length) return { error: 'No closed trades in view' }
      const pts = downsample(dd, 240)
      return { labels: pts.map((p) => dayLabel(p.date)), series: [{ name: 'Drawdown', values: pts.map((p) => round2(p.value)) }], unit: '$', items: [], signed: true }
    }
    default:
      return { error: `Unknown data source "${source}"` }
  }
}

const round2 = (v: number): number => Math.round(v * 100) / 100
const TYPES: ChartType[] = ['bar', 'hbar', 'line', 'area', 'donut', 'pie', 'stats']
const UNITS: Unit[] = ['$', '%', 'count', 'pts', 'x', '']

/** Parse a chart block's JSON (tolerates a trailing comma or single quotes). */
export function parseChartSpec(raw: string): { spec: Record<string, unknown> } | { error: string } {
  const text = raw.trim()
  if (!text) return { error: 'Empty chart' }
  const attempt = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const fixed = text.replace(/,\s*([}\]])/g, '$1')
  const v = attempt(text) ?? attempt(fixed) ?? attempt(fixed.replace(/'/g, '"'))
  return v ? { spec: v } : { error: 'The chart data isn’t valid JSON' }
}

const str = (v: unknown, max = 160): string => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '')
const nums = (v: unknown): number[] =>
  Array.isArray(v)
    ? v.slice(0, 400).map((x) => {
        const n = typeof x === 'number' ? x : Number(String(x).replace(/[$,%\s]/g, ''))
        return Number.isFinite(n) ? n : 0
      })
    : []

/** Turn a parsed spec into drawable data (sources resolved against the journal in view). */
export function resolveChart(spec: Record<string, unknown>, inputs: ChartInputs | null): ChartData | { error: string } {
  const source = str(spec.source, 40).toLowerCase().trim()
  const known = source ? CHART_SOURCES[source] : undefined
  const reqType = str(spec.type, 12).toLowerCase() as ChartType
  let type: ChartType = TYPES.includes(reqType) ? reqType : (known?.type ?? 'bar')
  const title = str(spec.title) || known?.title || ''
  const subtitle = str(spec.subtitle ?? spec.caption, 240)

  // frozen / custom data
  const frozen = spec.data && typeof spec.data === 'object' ? (spec.data as Record<string, unknown>) : null
  const body = frozen ?? spec
  let labels = Array.isArray(body.labels) ? (body.labels as unknown[]).slice(0, 400).map((l) => str(l, 40)) : []
  let series: ChartSeries[] = []
  if (Array.isArray(body.series)) {
    series = (body.series as unknown[])
      .slice(0, 6)
      .map((x, i) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        return { name: str(o.name, 40) || `Series ${i + 1}`, values: nums(o.values ?? o.data) }
      })
      .filter((x) => x.values.length)
  } else if (Array.isArray(body.values)) series = [{ name: str(body.name, 40) || 'Value', values: nums(body.values) }]
  let items: StatItem[] = Array.isArray(body.items)
    ? (body.items as unknown[]).slice(0, 12).map((x) => {
        const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
        const tone = str(o.tone, 10)
        return { label: str(o.label, 40), value: str(o.value, 40), tone: tone === 'good' || tone === 'bad' ? tone : 'neutral', sub: str(o.sub, 60) || undefined }
      })
    : []
  let unit: Unit = UNITS.includes(str(body.unit, 6) as Unit) ? (str(body.unit, 6) as Unit) : '$'
  let signed = typeof body.signed === 'boolean' ? body.signed : unit === '$' || unit === 'pts'

  const hasOwn = series.length > 0 || items.length > 0
  if (!hasOwn) {
    if (!known) return { error: source ? `Unknown data source "${source}"` : 'This chart has no data' }
    if (!inputs) return { error: 'Chart data unavailable' }
    const r = fromSource(source, spec, inputs)
    if ('error' in r) return r
    labels = r.labels
    series = r.series
    items = r.items
    unit = r.unit
    signed = r.signed
    if (source === 'summary') type = 'stats'
  }
  if (type === 'stats' && !items.length) {
    // a stats chart given as labels/values → tiles
    const vals = series[0]?.values ?? []
    items = labels.map((l, i) => ({ label: l, value: fmtValue(vals[i] ?? 0, unit), tone: signed ? toneOf(vals[i] ?? 0) : 'neutral' }))
  }
  if (type !== 'stats') {
    const len = Math.max(0, ...series.map((x) => x.values.length))
    if (!len) return { error: 'This chart has no data' }
    if (labels.length < len) labels = [...labels, ...Array.from({ length: len - labels.length }, (_, i) => String(labels.length + i + 1))]
    labels = labels.slice(0, len)
    series = series.map((x) => ({ ...x, values: Array.from({ length: len }, (_, i) => x.values[i] ?? 0) }))
  }
  return { type, title, subtitle, labels, series, unit, items, signed, source: known ? source : '' }
}

/** Resolve a raw chart block in one go. */
export function chartFromBlock(raw: string, inputs: ChartInputs | null): ChartData | { error: string } {
  const p = parseChartSpec(raw)
  return 'error' in p ? p : resolveChart(p.spec, inputs)
}

const CHART_BLOCK = /(```|~~~)[ \t]*chart[ \t]*\n?([\s\S]*?)\1/g

/** Embed source data into every source chart of a finished reply. */
export function freezeCharts(md: string, inputs: ChartInputs): string {
  return md.replace(CHART_BLOCK, (whole, fence: string, body: string) => {
    const p = parseChartSpec(body)
    if ('error' in p) return whole
    const s = p.spec
    if (!s.source || s.data) return whole
    const r = resolveChart(s, inputs)
    if ('error' in r) return whole
    const data: Record<string, unknown> = { unit: r.unit, signed: r.signed }
    if (r.type === 'stats') data.items = r.items
    else {
      data.labels = r.labels
      data.series = r.series
    }
    return `${fence}chart\n${JSON.stringify({ ...s, data })}\n${fence}`
  })
}

/** Drop frozen data before a reply goes back to the model (it only needs the spec). */
export function stripChartData(md: string): string {
  return md.replace(CHART_BLOCK, (whole, fence: string, body: string) => {
    const p = parseChartSpec(body)
    if ('error' in p) return whole
    const s = { ...p.spec }
    if (!s.data) return whole
    delete s.data
    return `${fence}chart\n${JSON.stringify(s)}\n${fence}`
  })
}

/* --------------------------------- drawing -------------------------------- */

export interface Palette {
  ink: string
  muted: string
  grid: string
  pos: string
  neg: string
  neutral: string
  series: string[]
  bg: string
}

/** Theme colours (the chart is inline in the app, so CSS variables resolve). */
export const SCREEN_PALETTE: Palette = {
  ink: 'rgb(var(--wk-ink))',
  muted: 'rgb(var(--wk-muted))',
  grid: 'rgb(var(--wk-edge))',
  pos: 'rgb(var(--wk-ok))',
  neg: 'rgb(var(--wk-danger))',
  neutral: 'rgb(var(--wk-muted))',
  series: ['rgb(var(--wk-accent))', 'rgb(var(--wk-warn))', 'rgb(var(--wk-ok))', 'rgb(var(--wk-ink))', 'rgb(var(--wk-danger))', 'rgb(var(--wk-muted))'],
  bg: 'rgb(var(--wk-surface))'
}

/** Print colours for PDFs (white paper). */
export const PRINT_PALETTE: Palette = {
  ink: '#0f172a',
  muted: '#64748b',
  grid: '#e2e8f0',
  pos: '#059669',
  neg: '#dc2626',
  neutral: '#94a3b8',
  series: ['#e11d48', '#2563eb', '#d97706', '#7c3aed', '#0d9488', '#64748b'],
  bg: '#ffffff'
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function fmtValue(v: number, unit: Unit, short = false): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (unit === '$') {
    if (short && abs >= 10_000) return `${sign}$${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`
    if (short && abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`
    return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: short ? 0 : 2, maximumFractionDigits: short ? 0 : 2 })}`
  }
  if (unit === '%') return `${sign}${abs.toFixed(abs < 10 ? 1 : 0)}%`
  if (unit === 'pts') return `${sign}${abs.toFixed(abs < 10 ? 2 : 1)} pts`
  if (unit === 'x') return `${sign}${abs.toFixed(2)}×`
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: abs < 10 && abs % 1 ? 2 : 0 })}`
}

/** "Nice" axis ticks covering [lo, hi]. */
function ticks(lo: number, hi: number, want = 4): number[] {
  if (lo === hi) {
    lo = lo === 0 ? -1 : lo * 0.9
    hi = hi === 0 ? 1 : hi * 1.1
  }
  const raw = (hi - lo) / want
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw)))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => (hi - lo) / s <= want + 0.5) ?? 10 * mag
  // first tick at or below lo, last tick at or above hi, so bars never overshoot the axis
  const out: number[] = []
  const top = Math.ceil(hi / step - 1e-9) * step
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= top + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}

const TEXT = (pal: Palette, color: string, size: number, weight = 400): string =>
  `style="fill:${color};font-size:${size}px;font-weight:${weight};font-family:inherit"`

function legend(series: ChartSeries[], pal: Palette, w: number, y: number): string {
  if (series.length < 2) return ''
  let x = 8
  return series
    .map((s, i) => {
      const item = `<rect x="${x}" y="${y - 8}" width="10" height="10" rx="2" style="fill:${pal.series[i % pal.series.length]}"/><text x="${x + 14}" y="${y + 1}" ${TEXT(pal, pal.muted, 11)}>${esc(s.name)}</text>`
      x += 24 + s.name.length * 6.5
      return x > w ? '' : item
    })
    .join('')
}

function xLabels(labels: string[], xAt: (i: number) => number, y: number, pal: Palette, maxLabels: number): string {
  const n = labels.length
  const every = Math.max(1, Math.ceil(n / Math.max(1, maxLabels)))
  const shown: number[] = []
  for (let i = 0; i < n; i += every) shown.push(i)
  // the last label only when it won't collide with the one before it
  const lastShown = shown[shown.length - 1] ?? 0
  if (n > 1 && lastShown !== n - 1 && n - 1 - lastShown >= every * 0.75) shown.push(n - 1)
  return shown
    .map((i) => `<text x="${xAt(i).toFixed(1)}" y="${y}" text-anchor="middle" ${TEXT(pal, pal.muted, 10.5)}>${esc(labels[i].length > 12 ? `${labels[i].slice(0, 11)}…` : labels[i])}</text>`)
    .join('')
}

function barSvg(d: ChartData, pal: Palette, W: number): string {
  const H = 250
  const multi = d.series.length > 1
  const pad = { l: 58, r: 12, t: multi ? 26 : 14, b: 36 }
  const all = d.series.flatMap((s) => s.values)
  const tk = ticks(Math.min(0, ...all), Math.max(0, ...all))
  const lo = tk[0]
  const hi = tk[tk.length - 1]
  const Y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
  const n = d.labels.length
  const band = (W - pad.l - pad.r) / n
  const inner = Math.max(2, band * (n > 40 ? 0.86 : 0.72))
  const bw = inner / d.series.length
  const grid = tk
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" style="stroke:${pal.grid}" stroke-width="${v === 0 ? 1.4 : 0.8}"${v === 0 ? '' : ' stroke-dasharray="3 3"'}/><text x="${pad.l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" ${TEXT(pal, pal.muted, 10.5)}>${esc(fmtValue(v, d.unit, true))}</text>`)
    .join('')
  const showVals = n <= 14 && !multi
  const bars = d.series
    .map((s, si) =>
      s.values
        .map((v, i) => {
          const x = pad.l + i * band + (band - inner) / 2 + si * bw
          const y0 = Y(0)
          const y1 = Y(v)
          const top = Math.min(y0, y1)
          const h = Math.max(v === 0 ? 0 : 1.5, Math.abs(y1 - y0))
          const color = !multi && d.signed ? (v >= 0 ? pal.pos : pal.neg) : pal.series[si % pal.series.length]
          const lbl = showVals && v !== 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(v >= 0 ? top - 4 : top + h + 11).toFixed(1)}" text-anchor="middle" ${TEXT(pal, color, 10, 600)}>${esc(fmtValue(v, d.unit, true))}</text>` : ''
          return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - (multi ? 1 : 0)).toFixed(1)}" height="${h.toFixed(1)}" rx="${bw > 8 ? 2 : 0}" style="fill:${color}" fill-opacity="0.9"><title>${esc(`${d.labels[i]}${multi ? ` · ${s.name}` : ''}: ${fmtValue(v, d.unit)}`)}</title></rect>${lbl}`
        })
        .join('')
    )
    .join('')
  const xs = xLabels(d.labels, (i) => pad.l + i * band + band / 2, H - pad.b + 16, pal, Math.floor((W - pad.l) / 58))
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">${legend(d.series, pal, W, 14)}${grid}${bars}${xs}</svg>`
}

function hbarSvg(d: ChartData, pal: Palette, W: number): string {
  const vals = d.series[0]?.values ?? []
  const n = d.labels.length
  const row = n > 16 ? 18 : 24
  const labelW = Math.min(150, 14 + Math.max(...d.labels.map((l) => l.length)) * 7)
  const pad = { l: labelW, r: 70, t: 8, b: 8 }
  const H = pad.t + pad.b + n * row
  const lo = Math.min(0, ...vals)
  const hi = Math.max(0, ...vals)
  const X = (v: number): number => pad.l + ((v - lo) / (hi - lo || 1)) * (W - pad.l - pad.r)
  const rows = vals
    .map((v, i) => {
      const y = pad.t + i * row
      const x0 = X(0)
      const x1 = X(v)
      const color = d.signed ? (v >= 0 ? pal.pos : pal.neg) : pal.series[0]
      const left = Math.min(x0, x1)
      return `<text x="${pad.l - 8}" y="${y + row / 2 + 4}" text-anchor="end" ${TEXT(pal, pal.ink, 11.5, 500)}>${esc(d.labels[i].length > 20 ? `${d.labels[i].slice(0, 19)}…` : d.labels[i])}</text><rect x="${left.toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, Math.abs(x1 - x0)).toFixed(1)}" height="${row - 6}" rx="3" style="fill:${color}" fill-opacity="0.9"><title>${esc(`${d.labels[i]}: ${fmtValue(v, d.unit)}`)}</title></rect><text x="${(v >= 0 ? Math.max(x0, x1) + 5 : Math.max(x0, x1) + 5).toFixed(1)}" y="${y + row / 2 + 4}" ${TEXT(pal, color, 11, 600)}>${esc(fmtValue(v, d.unit, true))}</text>`
    })
    .join('')
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img"><line x1="${X(0).toFixed(1)}" x2="${X(0).toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}" style="stroke:${pal.grid}"/>${rows}</svg>`
}

function lineSvg(d: ChartData, pal: Palette, W: number, area: boolean): string {
  const H = 240
  const multi = d.series.length > 1
  const pad = { l: 62, r: 14, t: multi ? 26 : 12, b: 34 }
  const all = d.series.flatMap((s) => s.values)
  const tk = ticks(Math.min(0, ...all), Math.max(0, ...all))
  const lo = tk[0]
  const hi = tk[tk.length - 1]
  const n = d.labels.length
  const X = (i: number): number => pad.l + (n <= 1 ? 0.5 : i / (n - 1)) * (W - pad.l - pad.r)
  const Y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b)
  const grid = tk
    .map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" style="stroke:${pal.grid}" stroke-width="${v === 0 ? 1.4 : 0.8}"${v === 0 ? '' : ' stroke-dasharray="3 3"'}/><text x="${pad.l - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" ${TEXT(pal, pal.muted, 10.5)}>${esc(fmtValue(v, d.unit, true))}</text>`)
    .join('')
  const paths = d.series
    .map((s, si) => {
      const last = s.values[s.values.length - 1] ?? 0
      const color = !multi && d.signed ? (last >= 0 ? pal.pos : pal.neg) : pal.series[si % pal.series.length]
      const pts = s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`)
      const line = `<polyline points="${pts.join(' ')}" fill="none" style="stroke:${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`
      const fill = area && !multi ? `<polygon points="${X(0).toFixed(1)},${Y(0).toFixed(1)} ${pts.join(' ')} ${X(n - 1).toFixed(1)},${Y(0).toFixed(1)}" style="fill:${color}" fill-opacity="0.16"/>` : ''
      const dot = n <= 60 ? s.values.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${n <= 20 ? 3 : 2}" style="fill:${color}"><title>${esc(`${d.labels[i]}: ${fmtValue(v, d.unit)}`)}</title></circle>`).join('') : ''
      const end = `<text x="${Math.min(W - pad.r, X(n - 1)).toFixed(1)}" y="${(Y(last) - 8).toFixed(1)}" text-anchor="end" ${TEXT(pal, color, 11, 700)}>${esc(fmtValue(last, d.unit, true))}</text>`
      return fill + line + dot + (multi ? '' : end)
    })
    .join('')
  const xs = xLabels(d.labels, X, H - pad.b + 16, pal, Math.floor((W - pad.l) / 70))
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">${legend(d.series, pal, W, 14)}${grid}${paths}${xs}</svg>`
}

function donutSvg(d: ChartData, pal: Palette, W: number, hole: boolean): string {
  const vals = (d.series[0]?.values ?? []).map((v) => Math.max(0, v))
  const total = vals.reduce((a, b) => a + b, 0)
  const H = 200
  const cx = 100
  const cy = H / 2
  const r = 82
  const r0 = hole ? 50 : 0
  const colorOf = (label: string, i: number): string => {
    const l = label.toLowerCase()
    if (/^(win|profit|green|gain)/.test(l)) return pal.pos
    if (/^(loss|los|red|lose)/.test(l)) return pal.neg
    if (/^(break|flat|scratch|be\b)/.test(l)) return pal.neutral
    return pal.series[i % pal.series.length]
  }
  let a0 = -Math.PI / 2
  const arcs = vals
    .map((v, i) => {
      if (!total || v <= 0) return ''
      const a1 = a0 + (v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const p = (a: number, rr: number): string => `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`
      const full = v / total > 0.9999
      const path = full
        ? `M ${cx - r},${cy} A ${r},${r} 0 1 1 ${cx + r},${cy} A ${r},${r} 0 1 1 ${cx - r},${cy}` + (r0 ? ` M ${cx - r0},${cy} A ${r0},${r0} 0 1 0 ${cx + r0},${cy} A ${r0},${r0} 0 1 0 ${cx - r0},${cy}` : '')
        : r0
          ? `M ${p(a0, r)} A ${r},${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, r0)} A ${r0},${r0} 0 ${large} 0 ${p(a0, r0)} Z`
          : `M ${cx},${cy} L ${p(a0, r)} A ${r},${r} 0 ${large} 1 ${p(a1, r)} Z`
      a0 = a1
      return `<path d="${path}" fill-rule="evenodd" style="fill:${colorOf(d.labels[i] ?? '', i)}"><title>${esc(`${d.labels[i]}: ${fmtValue(v, d.unit)} (${((v / total) * 100).toFixed(1)}%)`)}</title></path>`
    })
    .join('')
  const center = hole && total ? `<text x="${cx}" y="${cy - 2}" text-anchor="middle" ${TEXT(pal, pal.ink, 20, 700)}>${esc(`${((vals[0] / total) * 100).toFixed(0)}%`)}</text><text x="${cx}" y="${cy + 16}" text-anchor="middle" ${TEXT(pal, pal.muted, 10.5)}>${esc(d.labels[0] ?? '')}</text>` : ''
  const legendRows = d.labels
    .map((l, i) => {
      const y = 36 + i * 26
      if (y > H - 10) return ''
      const v = vals[i] ?? 0
      const right = Math.min(W - 12, 560)
      return `<rect x="232" y="${y - 10}" width="12" height="12" rx="3" style="fill:${colorOf(l, i)}"/><text x="252" y="${y}" ${TEXT(pal, pal.ink, 12.5, 500)}>${esc(l)}</text><text x="${right}" y="${y}" text-anchor="end" ${TEXT(pal, pal.muted, 12)}>${esc(`${fmtValue(v, d.unit)} · ${total ? ((v / total) * 100).toFixed(0) : 0}%`)}</text>`
    })
    .join('')
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">${total ? arcs : `<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:none;stroke:${pal.grid}" stroke-width="14"/>`}${center}${legendRows}</svg>`
}

/** SVG markup for a resolved chart ('' for stat tiles — renderers draw those). */
export function chartSvg(d: ChartData, pal: Palette, width = 680): string {
  switch (d.type) {
    case 'hbar':
      return hbarSvg(d, pal, width)
    case 'line':
      return lineSvg(d, pal, width, false)
    case 'area':
      return lineSvg(d, pal, width, true)
    case 'donut':
      return donutSvg(d, pal, width, true)
    case 'pie':
      return donutSvg(d, pal, width, false)
    case 'stats':
      return ''
    default:
      return barSvg(d, pal, width)
  }
}

/** The chart instructions appended to the coach's system prompt. */
export function chartInstructions(): string {
  const sources = Object.entries(CHART_SOURCES)
    .map(([k, v]) => `${k} (${v.about})`)
    .join('; ')
  return [
    'CHARTS & FORMATTING: your replies are rendered with charts, tables and colour. Draw a chart with a fenced block whose body is one JSON object:',
    '```chart',
    '{"type":"bar","title":"Net P&L by hour (ET)","source":"pnl_by_hour"}',
    '```',
    `"source" fills EXACT numbers from the journal in view — prefer it whenever one fits: ${sources}.`,
    'For anything else, supply numbers you computed from the trade list: {"type":"bar","title":"…","labels":["A","B"],"values":[12.5,-40]} or several series {"series":[{"name":"Longs","values":[…]},{"name":"Shorts","values":[…]}]}; add "unit":"%"|"count"|"pts" when not dollars. Stat tiles: {"type":"stats","source":"summary"} or {"type":"stats","items":[{"label":"Net P&L","value":"+$603.62","tone":"good"}]}.',
    'type: bar | hbar (ranked lists) | line | area (curves over time) | donut | stats. Use 1–4 charts when a picture makes the point (trends, distributions, comparisons) — never for a single number, and never invent data.',
    'Write gains as +$123.45 and losses as -$123.45 (they are coloured green/red), use markdown tables for comparisons, and start coaching bullets with a bold label like **Do:**, **Don’t:**, **Watch for:**.',
    'PDF REPORTS: when the trader asks for a PDF, report or something printable, make the first line of your reply exactly "@pdf <short title>" and then write the complete report (headings, charts, tables). The app turns that reply into a colour PDF with your charts and saves it for them — never say you can’t create PDFs.'
  ].join('\n')
}

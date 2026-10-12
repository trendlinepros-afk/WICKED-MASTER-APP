/**
 * "Export Summary" PDF (pure, unit-testable): a self-contained HTML document —
 * inline CSS + inline SVG, no external resources — that the shell's
 * printHtmlToPdf renders with real Chromium layout (the same route Trade
 * Analytics' summary report takes). Written to be read by someone who wasn't
 * watching: a plain-English account of what the capture saw, the numbers
 * behind it, every spike and who caused it, and what's worth a look.
 */
import { METRICS, SPIKE_AT, type AppMeta, type AppSummary, type Bucket, type Metric, type QueryResult } from './compute'

export interface ReportInput {
  host: string
  cores: number
  totalMem: number
  session: { start: number; end: number; intervalMs: number; samples: number; open: boolean }
  q: QueryResult & { meta: Record<string, AppMeta> }
  generatedAt: number
}

/* --------------------------------- theme ---------------------------------- */

const INK = '#0f172a'
const MUTED = '#64748b'
const FAINT = '#e2e8f0'
const CARD = '#f8fafc'
const RED = '#dc2626'
const AMBER = '#b45309'
const GREEN = '#047857'
const COLORS: Record<Metric, string> = { cpu: '#2a78d6', mem: '#eb6834', disk: '#1baf7a', gpu: '#eda100' }
const ORDER: Metric[] = ['cpu', 'mem', 'disk', 'gpu']
const LABEL: Record<Metric, string> = { cpu: 'CPU', mem: 'Memory', disk: 'Disk', gpu: 'GPU' }

/* --------------------------------- format --------------------------------- */

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${v > 0 && v < 1 ? v.toFixed(1) : Math.round(v)}%`)
function bytes(n: number | null | undefined): string {
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
const rate = (n: number): string => `${bytes(n)}/s`
const time = (t: number, secs = false): string => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) })
const date = (t: number): string => new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const when = (t: number, ref: number): string => (new Date(t).toDateString() === new Date(ref).toDateString() ? time(t) : `${time(t)}, ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  return `${s} s`
}

const SYSTEM: Record<string, string> = { system: 'System', registry: 'Registry', 'memory compression': 'Memory Compression', svchost: 'Service Host', dwm: 'Desktop Window Manager', wmiprvse: 'WMI Provider Host', msmpeng: 'Microsoft Defender Antivirus' }
const appName = (k: string, meta?: AppMeta): string => meta?.name || SYSTEM[k] || `${k}.exe`
const fmtApp = (m: Metric, v: number, totalMem: number): string => (m === 'mem' ? bytes((v / 100) * totalMem) : m === 'disk' ? rate(v) : pct(v))

const valOf = (b: Bucket, m: Metric): [number, number] | null => (m === 'cpu' ? b.c : m === 'mem' ? b.m : m === 'gpu' ? b.g : b.d)

/* -------------------------------- analysis -------------------------------- */

export interface Findings {
  /** share of sampled time each metric's average sat at/above its spike line */
  hot: Record<Metric, number>
  hotMs: Record<Metric, number>
  peakAt: Record<Metric, number | null>
  minAvg: Record<Metric, number | null>
  top: Record<Metric, AppSummary[]>
  started: { t: number; key: string }[]
  unsigned: AppSummary[]
  notes: { tone: 'bad' | 'warn' | 'ok'; text: string }[]
}

export function analyse(inp: ReportInput): Findings {
  const { q, totalMem } = inp
  const total = Math.max(1, q.totals.samples)
  const hot = { cpu: 0, mem: 0, gpu: 0, disk: 0 } as Record<Metric, number>
  const hotMs = { cpu: 0, mem: 0, gpu: 0, disk: 0 } as Record<Metric, number>
  const peakAt = { cpu: null, mem: null, gpu: null, disk: null } as Record<Metric, number | null>
  const minAvg = { cpu: null, mem: null, gpu: null, disk: null } as Record<Metric, number | null>
  for (const m of METRICS) {
    let best = -1
    for (const b of q.buckets) {
      const v = valOf(b, m)
      if (!v || !b.w) continue
      if (v[0] >= SPIKE_AT[m]) {
        hot[m] += b.w
        hotMs[m] += b.w * inp.session.intervalMs
      }
      if (v[1] > best) {
        best = v[1]
        peakAt[m] = (b.t + b.t1) / 2
      }
      minAvg[m] = minAvg[m] === null ? v[0] : Math.min(minAvg[m]!, v[0])
    }
    hot[m] = hot[m] / total
  }
  const top = {} as Record<Metric, AppSummary[]>
  for (const m of METRICS) top[m] = [...q.apps].filter((a) => a.avg[m] > 0 || a.max[m] > 0).sort((a, b) => b.avg[m] - a.avg[m] || b.max[m] - a.max[m])
  const started: { t: number; key: string }[] = []
  for (const b of q.buckets) for (const k of b.ev) started.push({ t: b.t, key: k })
  const unsigned = q.apps.filter((a) => q.meta[a.key]?.signed === 'unsigned').sort((a, b) => b.avg.cpu - a.avg.cpu)

  const notes: Findings['notes'] = []
  const name = (a: AppSummary | undefined): string => (a ? appName(a.key, q.meta[a.key]) : 'no single app')
  const cpuTop = top.cpu[0]
  if (hot.cpu >= 0.1) notes.push({ tone: 'bad', text: `The processor was at or above ${SPIKE_AT.cpu}% for ${Math.round(hot.cpu * 100)}% of the session (about ${duration(hotMs.cpu)}). ${name(cpuTop)} was the biggest user — if things felt slow, that is the first place to look.` })
  else if ((q.totals.max.cpu ?? 0) >= SPIKE_AT.cpu) {
    const big = [...q.spikes].filter((x) => x.metric === 'cpu').sort((a, b) => b.value - a.value)[0]
    const who = big?.app ? `, mostly ${appName(big.app, q.meta[big.app])}` : ''
    notes.push(
      hotMs.cpu >= 120_000
        ? { tone: 'warn', text: `The processor hit ${pct(q.totals.max.cpu)}${big ? ` at ${when(q.buckets[big.i]?.t ?? big.t, inp.session.start)}` : ''} and spent about ${duration(hotMs.cpu)} at its limit in all${who}. The rest of the session had headroom, so this was a busy stretch rather than a PC that's too slow.` }
        : { tone: 'ok', text: `The processor briefly reached ${pct(q.totals.max.cpu)}${who}, but only for moments — bursts like this are normal when programs launch or load.` }
    )
  }
  if ((q.totals.max.mem ?? 0) >= 90) notes.push({ tone: 'bad', text: `Memory nearly ran out (peak ${pct(q.totals.max.mem)} of ${bytes(totalMem)}). Windows starts swapping to disk at this point, which makes everything sluggish. ${name(top.mem[0])} held the most memory.` })
  else if ((q.totals.avg.mem ?? 0) >= 80) notes.push({ tone: 'warn', text: `Memory stayed high the whole time (average ${pct(q.totals.avg.mem)}). Closing ${name(top.mem[0])} or adding RAM would leave more headroom.` })
  if (hot.disk >= 0.05) notes.push({ tone: 'warn', text: `The disk was saturated (≥ ${SPIKE_AT.disk}% busy) for ${Math.round(hot.disk * 100)}% of the session. ${name(top.disk[0])} moved the most data.` })
  if (hot.gpu >= 0.1) notes.push({ tone: 'warn', text: `The graphics card was working near its limit for ${Math.round(hot.gpu * 100)}% of the session, mostly for ${name(top.gpu[0])}.` })
  const tmax = q.totals.tempMax
  if (tmax !== null && tmax >= 90) notes.push({ tone: 'bad', text: `The hottest reading was ${Math.round(tmax)}°C — that's hot enough for the PC to slow itself down. Check fans, vents and dust.` })
  else if (tmax !== null && tmax >= 80) notes.push({ tone: 'warn', text: `Temperatures reached ${Math.round(tmax)}°C under load — warm but usually within limits.` })
  for (const a of unsigned.filter((a) => a.max.cpu >= 5 || a.avg.mem >= 1).slice(0, 3))
    notes.push({ tone: 'warn', text: `${appName(a.key, q.meta[a.key])} is not digitally signed and used up to ${pct(a.max.cpu)} CPU${q.meta[a.key]?.path ? ` (${q.meta[a.key].path})` : ''}. Unsigned isn't automatically bad, but make sure you recognise it.` })
  if (!notes.length) notes.push({ tone: 'ok', text: 'Nothing unusual: no part of the system stayed at its limit, and nothing ran hot. The PC had headroom to spare during this session.' })
  return { hot, hotMs, peakAt, minAvg, top, started, unsigned, notes }
}

/** the opening paragraphs, in plain English */
export function narrative(inp: ReportInput, f: Findings): string[] {
  const { q, session: s, totalMem } = inp
  const out: string[] = []
  const heaviness = (v: number | null): string => (v === null ? '' : v < 25 ? 'light' : v < 50 ? 'moderate' : v < 75 ? 'heavy' : 'very heavy')
  const name = (m: Metric): string => (f.top[m][0] ? appName(f.top[m][0].key, q.meta[f.top[m][0].key]) : '')
  out.push(
    `WICKED monitored <b>${esc(inp.host)}</b> (${inp.cores} logical processors, ${bytes(totalMem)} of memory) for <b>${duration(s.end - s.start)}</b>, from ${when(s.start, s.start)} to ${when(s.end, s.start)}, taking a reading every ${s.intervalMs / 1000} seconds — ${q.totals.samples.toLocaleString('en-US')} readings in all.${s.open ? ' The capture was still running when this report was made, so it covers everything up to that moment.' : ''}`
  )
  const c = q.totals
  let cpu = `Overall the processor load was <b>${heaviness(c.avg.cpu)}</b>: it averaged <b>${pct(c.avg.cpu)}</b> and peaked at <b>${pct(c.max.cpu)}</b>${f.peakAt.cpu ? ` around ${when(f.peakAt.cpu, s.start)}` : ''}.`
  if (name('cpu')) cpu += ` The busiest program was <b>${esc(name('cpu'))}</b> (average ${pct(f.top.cpu[0].avg.cpu)}, peak ${pct(f.top.cpu[0].max.cpu)}).`
  out.push(cpu)
  const usedAvg = ((c.avg.mem ?? 0) / 100) * totalMem
  out.push(
    `Memory use averaged <b>${pct(c.avg.mem)}</b> (about ${bytes(usedAvg)}) and peaked at <b>${pct(c.max.mem)}</b>${name('mem') ? `; <b>${esc(name('mem'))}</b> held the most (${bytes((f.top.mem[0].avg.mem / 100) * totalMem)} on average)` : ''}.` +
      (c.avg.gpu === null ? ' Graphics-card counters weren’t available on this PC.' : ` The graphics card averaged <b>${pct(c.avg.gpu)}</b> with a peak of ${pct(c.max.gpu)}${name('gpu') ? `, mostly for ${esc(name('gpu'))}` : ''}.`) +
      (c.avg.disk === null ? '' : ` The disk was busy ${pct(c.avg.disk)} of the time on average (peak ${pct(c.max.disk)})${name('disk') ? `; ${esc(name('disk'))} moved the most data (${rate(f.top.disk[0].avg.disk)} on average)` : ''}.`)
  )
  const bits: string[] = []
  const spikes = q.spikes.length
  bits.push(spikes ? `There ${spikes === 1 ? 'was <b>1 spike</b>' : `were <b>${spikes} spikes</b>`} (moments a part of the system hit its limit) — each is listed below with the program most responsible.` : 'Nothing hit its limit — there were no spikes.')
  if (f.started.length) bits.push(`${f.started.length} program${f.started.length === 1 ? '' : 's'} started during the session.`)
  if (c.tempMax !== null) bits.push(`The highest temperature reading was ${Math.round(c.tempMax)}°C.`)
  out.push(bits.join(' '))
  return out
}

/* ------------------------------- SVG chart -------------------------------- */

function chartSvg(inp: ReportInput, w = 680, h = 220): string {
  const { q } = inp
  const pad = { l: 4, r: 40, t: 22, b: 22 }
  const from = inp.session.start
  const to = Math.max(inp.session.end, from + 1000)
  const X = (t: number): number => pad.l + ((t - from) / Math.max(1, to - from)) * (w - pad.l - pad.r)
  const Y = (v: number): number => pad.t + (1 - Math.max(0, Math.min(100, v)) / 100) * (h - pad.t - pad.b)
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Arial, sans-serif">`
  for (const v of [0, 25, 50, 75, 100]) {
    s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${FAINT}" stroke-width="1"${v ? ' stroke-dasharray="2 3"' : ''}/>`
    if (v % 50 === 0) s += `<text x="${w - pad.r + 6}" y="${Y(v) + 4}" font-size="10" fill="${MUTED}">${v}%</text>`
  }
  // time ticks
  const span = to - from
  const step = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3].find((x) => span / x <= 7) ?? 86400e3
  const off = new Date(from).getTimezoneOffset() * 60e3
  for (let t = Math.ceil((from - off) / step) * step + off; t <= to; t += step) {
    const x = X(t)
    if (x < 20 || x > w - pad.r - 20) continue
    s += `<text x="${x}" y="${h - 6}" text-anchor="middle" font-size="10" fill="${MUTED}">${step >= 86400e3 ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : time(t)}</text>`
  }
  for (const m of ORDER) {
    let d = ''
    let pen = false
    for (const b of q.buckets) {
      const v = valOf(b, m)
      if (!v || !b.w) {
        if (!b.w) pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${X((b.t + b.t1) / 2).toFixed(1)},${Y(v[0]).toFixed(1)}`
      pen = true
    }
    if (d) s += `<path d="${d}" fill="none" stroke="${COLORS[m]}" stroke-width="1.6" stroke-linejoin="round"/>`
  }
  q.spikes.slice(0, 20).forEach((sp, i) => {
    const b = q.buckets[sp.i]
    if (!b) return
    const x = X((b.t + b.t1) / 2)
    s += `<line x1="${x}" x2="${x}" y1="${pad.t - 4}" y2="${h - pad.b}" stroke="${RED}" stroke-opacity="0.35"/>`
    s += `<circle cx="${x}" cy="${pad.t - 9}" r="7" fill="${RED}"/><text x="${x}" y="${pad.t - 5.5}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">${i + 1}</text>`
  })
  return s + '</svg>'
}

/* --------------------------------- HTML ----------------------------------- */

function table(head: string[], rows: string[][], align: ('l' | 'r')[] = []): string {
  const th = head.map((h, i) => `<th style="text-align:${align[i] === 'r' ? 'right' : 'left'}">${h}</th>`).join('')
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${align[i] === 'r' ? 'right' : 'left'}">${c}</td>`).join('')}</tr>`).join('')
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`
}

export function buildReportHtml(inp: ReportInput): string {
  const { q, totalMem, session: s } = inp
  const f = analyse(inp)
  const paras = narrative(inp, f)
  const name = (k: string): string => esc(appName(k, q.meta[k]))
  const signedTag = (k: string): string => (q.meta[k]?.signed === 'unsigned' ? ' <span class="tag">Unsigned</span>' : '')

  const tile = (m: Metric): string => {
    const avg = q.totals.avg[m]
    const max = q.totals.max[m]
    const tone = max !== null && max >= SPIKE_AT[m] ? RED : INK
    const sub = m === 'mem' && avg !== null ? `≈ ${bytes((avg / 100) * totalMem)} of ${bytes(totalMem)}` : avg === null ? 'not available' : `${Math.round(f.hot[m] * 100)}% of time at its limit`
    return `<div class="tile"><div class="tl"><span class="dot" style="background:${COLORS[m]}"></span>${LABEL[m]}</div><div class="tv">${pct(avg)}<span class="tsub"> avg</span></div><div class="tp" style="color:${tone}">peak ${pct(max)}</div><div class="ts">${sub}</div></div>`
  }
  const procs = q.buckets.filter((b) => b.p !== null)
  const procAvg = procs.length ? Math.round(procs.reduce((a, b) => a + (b.p ?? 0), 0) / procs.length) : null
  const extraTile = `<div class="tile"><div class="tl">Temperature · processes</div><div class="tv">${q.totals.tempMax === null ? '—' : `${Math.round(q.totals.tempMax)}°C`}<span class="tsub"> max</span></div><div class="tp">${procAvg ?? '—'} processes avg</div><div class="ts">${q.totals.tempMax === null ? 'no thermal sensor exposed' : 'ACPI thermal zone'}</div></div>`

  const notes = f.notes.map((n) => `<div class="note ${n.tone}">${esc(n.text)}</div>`).join('')

  const spikeRows = q.spikes.slice(0, 20).map((sp, i) => [
    `<b>${i + 1}</b>`,
    esc(when(q.buckets[sp.i]?.t ?? sp.t, s.start)),
    LABEL[sp.metric],
    `<b style="color:${RED}">${pct(sp.value)}</b>`,
    esc(duration(sp.ms)),
    sp.app ? `${name(sp.app)}${signedTag(sp.app)} <span class="muted">(${fmtApp(sp.metric, sp.appValue, totalMem)})</span>` : '<span class="muted">no single app</span>'
  ])

  const appTable = (m: Metric, n: number, narrow = false): string => {
    const list = f.top[m].slice(0, n)
    if (!list.length) return `<p class="muted">Nothing recorded.</p>`
    if (narrow)
      return table(
        ['Program', 'Average', 'Peak'],
        list.map((a) => [`${name(a.key)}${a.n > 1 ? ` <span class="muted">×${a.n}</span>` : ''}${signedTag(a.key)}`, `<b style="white-space:nowrap">${fmtApp(m, a.avg[m], totalMem)}</b>`, `<span style="white-space:nowrap">${fmtApp(m, a.max[m], totalMem)}</span>`]),
        ['l', 'r', 'r']
      )
    return table(
      ['Program', 'Publisher', 'Instances', 'Average', 'Peak'],
      list.map((a) => [`${name(a.key)}${signedTag(a.key)}`, esc(q.meta[a.key]?.company || '—'), a.n > 1 ? `×${a.n}` : '1', `<b>${fmtApp(m, a.avg[m], totalMem)}</b>`, fmtApp(m, a.max[m], totalMem)]),
      ['l', 'l', 'r', 'r', 'r']
    )
  }

  const started = f.started.slice(0, 40).map((x) => `<span class="chip">${esc(time(x.t))} · ${name(x.key)}</span>`).join(' ')
  const legend = ORDER.map((m) => `<span class="lg"><span class="sw" style="background:${COLORS[m]}"></span>${LABEL[m]}</span>`).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>Performance Summary</title><style>
  *{box-sizing:border-box} body{font-family:'Segoe UI',Arial,sans-serif;color:${INK};font-size:12px;line-height:1.5;margin:0}
  h1{font-size:22px;margin:0} h2{font-size:14px;margin:18px 0 6px;padding-bottom:4px;border-bottom:1px solid ${FAINT}}
  .muted{color:${MUTED}} .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #7c3aed;padding-bottom:8px}
  .meta{text-align:right;color:${MUTED};font-size:11px} p{margin:6px 0}
  .tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:10px}
  .tile{background:${CARD};border:1px solid ${FAINT};border-radius:8px;padding:8px} .tl{font-size:10px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em}
  .tv{font-size:19px;font-weight:700} .tsub{font-size:10px;font-weight:400;color:${MUTED}} .tp{font-size:11px;font-weight:600} .ts{font-size:10px;color:${MUTED}}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}
  .chart{border:1px solid ${FAINT};border-radius:8px;padding:8px 6px 2px;margin-top:6px} .lg{margin-right:14px;font-size:11px;color:${MUTED}} .sw{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
  .note{border-left:4px solid;padding:6px 10px;margin:6px 0;border-radius:4px;background:${CARD}} .note.bad{border-color:${RED}} .note.warn{border-color:${AMBER}} .note.ok{border-color:${GREEN}}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px} th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:${MUTED};border-bottom:1px solid ${FAINT};padding:4px 6px}
  td{border-bottom:1px solid ${FAINT};padding:4px 6px;vertical-align:top} .tag{background:#fef3c7;color:${AMBER};border-radius:4px;padding:0 4px;font-size:9px;font-weight:700}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:14px} .chip{display:inline-block;background:${CARD};border:1px solid ${FAINT};border-radius:10px;padding:1px 7px;margin:2px 0;font-size:10px}
  section{break-inside:avoid} .foot{margin-top:16px;font-size:9.5px;color:${MUTED};border-top:1px solid ${FAINT};padding-top:6px}
  </style></head><body>
  <div class="head"><div><div class="muted" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase">WICKED · Performance Analyzer</div><h1>Performance Summary</h1><div>${esc(date(s.start))}</div></div>
  <div class="meta">${esc(inp.host)}<br>${esc(when(s.start, s.start))} – ${esc(when(s.end, s.start))} · ${esc(duration(s.end - s.start))}<br>generated ${esc(new Date(inp.generatedAt).toLocaleString('en-US'))}</div></div>

  <section><h2>What happened</h2>${paras.map((p) => `<p>${p}</p>`).join('')}</section>
  <section><div class="tiles">${ORDER.map(tile).join('')}${extraTile}</div></section>
  <section><h2>Over the session</h2><div class="chart">${chartSvg(inp)}<div style="padding:0 4px 4px">${legend}<span class="lg"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${RED};vertical-align:middle;margin-right:4px"></span>numbered spikes (table below)</span></div></div></section>
  <section><h2>Worth a look</h2>${notes}</section>

  <section><h2>Spikes${q.spikes.length > 20 ? ` (first 20 of ${q.spikes.length})` : ''}</h2>${spikeRows.length ? table(['#', 'When', 'What', 'Peak', 'Lasted', 'Mostly caused by'], spikeRows, ['l', 'l', 'l', 'r', 'r', 'l']) : '<p class="muted">No part of the system hit its limit (CPU / GPU 85 %, memory / disk 90 %).</p>'}</section>
  <section><h2>Programs using the most CPU</h2>${appTable('cpu', 10)}</section>
  <section><h2>Programs using the most memory</h2>${appTable('mem', 8)}</section>
  <div class="two"><section><h2>Graphics card (GPU)</h2>${q.totals.avg.gpu === null ? '<p class="muted">GPU counters weren’t available.</p>' : appTable('gpu', 6, true)}</section><section><h2>Disk &amp; I/O</h2>${appTable('disk', 6, true)}</section></div>
  ${f.unsigned.length ? `<section><h2>Unsigned programs seen</h2><p class="muted">Programs without a digital signature. Many legitimate tools are unsigned — this is a list to recognise, not a list of threats.</p>${table(['Program', 'Location', 'CPU avg', 'Memory avg'], f.unsigned.slice(0, 12).map((a) => [name(a.key), esc(q.meta[a.key]?.path || '—'), pct(a.avg.cpu), bytes((a.avg.mem / 100) * totalMem)]), ['l', 'l', 'r', 'r'])}</section>` : ''}
  ${f.started.length ? `<section><h2>Programs started during the session${f.started.length > 40 ? ` (first 40 of ${f.started.length})` : ''}</h2><div>${started}</div></section>` : ''}

  <div class="foot">How this was measured: Windows performance counters, read every ${s.intervalMs / 1000} s without administrator rights. CPU is the share of all ${inp.cores} logical processors; memory is RAM in use (per program: private working set); GPU is the busiest graphics engine (Task Manager's method); disk is the time the disks were busy (per program: all input/output, including network); temperature is the PC's ACPI thermal zone when it has one. A spike is a stretch where CPU or GPU reached 85 %, or memory or disk 90 %. Program figures are averages over the session.${q.resolution === 'minute' ? ' Long sessions are summarised per minute.' : ''}</div>
  </body></html>`
}

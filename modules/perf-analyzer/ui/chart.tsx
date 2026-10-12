import { useEffect, useMemo, useRef, useState } from 'react'
import { Thermometer } from 'lucide-react'
import { METRICS, SPIKE_AT, type AppMeta, type Bucket, type Metric, type QueryResult } from '../lib/compute'
import { AppIcon } from './icon'
import { OVERLAY, TAB_LABEL, appName, dayClock, fmtApp, pct, rate, tickLabel, tickStep, ticks, type Tab } from './format'

export type Q = QueryResult & {
  meta: Record<string, AppMeta>
  sessions: { id: string; start: number; end: number; open: boolean }[]
  totalMem: number
  /** the window asked for; buckets sit on a clock-aligned grid around it */
  viewFrom: number
  viewTo: number
}

/** default plot height — the user can drag the graph taller (index.tsx) */
export const DEFAULT_PLOT_H = 250
const TOP = 34 // marker lane
const PAD_R = 52
const AXIS = 22

/** "All" tab: one line per metric — categorical slots in fixed order, stepped per theme */
const SERIES_LIGHT: Record<Metric, string> = { cpu: '#2a78d6', mem: '#eb6834', disk: '#1baf7a', gpu: '#eda100' }
const SERIES_DARK: Record<Metric, string> = { cpu: '#3987e5', mem: '#d95926', disk: '#199e70', gpu: '#c98500' }
export const ALL_ORDER: Metric[] = ['cpu', 'mem', 'disk', 'gpu']

export function useSeriesColors(): Record<Metric, string> {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])
  return dark ? SERIES_DARK : SERIES_LIGHT
}

const metricVal = (b: Bucket, m: Metric): [number, number] | null => (m === 'cpu' ? b.c : m === 'mem' ? b.m : m === 'gpu' ? b.g : b.d)
const valOf = (b: Bucket, tab: Tab): [number, number] | null => {
  if (tab === 'all') return null
  if (tab === 'procs') return b.p === null ? null : [b.p, b.p]
  return metricVal(b, tab)
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(Math.max(300, Math.floor(e[0].contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

type Pt = [number, number]
const P = (p: Pt): string => `${p[0].toFixed(1)},${p[1].toFixed(1)}`

export function Chart(props: {
  q: Q | null
  tab: Tab
  overlays: string[]
  onPick: (b: Bucket) => void
  onWidth: (w: number) => void
  loading: boolean
  empty: React.ReactNode
  /** plot height in px */
  plotH?: number
}): React.JSX.Element {
  const { q, tab, overlays } = props
  const H = props.plotH ?? DEFAULT_PLOT_H
  const [wrap, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const colors = useSeriesColors()
  useEffect(() => props.onWidth(width), [width])

  const plotW = width - PAD_R
  const metric: Metric | null = tab === 'procs' || tab === 'all' ? null : tab
  const yMax = useMemo(() => {
    if (tab !== 'procs' || !q) return 100
    const m = Math.max(10, ...q.buckets.map((b) => b.p ?? 0))
    return Math.ceil((m * 1.15) / 10) * 10
  }, [q, tab])
  const vFrom = q?.viewFrom ?? 0
  const vSpan = q ? Math.max(1, q.viewTo - q.viewFrom) : 1
  // everything is placed by its time, so nothing shifts when the window slides
  const xt = (t: number): number => ((t - vFrom) / vSpan) * plotW
  const mid = (b: Bucket): number => xt((b.t + b.t1) / 2)
  const y = (v: number): number => TOP + H - (Math.max(0, Math.min(yMax, v)) / yMax) * H

  /** was a capture running during this bucket? (an empty bucket inside a session is just a late sample) */
  const covered = useMemo(() => {
    if (!q) return [] as boolean[]
    return q.buckets.map((b) => b.w > 0 || q.sessions.some((s) => s.start <= b.t1 && s.end >= b.t))
  }, [q])

  /** line segments of one value series — broken only where nothing was capturing */
  const segments = (get: (b: Bucket) => [number, number] | null): { avg: Pt[]; max: Pt[] }[] => {
    if (!q) return []
    const out: { avg: Pt[]; max: Pt[] }[] = []
    let cur: { avg: Pt[]; max: Pt[] } | null = null
    q.buckets.forEach((b, i) => {
      if (!covered[i]) {
        cur = null
        return
      }
      const v = get(b)
      if (!v) return
      if (!cur) out.push((cur = { avg: [], max: [] }))
      cur.avg.push([mid(b), y(v[0])])
      cur.max.push([mid(b), y(v[1])])
    })
    for (const s of out)
      if (s.avg.length === 1) {
        s.avg.push([s.avg[0][0] + 2, s.avg[0][1]])
        s.max.push([s.max[0][0] + 2, s.max[0][1]])
      }
    return out
  }

  const single = useMemo(() => {
    if (!q || tab === 'all') return null
    const segs = segments((b) => valOf(b, tab))
    let line = ''
    let area = ''
    let band = ''
    for (const s of segs) {
      line += 'M' + s.avg.map(P).join('L')
      area += `M${s.avg[0][0].toFixed(1)},${TOP + H}L` + s.avg.map(P).join('L') + `L${s.avg[s.avg.length - 1][0].toFixed(1)},${TOP + H}Z`
      band += 'M' + s.max.map(P).join('L') + 'L' + [...s.avg].reverse().map(P).join('L') + 'Z'
    }
    return { line, area, band }
  }, [q, tab, width, yMax, covered, H])

  const multi = useMemo(() => {
    if (!q || tab !== 'all') return []
    return ALL_ORDER.map((m) => ({ m, d: segments((b) => metricVal(b, m)).map((s) => 'M' + s.avg.map(P).join('L')).join('') })).filter((x) => x.d)
  }, [q, tab, width, covered, H])

  const gaps = useMemo(() => {
    if (!q) return [] as [number, number][]
    const out: [number, number][] = []
    let g0: number | null = null
    q.buckets.forEach((b, i) => {
      if (!covered[i] && g0 === null) g0 = b.t
      if (covered[i] && g0 !== null) {
        out.push([g0, b.t])
        g0 = null
      }
    })
    if (g0 !== null) out.push([g0, q.buckets[q.buckets.length - 1].t1])
    return out
  }, [q, covered])

  const overlayPaths = useMemo(() => {
    if (!q || !metric || metric === 'disk') return []
    return overlays
      .map((key, k) => {
        const a = q.apps.find((x) => x.key === key)
        if (!a) return null
        let d = ''
        let pen = false
        a.series[metric].forEach((v, i) => {
          if (!covered[i]) pen = false
          if (v === null) return
          d += `${pen ? 'L' : 'M'}${P([mid(q.buckets[i]), y(v)])}`
          pen = true
        })
        return { key, d, color: OVERLAY[k] }
      })
      .filter(Boolean) as { key: string; d: string; color: string }[]
  }, [q, overlays, metric, width, covered, H])

  // markers: spikes + apps started, at the time they happened
  type Marker = { x: number; kind: 'spike' | 'start'; label: string; i: number; title: string; m?: Metric }
  const markers = useMemo(() => {
    if (!q) return [] as Marker[]
    const out: Marker[] = []
    const which = tab === 'all' ? METRICS : metric ? [metric] : []
    for (const s of q.spikes.filter((s) => which.includes(s.metric)))
      out.push({
        x: mid(q.buckets[s.i]),
        kind: 'spike',
        m: s.metric,
        label: tab === 'all' ? `${TAB_LABEL[s.metric]} ${pct(s.value)}` : pct(s.value),
        i: s.i,
        title: `${TAB_LABEL[s.metric]} peak ${pct(s.value)}${s.app ? ` — mostly ${appName(s.app, q.meta[s.app])} (${fmtApp(s.metric, s.appValue, q.totalMem)})` : ''}`
      })
    let last: Marker | null = null
    q.buckets.forEach((b, i) => {
      if (!b.ev.length) return
      const px = mid(b)
      const names = b.ev.map((k) => appName(k, q.meta[k]))
      if (last && px - last.x < 30) {
        last.label = `+${Number(last.label.slice(1)) + b.ev.length}`
        last.title += `, ${names.join(', ')}`
      } else {
        last = { x: px, kind: 'start', label: `+${b.ev.length}`, i, title: `Started: ${names.join(', ')}` }
        out.push(last)
      }
    })
    const placed: Marker[] = []
    for (const m of out.sort((a, b) => (a.kind === b.kind ? a.x - b.x : a.kind === 'spike' ? -1 : 1))) {
      const w = m.label.length * 6.8 + 14
      if (m.x < -2 || m.x > plotW + 2) continue
      if (!placed.some((p) => Math.abs(p.x - m.x) < (w + p.label.length * 6.8 + 14) / 2 + 2)) placed.push(m)
    }
    return placed
  }, [q, tab, metric, width, H])

  const hasTemp = !!q?.buckets.some((b) => b.tc !== null)
  const step = q ? tickStep(vSpan, plotW) : 60_000
  const tk = q ? ticks(q.viewFrom, q.viewTo, step) : []

  const onMove = (e: React.PointerEvent): void => {
    if (!q || !q.buckets.length) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const px = e.clientX - r.left
    if (px > plotW + 4) return setHover(null)
    const t = vFrom + (px / plotW) * vSpan
    const i = Math.floor((t - q.from) / q.bucketMs)
    setHover(Math.max(0, Math.min(q.buckets.length - 1, i)))
  }

  const hb = q && hover !== null ? q.buckets[hover] : null
  const hv = hb ? valOf(hb, tab) : null
  const H_ALL = TOP + H + 8 + (hasTemp ? 20 : 0) + AXIS

  return (
    <div ref={wrap} className="relative select-none">
      <svg width={width} height={H_ALL} className="block" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={() => hb && hb.w > 0 && props.onPick(hb)} style={{ cursor: hb?.w ? 'pointer' : 'default' }}>
        <defs>
          <linearGradient id="pa-line" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={TOP} y2={TOP + H}>
            <stop offset="0" stopColor="rgb(var(--wk-danger))" />
            <stop offset={metric ? (1 - SPIKE_AT[metric] / 100).toFixed(3) : '0'} stopColor="rgb(var(--wk-danger))" />
            <stop offset={metric ? (1 - (SPIKE_AT[metric] - 15) / 100).toFixed(3) : '0'} stopColor="rgb(var(--wk-accent))" />
            <stop offset="1" stopColor="rgb(var(--wk-accent))" />
          </linearGradient>
          <linearGradient id="pa-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--wk-accent))" stopOpacity="0.28" />
            <stop offset="1" stopColor="rgb(var(--wk-accent))" stopOpacity="0.02" />
          </linearGradient>
          <pattern id="pa-gap" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="rgb(var(--wk-edge))" strokeWidth="2" />
          </pattern>
          <clipPath id="pa-plot">
            <rect x={0} y={0} width={plotW} height={H_ALL} />
          </clipPath>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={plotW} y1={TOP + H - f * H} y2={TOP + H - f * H} stroke="rgb(var(--wk-edge))" strokeWidth={1} strokeDasharray={f === 0 ? undefined : '2 4'} opacity={f === 0 ? 1 : 0.7} />
        ))}
        <text x={plotW + 8} y={TOP + 4} className="fill-muted text-[11px]">
          {tab === 'procs' ? yMax : '100%'}
        </text>
        <text x={plotW + 8} y={TOP + H / 2 + 4} className="fill-muted text-[11px]">
          {tab === 'procs' ? yMax / 2 : '50%'}
        </text>
        <text x={plotW + 8} y={TOP + H + 4} className="fill-muted text-[11px]">
          {tab === 'procs' ? 0 : '0%'}
        </text>

        <g clipPath="url(#pa-plot)">
          {metric && <line x1={0} x2={plotW} y1={y(SPIKE_AT[metric])} y2={y(SPIKE_AT[metric])} stroke="rgb(var(--wk-danger))" strokeOpacity={0.35} strokeDasharray="4 4" />}

          {gaps.map(([a, b]) => {
            const x0 = Math.max(0, xt(a))
            const w = Math.max(0, Math.min(plotW, xt(b)) - x0)
            return (
              <g key={a}>
                <rect x={x0} y={TOP} width={w} height={H} fill="url(#pa-gap)" opacity={0.35} />
                {w > 110 && q && q.totals.samples > 0 && (
                  <text x={x0 + w / 2} y={TOP + H / 2} textAnchor="middle" className="fill-muted text-[11px]">
                    Not capturing
                  </text>
                )}
              </g>
            )
          })}

          {q?.sessions.map((s) => {
            const xs = xt(s.start)
            return xs > 2 && xs < plotW - 2 ? <line key={s.id} x1={xs} x2={xs} y1={TOP} y2={TOP + H} stroke="rgb(var(--wk-muted))" strokeOpacity={0.4} strokeDasharray="1 3" /> : null
          })}

          {single && (
            <>
              <path d={single.area} fill="url(#pa-area)" />
              {tab !== 'procs' && <path d={single.band} fill="rgb(var(--wk-accent))" opacity={0.12} />}
              <path d={single.line} fill="none" stroke={tab === 'procs' ? 'rgb(var(--wk-accent))' : 'url(#pa-line)'} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          )}
          {multi.map((s) => (
            <path key={s.m} d={s.d} fill="none" stroke={colors[s.m]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {overlayPaths.map((o) => (
            <path key={o.key} d={o.d} fill="none" stroke={o.color} strokeWidth={2} strokeLinejoin="round" />
          ))}

          {markers.map((m) => {
            const w = m.label.length * 6.8 + 14
            const bx = Math.max(0, Math.min(plotW - w, m.x - w / 2))
            const fill = m.kind === 'spike' ? 'rgb(var(--wk-danger))' : 'rgb(var(--wk-ok))'
            return (
              <g key={`${m.kind}${m.m ?? ''}${m.i}`} onClick={(e) => (e.stopPropagation(), q && props.onPick(q.buckets[m.i]))} style={{ cursor: 'pointer' }}>
                <title>{m.title}</title>
                <line x1={m.x} x2={m.x} y1={TOP - 6} y2={TOP + H} stroke={fill} strokeOpacity={0.35} />
                <rect x={bx} y={4} width={w} height={20} rx={6} fill={fill} />
                <text x={bx + w / 2} y={18} textAnchor="middle" className="text-[11px] font-bold" fill="white">
                  {m.label}
                </text>
              </g>
            )
          })}

          {hasTemp && q && (
            <g>
              {q.buckets.map((b, i) => (b.tc === null ? null : <rect key={i} x={xt(b.t)} y={TOP + H + 10} width={Math.max(1, xt(b.t1) - xt(b.t)) + 0.5} height={6} fill="rgb(var(--wk-danger))" opacity={Math.max(0.08, Math.min(1, (b.tc - 30) / 60))} />))}
            </g>
          )}
        </g>
        {hasTemp && q && (
          <text x={plotW + 8} y={TOP + H + 17} className="fill-muted text-[11px]">
            {q.totals.tempMax !== null ? `${Math.round(q.totals.tempMax)}°C` : ''}
          </text>
        )}

        {tk
          .filter((t) => xt(t) > 26 && xt(t) < plotW - 26)
          .map((t) => (
            <text key={t} x={xt(t)} y={TOP + H + (hasTemp ? 20 : 0) + 24} textAnchor="middle" className="fill-muted text-[11px]">
              {tickLabel(t, step)}
            </text>
          ))}

        {hb && hover !== null && (
          <g pointerEvents="none">
            <line x1={mid(hb)} x2={mid(hb)} y1={TOP} y2={TOP + H} stroke="rgb(var(--wk-ink))" strokeOpacity={0.35} />
            {hv && <circle cx={mid(hb)} cy={y(hv[0])} r={4} fill="rgb(var(--wk-surface))" stroke="rgb(var(--wk-accent))" strokeWidth={2} />}
            {tab === 'all' &&
              ALL_ORDER.map((m) => {
                const v = metricVal(hb, m)
                return v ? <circle key={m} cx={mid(hb)} cy={y(v[0])} r={3.5} fill="rgb(var(--wk-surface))" stroke={colors[m]} strokeWidth={2} /> : null
              })}
          </g>
        )}
      </svg>

      {!q?.totals.samples && !props.loading && (
        <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center" style={{ top: TOP, height: H }}>
          {props.empty}
        </div>
      )}

      {hb && hover !== null && q && hb.w > 0 && <Tip q={q} b={hb} tab={tab} overlays={overlays} left={mid(hb)} width={plotW} colors={colors} />}
    </div>
  )
}

function Tip({ q, b, tab, overlays, left, width, colors }: { q: Q; b: Bucket; tab: Tab; overlays: string[]; left: number; width: number; colors: Record<Metric, string> }): React.JSX.Element {
  const v = valOf(b, tab)
  const metric: Metric = tab === 'procs' || tab === 'all' ? 'cpu' : tab
  const tops = b.top[metric]
  const many = b.w > 1
  const style: React.CSSProperties = left > width - 300 ? { right: width - left + PAD_R + 14 } : { left: left + 14 }
  const idx = q.buckets.indexOf(b)
  return (
    <div className="pointer-events-none absolute z-10 w-[290px] rounded-xl border border-edge bg-surface/95 p-3 text-xs shadow-2xl backdrop-blur" style={{ top: TOP + 30, ...style }}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-muted">{many ? `${dayClock(b.t)} – ${dayClock(b.t1)}` : dayClock(b.t, true)}</span>
        {b.tc !== null && (
          <span className="flex items-center gap-0.5 font-semibold">
            <Thermometer size={11} className="text-muted" />
            {Math.round(b.tc)}°C
          </span>
        )}
        {tab !== 'all' && <span className="font-bold">{tab === 'procs' ? `${b.p}` : v ? pct(v[0]) : '—'}</span>}
      </div>
      {many && tab !== 'procs' && tab !== 'all' && v && <div className="mt-0.5 text-[11px] text-muted">average · peak {pct(v[1])}</div>}
      {tab === 'disk' && <div className="mt-0.5 text-[11px] text-muted">read {rate(b.dr)} · write {rate(b.dw)}</div>}
      {tab === 'all' && (
        <div className="mt-2 space-y-1">
          {ALL_ORDER.map((m) => {
            const mv = metricVal(b, m)
            return (
              <div key={m} className="flex items-center gap-2">
                <span className="h-0.5 w-3 rounded" style={{ background: colors[m] }} />
                <span className="flex-1">{TAB_LABEL[m]}</span>
                {many && mv && <span className="text-[11px] text-muted">peak {pct(mv[1])}</span>}
                <span className="w-10 text-right font-semibold tabular-nums">{mv ? pct(mv[0]) : '—'}</span>
              </div>
            )
          })}
          <div className="pt-1 text-[11px] text-muted">Top CPU apps</div>
        </div>
      )}
      <div className="mt-2 space-y-1.5">
        {tops.length ? (
          tops.slice(0, 3).map(([k, val]) => (
            <div key={k} className="flex items-center gap-2">
              <AppIcon k={k} meta={q.meta[k]} />
              <span className="min-w-0 flex-1 truncate">{appName(k, q.meta[k])}</span>
              <span className="font-semibold tabular-nums">{fmtApp(metric, val, q.totalMem)}</span>
            </div>
          ))
        ) : (
          <div className="text-muted">No app stood out.</div>
        )}
        {tab !== 'all' &&
          overlays
            .filter((k) => !tops.slice(0, 3).some(([t]) => t === k))
            .map((k) => {
              const a = q.apps.find((x) => x.key === k)
              const val = a?.series[metric][idx]
              return (
                <div key={k} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: OVERLAY[overlays.indexOf(k)] }} />
                  <span className="min-w-0 flex-1 truncate">{appName(k, q.meta[k])}</span>
                  <span className="font-semibold tabular-nums">{val === null || val === undefined ? '—' : fmtApp(metric, val, q.totalMem)}</span>
                </div>
              )
            })}
      </div>
      {b.ev.length > 0 && <div className="mt-2 truncate text-[11px] text-ok">Started: {b.ev.map((k) => appName(k, q.meta[k])).join(', ')}</div>}
      <div className="mt-2 border-t border-edge pt-1.5 text-[11px] text-muted">{b.more[metric] + Math.max(0, tops.length - 3) > 0 ? `Click the graph to see ${b.more[metric] + Math.max(0, tops.length - 3)} others` : 'Click the graph for the full list'}</div>
    </div>
  )
}

/** The strip under the graph: all recorded history, with a draggable window. */
export function Navigator(props: { lite: Q | null; from: number; to: number; span: number; onMove: (end: number) => void }): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const { lite } = props
  const hFrom = lite?.viewFrom ?? props.from
  const hTo = lite?.viewTo ?? props.to
  const full = Math.max(1, hTo - hFrom)
  const X = (t: number): number => ((t - hFrom) / full) * width
  const drag = useRef<{ dx: number } | null>(null)
  const area = useMemo(() => {
    if (!lite) return ''
    let d = ''
    let pen = false
    lite.buckets.forEach((b) => {
      const px = Math.max(0, Math.min(width, X((b.t + b.t1) / 2)))
      if (!b.c) {
        if (pen) d += `L${px.toFixed(1)},40`
        pen = false
        return
      }
      const py = 40 - (b.c[1] / 100) * 34
      d += pen ? `L${px.toFixed(1)},${py.toFixed(1)}` : `M${px.toFixed(1)},40L${px.toFixed(1)},${py.toFixed(1)}`
      pen = true
    })
    if (pen) d += `L${width},40`
    return d
  }, [lite, width])

  const endAt = (clientX: number, rect: DOMRect, dx: number): number => hFrom + ((clientX - rect.left - dx) / width) * full + props.span
  const wx = Math.max(0, X(props.from))
  const ww = Math.max(10, X(props.to) - wx)

  return (
    <div
      ref={ref}
      className="relative h-11 flex-1 cursor-pointer overflow-hidden rounded-xl border border-edge bg-raised"
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        const px = e.clientX - rect.left
        const inside = px >= wx && px <= wx + ww
        drag.current = { dx: inside ? px - wx : ww / 2 }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        props.onMove(endAt(e.clientX, rect, drag.current.dx))
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        props.onMove(endAt(e.clientX, e.currentTarget.getBoundingClientRect(), drag.current.dx))
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <svg width={width} height={44} className="absolute inset-0">
        <path d={area} fill="rgb(var(--wk-accent))" opacity={0.25} />
      </svg>
      <div className="absolute inset-y-0.5 rounded-lg border-2 border-accent bg-accent/10" style={{ left: wx, width: ww }} />
    </div>
  )
}

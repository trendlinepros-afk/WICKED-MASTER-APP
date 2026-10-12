import { useEffect, useMemo, useRef, useState } from 'react'
import { Thermometer } from 'lucide-react'
import { SPIKE_AT, type AppMeta, type Bucket, type Metric, type QueryResult } from '../lib/compute'
import { AppIcon } from './icon'
import { OVERLAY, appName, dayClock, fmtApp, pct, rate, tickLabel, tickStep, ticks, type Tab } from './format'

export type Q = QueryResult & { meta: Record<string, AppMeta>; sessions: { id: string; start: number; end: number; open: boolean }[]; totalMem: number }

const H = 250 // plot height
const TOP = 34 // marker lane
const PAD_R = 52
const AXIS = 22

const valOf = (b: Bucket, tab: Tab): [number, number] | null => {
  if (tab === 'procs') return b.p === null ? null : [b.p, b.p]
  return tab === 'cpu' ? b.c : tab === 'mem' ? b.m : tab === 'gpu' ? b.g : b.d
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

export function Chart(props: {
  q: Q | null
  tab: Tab
  overlays: string[]
  onPick: (b: Bucket) => void
  onWidth: (w: number) => void
  loading: boolean
  empty: React.ReactNode
}): React.JSX.Element {
  const { q, tab, overlays } = props
  const [wrap, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => props.onWidth(width), [width])

  const plotW = width - PAD_R
  const n = q?.buckets.length ?? 0
  const metric: Metric | null = tab === 'procs' ? null : tab
  const yMax = useMemo(() => {
    if (tab !== 'procs' || !q) return 100
    const m = Math.max(10, ...q.buckets.map((b) => b.p ?? 0))
    return Math.ceil((m * 1.15) / 10) * 10
  }, [q, tab])
  const x = (i: number): number => (n <= 1 ? 0 : (i / (n - 1)) * plotW)
  const y = (v: number): number => TOP + H - (Math.max(0, Math.min(yMax, v)) / yMax) * H
  const xt = (t: number): number => (q ? ((t - q.from) / (q.to - q.from)) * plotW : 0)

  const paths = useMemo(() => {
    if (!q) return null
    let line = ''
    let area = ''
    let band = ''
    let seg: number[] = []
    const flush = (): void => {
      if (!seg.length) return
      const pts = seg.map((i) => [x(i), y(valOf(q.buckets[i], tab)![0])])
      const hi = seg.map((i) => [x(i), y(valOf(q.buckets[i], tab)![1])])
      if (pts.length === 1) {
        // a lone point still shows up
        pts.push([pts[0][0] + 2, pts[0][1]])
        hi.push([hi[0][0] + 2, hi[0][1]])
      }
      line += 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')
      area += `M${pts[0][0].toFixed(1)},${TOP + H}L` + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') + `L${pts[pts.length - 1][0].toFixed(1)},${TOP + H}Z`
      band += 'M' + hi.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') + 'L' + [...pts].reverse().map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L') + 'Z'
      seg = []
    }
    q.buckets.forEach((b, i) => {
      if (valOf(b, tab)) seg.push(i)
      else flush()
    })
    flush()
    // gaps = not capturing
    const gaps: [number, number][] = []
    let g0: number | null = null
    q.buckets.forEach((b, i) => {
      if (!b.w && g0 === null) g0 = i
      if (b.w && g0 !== null) {
        gaps.push([g0, i - 1])
        g0 = null
      }
    })
    if (g0 !== null) gaps.push([g0, n - 1])
    return { line, area, band, gaps }
  }, [q, tab, width, yMax])

  const overlayPaths = useMemo(() => {
    if (!q || !metric || metric === 'disk') return []
    return overlays
      .map((key, k) => {
        const a = q.apps.find((x) => x.key === key)
        if (!a) return null
        let d = ''
        let pen = false
        a.series[metric].forEach((v, i) => {
          if (v === null) {
            pen = false
            return
          }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
          pen = true
        })
        return { key, d, color: OVERLAY[k] }
      })
      .filter(Boolean) as { key: string; d: string; color: string }[]
  }, [q, overlays, metric, width])

  // markers: spikes for this metric + apps started
  const markers = useMemo(() => {
    if (!q) return [] as { x: number; kind: 'spike' | 'start'; label: string; i: number; title: string }[]
    const out: { x: number; kind: 'spike' | 'start'; label: string; i: number; title: string }[] = []
    if (metric)
      for (const s of q.spikes.filter((s) => s.metric === metric))
        out.push({ x: x(s.i), kind: 'spike', label: pct(s.value), i: s.i, title: `Peak ${pct(s.value)}${s.app ? ` — mostly ${appName(s.app, q.meta[s.app])} (${fmtApp(metric, s.appValue, q.totalMem)})` : ''}` })
    let lastStart: (typeof out)[number] | null = null
    q.buckets.forEach((b, i) => {
      if (!b.ev.length || i === 0) return
      const px = x(i)
      const names = b.ev.map((k) => appName(k, q.meta[k]))
      if (lastStart && px - lastStart.x < 30) {
        const nn = Number(lastStart.label.slice(1)) + b.ev.length
        lastStart.label = `+${nn}`
        lastStart.title += `, ${names.join(', ')}`
      } else {
        lastStart = { x: px, kind: 'start', label: `+${b.ev.length}`, i, title: `Started: ${names.join(', ')}` }
        out.push(lastStart)
      }
    })
    // spikes win a crowded spot
    const placed: typeof out = []
    for (const m of out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'spike' ? -1 : 1)))
      if (!placed.some((p) => Math.abs(p.x - m.x) < 26)) placed.push(m)
    return placed
  }, [q, metric, width])

  const hasTemp = !!q?.buckets.some((b) => b.tc !== null)
  const step = q ? tickStep(q.to - q.from, plotW) : 60_000
  const tk = q ? ticks(q.from, q.to, step) : []

  const onMove = (e: React.PointerEvent): void => {
    if (!q || !n) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const px = e.clientX - r.left
    if (px > plotW + 4) return setHover(null)
    const i = Math.round((px / plotW) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const hb = q && hover !== null ? q.buckets[hover] : null
  const hv = hb ? valOf(hb, tab) : null

  return (
    <div ref={wrap} className="relative select-none">
      <svg width={width} height={TOP + H + 8 + (hasTemp ? 20 : 0) + AXIS} className="block" onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={() => hb && hb.w > 0 && props.onPick(hb)} style={{ cursor: hb?.w ? 'pointer' : 'default' }}>
        <defs>
          {/* line turns red above the spike line */}
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
        </defs>

        {/* grid */}
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
        {metric && <line x1={0} x2={plotW} y1={y(SPIKE_AT[metric])} y2={y(SPIKE_AT[metric])} stroke="rgb(var(--wk-danger))" strokeOpacity={0.35} strokeDasharray="4 4" />}

        {/* not capturing */}
        {paths?.gaps.map(([a, b]) => {
          const x0 = n > 1 ? x(a) - plotW / (n - 1) / 2 : 0
          const x1 = n > 1 ? x(b) + plotW / (n - 1) / 2 : plotW
          const w = Math.max(0, Math.min(plotW, x1) - Math.max(0, x0))
          return (
            <g key={a}>
              <rect x={Math.max(0, x0)} y={TOP} width={w} height={H} fill="url(#pa-gap)" opacity={0.35} />
              {w > 110 && q && q.totals.samples > 0 && (
                <text x={Math.max(0, x0) + w / 2} y={TOP + H / 2} textAnchor="middle" className="fill-muted text-[11px]">
                  Not capturing
                </text>
              )}
            </g>
          )
        })}

        {/* session boundaries */}
        {q?.sessions.map((s) => {
          const xs = xt(s.start)
          return xs > 2 && xs < plotW - 2 ? <line key={s.id} x1={xs} x2={xs} y1={TOP} y2={TOP + H} stroke="rgb(var(--wk-muted))" strokeOpacity={0.4} strokeDasharray="1 3" /> : null
        })}

        {paths && (
          <>
            <path d={paths.area} fill="url(#pa-area)" />
            {tab !== 'procs' && <path d={paths.band} fill="rgb(var(--wk-accent))" opacity={0.12} />}
            <path d={paths.line} fill="none" stroke={tab === 'procs' ? 'rgb(var(--wk-accent))' : 'url(#pa-line)'} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </>
        )}
        {overlayPaths.map((o) => (
          <path key={o.key} d={o.d} fill="none" stroke={o.color} strokeWidth={2} strokeLinejoin="round" />
        ))}

        {/* markers */}
        {markers.map((m) => (
          <g key={`${m.kind}${m.i}`} onClick={(e) => (e.stopPropagation(), q && props.onPick(q.buckets[m.i]))} style={{ cursor: 'pointer' }}>
            <title>{m.title}</title>
            <line x1={m.x} x2={m.x} y1={TOP - 6} y2={TOP + H} stroke={m.kind === 'spike' ? 'rgb(var(--wk-danger))' : 'rgb(var(--wk-ok))'} strokeOpacity={0.35} />
            <rect x={m.x - (m.label.length * 3.4 + 7)} y={4} width={m.label.length * 6.8 + 14} height={20} rx={6} fill={m.kind === 'spike' ? 'rgb(var(--wk-danger))' : 'rgb(var(--wk-ok))'} />
            <text x={m.x} y={18} textAnchor="middle" className="text-[11px] font-bold" fill="white">
              {m.label}
            </text>
          </g>
        ))}

        {/* temperature strip */}
        {hasTemp && q && (
          <g>
            {q.buckets.map((b, i) =>
              b.tc === null ? null : <rect key={i} x={x(i) - plotW / Math.max(1, n - 1) / 2} y={TOP + H + 10} width={Math.max(1, plotW / Math.max(1, n - 1)) + 0.5} height={6} fill="rgb(var(--wk-danger))" opacity={Math.max(0.08, Math.min(1, (b.tc - 30) / 60))} />
            )}
            <text x={plotW + 8} y={TOP + H + 17} className="fill-muted text-[11px]">
              {q.totals.tempMax !== null ? `${Math.round(q.totals.tempMax)}°C` : ''}
            </text>
          </g>
        )}

        {/* time axis */}
        {tk.filter((t) => xt(t) > 26 && xt(t) < plotW - 26).map((t) => (
          <text key={t} x={xt(t)} y={TOP + H + (hasTemp ? 20 : 0) + 24} textAnchor="middle" className="fill-muted text-[11px]">
            {tickLabel(t, step)}
          </text>
        ))}

        {/* crosshair */}
        {hb && hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={TOP + H} stroke="rgb(var(--wk-ink))" strokeOpacity={0.35} />
            {hv && <circle cx={x(hover)} cy={y(hv[0])} r={4} fill="rgb(var(--wk-surface))" stroke="rgb(var(--wk-accent))" strokeWidth={2} />}
          </g>
        )}
      </svg>

      {!q?.totals.samples && !props.loading && <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center" style={{ top: TOP, height: H }}>{props.empty}</div>}

      {hb && hover !== null && q && hb.w > 0 && <Tip q={q} b={hb} tab={tab} overlays={overlays} left={x(hover)} width={plotW} />}
    </div>
  )
}

function Tip({ q, b, tab, overlays, left, width }: { q: Q; b: Bucket; tab: Tab; overlays: string[]; left: number; width: number }): React.JSX.Element {
  const v = valOf(b, tab)
  const metric: Metric = tab === 'procs' ? 'cpu' : tab
  const tops = b.top[metric]
  const multi = b.w > 1
  const style: React.CSSProperties = left > width - 300 ? { right: width - left + PAD_R + 14 } : { left: left + 14 }
  const idx = q.buckets.indexOf(b)
  return (
    <div className="pointer-events-none absolute z-10 w-[290px] rounded-xl border border-edge bg-surface/95 p-3 text-xs shadow-2xl backdrop-blur" style={{ top: TOP + 30, ...style }}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-muted">{multi ? `${dayClock(b.t)} – ${dayClock(b.t1)}` : dayClock(b.t, true)}</span>
        {b.tc !== null && (
          <span className="flex items-center gap-0.5 font-semibold">
            <Thermometer size={11} className="text-muted" />
            {Math.round(b.tc)}°C
          </span>
        )}
        <span className="font-bold">{tab === 'procs' ? `${b.p}` : v ? pct(v[0]) : '—'}</span>
      </div>
      {multi && tab !== 'procs' && v && <div className="mt-0.5 text-[11px] text-muted">average · peak {pct(v[1])}</div>}
      {tab === 'disk' && <div className="mt-0.5 text-[11px] text-muted">read {rate(b.dr)} · write {rate(b.dw)}</div>}
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
        {overlays
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
  const hFrom = lite?.from ?? props.from
  const hTo = lite?.to ?? props.to
  const full = Math.max(1, hTo - hFrom)
  const X = (t: number): number => ((t - hFrom) / full) * width
  const drag = useRef<{ dx: number } | null>(null)
  const area = useMemo(() => {
    if (!lite) return ''
    const n = lite.buckets.length
    let d = ''
    let pen = false
    lite.buckets.forEach((b, i) => {
      const px = (i / Math.max(1, n - 1)) * width
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

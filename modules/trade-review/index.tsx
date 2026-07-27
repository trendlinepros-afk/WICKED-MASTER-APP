import { useRef } from 'react'
import {
  AlertTriangle,
  FileDown,
  FileUp,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  ScanSearch,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import { buildReportPdf } from '../stock-planner/lib/pdf'
import { ExecChart, type ChartFill, type ChartTrip } from './components/ExecChart'
import { ID, useTradeReview } from './store'

const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

function readFiles(files: FileList | File[], asText: boolean, cb: (out: string[]) => void): void {
  const list = Array.from(files)
  if (list.length === 0) return
  Promise.all(
    list.map(
      (f) =>
        new Promise<string>((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => resolve('')
          if (asText) r.readAsText(f)
          else r.readAsDataURL(f)
        })
    )
  ).then((out) => cb(out.filter(Boolean)))
}

/** Serialize the execution-chart SVG to a 2x PNG data URL for the PDF. */
async function svgToPng(svg: SVGSVGElement): Promise<string | null> {
  try {
    const xml = new XMLSerializer().serializeToString(svg)
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg raster failed'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = 960 * 2
    canvas.height = 420 * 2
    const cx = canvas.getContext('2d')
    if (!cx) return null
    cx.fillStyle = '#0b1022'
    cx.fillRect(0, 0, canvas.width, canvas.height)
    cx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

export default function TradeReview(): React.JSX.Element {
  const s = useTradeReview()
  const csvRef = useRef<HTMLInputElement>(null)
  const shotRef = useRef<HTMLInputElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const coachEndRef = useRef<HTMLDivElement>(null)

  const symbolFills: ChartFill[] = s.executions
    .filter((e) => e.filled && e.symbol === s.symbol)
    .map((e) => ({ side: e.side, qty: e.qty, price: e.price, at: e.filledAt }))
  const symbolTrips: ChartTrip[] = s.trades
    .filter((t) => t.symbol === s.symbol && !t.isOpen)
    .map((t) => ({ openedAt: t.openedAt, closedAt: t.closedAt, avgEntry: t.avgEntry, avgExit: t.avgExit, win: t.realizedPnl >= 0 }))

  const exportPdf = async (): Promise<void> => {
    if (!s.report || s.exporting) return
    s.setExporting(true)
    try {
      const chartPng = svgRef.current ? await svgToPng(svgRef.current) : null
      const b64 = buildReportPdf(s.report, chartPng ? [chartPng] : [], 'WICKED · TRADE REVIEW')
      const res = (await window.wicked.invoke(`${ID}:save-pdf`, { ticker: s.symbol, data: b64 })) as {
        ok?: boolean
        error?: string
      }
      if (!res.ok) s.setError(res.error ?? 'PDF export failed.')
    } finally {
      s.setExporting(false)
    }
  }

  const empty = s.executions.length === 0

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <ScanSearch size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">Trade Review</h1>
          <p className="truncate text-xs text-muted">
            {s.stats && !empty
              ? `${s.executions.filter((e) => e.filled).length} fills · realized ${money(s.stats.totalRealized)} · ${s.stats.winRate.toFixed(0)}% win`
              : 'Post-trade analysis with an AI coach'}
          </p>
        </div>
        <input ref={csvRef} type="file" accept=".csv" hidden onChange={(e) => {
          if (e.target.files) readFiles(e.target.files, true, (texts) => texts.forEach((t) => s.importCsvText(t)))
          e.target.value = ''
        }} />
        <input ref={shotRef} type="file" accept="image/*" multiple hidden onChange={(e) => {
          if (e.target.files) readFiles(e.target.files, false, (urls) => void s.extractScreenshots(urls.slice(0, 4)))
          e.target.value = ''
        }} />
        <button onClick={() => csvRef.current?.click()} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90">
          <FileUp size={14} /> Import CSV
        </button>
        <button onClick={() => shotRef.current?.click()} disabled={s.extracting} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
          {s.extracting ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />} Screenshots
        </button>
        {!empty && (
          <>
            <button onClick={() => void s.analyze()} disabled={s.reviewBusy} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
              {s.reviewBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Coach review
            </button>
            <button onClick={() => void exportPdf()} disabled={!s.report || s.exporting} title={s.report ? 'Export PDF' : 'Run the coach review first'} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40">
              {s.exporting ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />} PDF
            </button>
            <button onClick={s.clearAll} title="Clear session" className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60">
              <Trash2 size={14} />
            </button>
          </>
        )}
      </header>

      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-md text-center">
              <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-raised text-accent">
                <ScanSearch size={30} />
              </span>
              <h2 className="mt-4 text-lg font-bold">Review a trading session</h2>
              <p className="mt-2 text-sm text-muted">
                Import your Webull orders CSV (or screenshots of filled orders). Your buys and sells get
                mapped onto a 1-minute chart with round-trip P&amp;L, and the AI coach judges the session
                against your trendline/swing strategy. Nothing is stored — session only.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {/* summary + symbol tabs */}
            {s.stats && (
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-lg px-3 py-1.5 text-sm font-bold ${s.stats.totalRealized >= 0 ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger'}`}>
                  {money(s.stats.totalRealized)} realized
                </span>
                <span className="rounded-lg bg-raised px-3 py-1.5 text-sm">
                  {s.stats.wins}W / {s.stats.losses}L · {s.stats.winRate.toFixed(0)}%
                </span>
                <span className="rounded-lg bg-raised px-3 py-1.5 text-sm text-muted">
                  avg hold {(s.stats.avgHoldSeconds / 60).toFixed(0)}m
                </span>
                {s.stats.openTrades > 0 && (
                  <span className="rounded-lg bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent">
                    {s.stats.openTrades} open position(s)
                  </span>
                )}
                <div className="ml-auto flex flex-wrap gap-1">
                  {s.symbols.map((sym) => (
                    <button
                      key={sym}
                      onClick={() => s.setSymbol(sym)}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${s.symbol === sym ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'}`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* execution chart */}
            {s.barsBusy ? (
              <div className="flex h-64 items-center justify-center rounded-xl border border-edge bg-surface">
                <Loader2 size={20} className="animate-spin text-accent" />
              </div>
            ) : (
              <ExecChart ref={svgRef} bars={s.bars} fills={symbolFills} trips={symbolTrips} />
            )}

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {/* review report */}
              <div className="rounded-xl border border-edge bg-surface p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Sparkles size={14} className="text-accent" /> Coach review
                </h3>
                {s.report ? (
                  <div className="mt-3 space-y-3">
                    {s.report.stats.length > 0 && (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {s.report.stats.map((st, i) => (
                          <div key={i} className="rounded-lg bg-raised/60 px-2.5 py-1.5">
                            <div className="text-[9px] font-semibold uppercase text-muted">{st.label}</div>
                            <div className="text-sm font-bold">{st.value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {s.report.sections.map((sec, i) => (
                      <div key={i}>
                        <h4 className="flex items-center gap-2 text-sm font-semibold">
                          <span className="h-3.5 w-1 rounded bg-accent" /> {sec.heading}
                        </h4>
                        {sec.body && <p className="mt-1 whitespace-pre-wrap text-sm text-ink/90">{sec.body}</p>}
                        {sec.bullets.length > 0 && (
                          <ul className="mt-1 space-y-1 text-sm text-ink/90">
                            {sec.bullets.map((b, j) => (
                              <li key={j} className="flex gap-2">
                                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> {b}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                    {s.report.disclaimer && (
                      <p className="border-t border-edge pt-2 text-[11px] text-muted">{s.report.disclaimer}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">
                    {s.reviewBusy
                      ? 'The coach is reading your fills…'
                      : 'Run “Coach review” for a strategy-graded breakdown of this session (trendline/swing adherence, entries, exits, risk).'}
                  </p>
                )}
              </div>

              {/* coach chat */}
              <div className="flex flex-col rounded-xl border border-edge bg-surface">
                <h3 className="flex items-center gap-2 border-b border-edge px-4 py-2.5 text-sm font-semibold">
                  <MessageSquare size={14} className="text-accent" /> Coach chat
                </h3>
                <div className="min-h-[220px] flex-1 space-y-2.5 overflow-y-auto p-3">
                  {s.coach.length === 0 && (
                    <p className="text-xs text-muted">
                      Ask the coach anything about this session — it sees every fill and round trip.
                    </p>
                  )}
                  {s.coach.map((m, i) => (
                    <div key={i} className={`max-w-[92%] rounded-lg px-2.5 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'ml-auto bg-accent/15' : 'bg-raised'}`}>
                      <div className="whitespace-pre-wrap">{m.text}</div>
                    </div>
                  ))}
                  {s.coachBusy && <Loader2 size={14} className="animate-spin text-accent" />}
                  <div ref={coachEndRef} />
                </div>
                <div className="border-t border-edge p-2">
                  <textarea
                    value={s.coachInput}
                    onChange={(e) => s.setCoachInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void s.sendCoach()
                      }
                    }}
                    rows={2}
                    placeholder="Why did I lose money on this one?"
                    disabled={s.coachBusy}
                    className="w-full resize-none rounded-lg border border-edge bg-raised px-2.5 py-2 text-xs outline-none focus:border-accent disabled:opacity-50"
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {(s.reviewBusy || s.extracting || s.coachBusy || s.barsBusy) && (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        )}
        <span className="truncate">{s.statusMsg}</span>
      </footer>
    </div>
  )
}

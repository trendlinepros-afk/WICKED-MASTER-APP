import { ModuleTitle } from '@/shell/moduleContext'
import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  ClipboardPaste,
  FileDown,
  FileText,
  FolderOpen,
  History,
  Image as ImageIcon,
  LineChart,
  Loader2,
  MessageSquare,
  NotebookPen,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  X
} from 'lucide-react'
import { buildReportPdf } from './lib/pdf'
import {
  ID,
  useStockPlanner,
  type ScreenerKind,
  type Step,
  type TickerData
} from './store'

/* -------------------------------- helpers -------------------------------- */

const money = (v: number | null): string =>
  v === null
    ? '—'
    : v >= 1e12
      ? `$${(v / 1e12).toFixed(2)}T`
      : v >= 1e9
        ? `$${(v / 1e9).toFixed(2)}B`
        : v >= 1e6
          ? `$${(v / 1e6).toFixed(1)}M`
          : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`

const pct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
const pctCls = (v: number | null): string => (v === null ? 'text-muted' : v >= 0 ? 'text-ok' : 'text-danger')

function readFilesAsDataUrls(files: FileList | File[], cb: (urls: string[]) => void): void {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
  if (list.length === 0) return
  Promise.all(
    list.map(
      (f) =>
        new Promise<string>((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result))
          r.onerror = () => resolve('')
          r.readAsDataURL(f)
        })
    )
  ).then((urls) => cb(urls.filter(Boolean)))
}

/** Windows path → file:/// URL a <webview> can load (built-in PDF viewer). */
function fileUrl(p: string): string {
  return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

const exportStamp = (): string => {
  const now = new Date()
  return `${now.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })} ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

/* ------------------------------- find step ------------------------------- */

const SCREENERS: { kind: ScreenerKind; label: string }[] = [
  { kind: 'premarket', label: 'Pre-market' },
  { kind: 'afterhours', label: 'After-hours' },
  { kind: 'daily', label: 'Daily gainers' },
  { kind: 'p7', label: '7 days' },
  { kind: 'p30', label: '30 days' },
  { kind: 'p182', label: '6 months' },
  { kind: 'p365', label: '1 year' },
  { kind: 'ipos', label: 'IPOs' }
]

function FindStep(): React.JSX.Element {
  const s = useStockPlanner()

  return (
    <div className="space-y-4 p-4">
      {/* search / manual entry */}
      <div className="rounded-xl border border-edge bg-surface p-4">
        <label className="text-sm font-semibold">Find a stock</label>
        <div className="mt-2 flex gap-2">
          <input
            value={s.query}
            onChange={(e) => s.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const q = s.query.trim()
              if (/^[A-Za-z.]{1,6}$/.test(q)) void s.startAnalysis(q)
              else void s.search()
            }}
            placeholder="Ticker (JBLU) or company name…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void s.search()}
            disabled={s.searching || !s.query.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {s.searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Search
          </button>
          <button
            onClick={() => void s.startAnalysis(s.query)}
            disabled={!/^[A-Za-z.]{1,6}$/.test(s.query.trim())}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            Analyze <ArrowRight size={14} />
          </button>
        </div>
        {s.hits.length > 0 && (
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-edge">
            {s.hits.map((h) => (
              <button
                key={h.ticker}
                onClick={() => void s.startAnalysis(h.ticker)}
                className="flex w-full items-center gap-2 border-b border-edge/50 px-3 py-2 text-left text-sm hover:bg-raised"
              >
                <span className="w-16 shrink-0 font-semibold">{h.ticker}</span>
                <span className="min-w-0 truncate text-muted">{h.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* screeners */}
      <div className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {SCREENERS.map((sc) => (
            <button
              key={sc.kind}
              onClick={() => void s.runScreener(sc.kind)}
              disabled={s.screenerBusy}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${
                s.screenerKind === sc.kind ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'
              }`}
            >
              {sc.label}
            </button>
          ))}
          {s.screenerBusy && <Loader2 size={14} className="animate-spin text-accent" />}
        </div>

        {s.screenerNote && <p className="mt-3 text-xs text-warn">{s.screenerNote}</p>}

        {s.screenerRows.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-edge">
            <div className="grid grid-cols-[70px_1fr_90px_110px] gap-2 border-b border-edge bg-raised/40 px-3 py-1.5 text-[10px] font-semibold uppercase text-muted">
              <div>Symbol</div>
              <div className="text-right">Price</div>
              <div className="text-right">Change</div>
              <div className="text-right">Volume</div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {s.screenerRows.map((r) => (
                <button
                  key={r.symbol}
                  onClick={() => void s.startAnalysis(r.symbol)}
                  className="grid w-full grid-cols-[70px_1fr_90px_110px] items-center gap-2 border-b border-edge/40 px-3 py-1.5 text-left text-xs hover:bg-raised"
                >
                  <span className="font-semibold">{r.symbol}</span>
                  <span className="text-right tabular-nums">${r.price.toFixed(2)}</span>
                  <span className={`text-right tabular-nums ${pctCls(r.changePct)}`}>{pct(r.changePct)}</span>
                  <span className="text-right tabular-nums text-muted">{r.volume.toLocaleString('en-US')}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {s.ipoRows.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-edge">
            <div className="grid grid-cols-[90px_70px_1fr_90px] gap-2 border-b border-edge bg-raised/40 px-3 py-1.5 text-[10px] font-semibold uppercase text-muted">
              <div>Listing</div>
              <div>Symbol</div>
              <div>Company</div>
              <div className="text-right">Status</div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {s.ipoRows.map((r, i) => (
                <button
                  key={`${r.ticker}-${i}`}
                  onClick={() => r.ticker && void s.startAnalysis(r.ticker)}
                  className="grid w-full grid-cols-[90px_70px_1fr_90px] items-center gap-2 border-b border-edge/40 px-3 py-1.5 text-left text-xs hover:bg-raised"
                >
                  <span className="tabular-nums text-muted">{r.listingDate}</span>
                  <span className="font-semibold">{r.ticker}</span>
                  <span className="min-w-0 truncate">{r.name}</span>
                  <span className="text-right text-muted">{r.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* compare */}
      <div className="rounded-xl border border-edge bg-surface p-4">
        <label className="text-sm font-semibold">Compare up to 6 tickers</label>
        <div className="mt-2 flex gap-2">
          <input
            value={s.compareInput}
            onChange={(e) => s.setCompareInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void s.runCompare()
            }}
            placeholder="JBLU, AAL, ULCC"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void s.runCompare()}
            disabled={s.compareBusy || !s.compareInput.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {s.compareBusy ? <Loader2 size={14} className="animate-spin" /> : <BarChart3 size={14} />} Compare
          </button>
        </div>
        {s.compareRows.length > 0 && (
          <div className="mt-3 overflow-x-auto rounded-lg border border-edge">
            <div className="grid min-w-[520px] grid-cols-[70px_1fr_90px_110px_80px] gap-2 border-b border-edge bg-raised/40 px-3 py-1.5 text-[10px] font-semibold uppercase text-muted">
              <div>Symbol</div>
              <div className="text-right">Price</div>
              <div className="text-right">Change</div>
              <div className="text-right">Mkt cap</div>
              <div className="text-right">P/E</div>
            </div>
            {s.compareRows.map((r) => (
              <button
                key={r.symbol}
                onClick={() => void s.startAnalysis(r.symbol)}
                className="grid w-full min-w-[520px] grid-cols-[70px_1fr_90px_110px_80px] items-center gap-2 border-b border-edge/40 px-3 py-1.5 text-left text-xs hover:bg-raised"
              >
                <span className="font-semibold">{r.symbol}</span>
                <span className="text-right tabular-nums">{r.quote.price !== null ? `$${r.quote.price.toFixed(2)}` : '—'}</span>
                <span className={`text-right tabular-nums ${pctCls(r.quote.changePct)}`}>{pct(r.quote.changePct)}</span>
                <span className="text-right tabular-nums text-muted">{money(r.details?.marketCap ?? null)}</span>
                <span className="text-right tabular-nums text-muted">{r.pe !== null ? r.pe.toFixed(1) : 'n/a'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <HistoryCard />
    </div>
  )
}

/* ------------------------------ history card ------------------------------ */

interface HistoryRow {
  ticker: string
  company: string
  file: string
  savedAt: number
  exists: boolean
}

function HistoryCard(): React.JSX.Element | null {
  const setError = useStockPlanner((s) => s.setError)
  const startAnalysis = useStockPlanner((s) => s.startAnalysis)
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [viewer, setViewer] = useState<HistoryRow | null>(null)

  useEffect(() => {
    let mounted = true
    void window.wicked
      .invoke(`${ID}:history`)
      .then((res) => {
        const r = res as { ok?: boolean; rows?: HistoryRow[] }
        if (mounted && r.ok) setRows(r.rows ?? [])
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  const reveal = async (file: string): Promise<void> => {
    const res = (await window.wicked.invoke(`${ID}:reveal`, file)) as { ok?: boolean; error?: string }
    if (!res.ok) setError(res.error ?? 'Could not open the file location.')
  }

  if (rows.length === 0) return null

  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <label className="flex items-center gap-1.5 text-sm font-semibold">
        <History size={14} className="text-accent" /> History
      </label>
      <p className="mt-0.5 text-xs text-muted">Your previous analyses — every exported report, newest first.</p>
      <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-edge">
        {rows.map((r) => (
          <div
            key={r.file}
            className="flex flex-wrap items-center gap-2 border-b border-edge/50 px-3 py-2 last:border-b-0"
          >
            <button
              onClick={() => void startAnalysis(r.ticker)}
              title={`Re-open ${r.ticker} in the planner`}
              className="w-14 shrink-0 text-left text-sm font-semibold hover:text-accent"
            >
              {r.ticker}
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-muted">{r.company || '—'}</div>
              <div className="text-[11px] tabular-nums text-muted">
                {new Date(r.savedAt).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit'
                })}
                {!r.exists && <span className="ml-2 text-warn">file missing</span>}
              </div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                onClick={() => void reveal(r.file)}
                disabled={!r.exists}
                className="flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-xs font-medium hover:bg-edge/60 disabled:opacity-40"
              >
                <FolderOpen size={12} /> Go To File
              </button>
              <button
                onClick={() => r.exists && setViewer(r)}
                disabled={!r.exists}
                className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <FileText size={12} /> Open PDF
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* in-app PDF viewer (Chromium's built-in viewer inside a webview) */}
      {viewer && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 md:p-8" onClick={() => setViewer(null)}>
          <div
            className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-edge bg-surface"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
              <FileText size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {viewer.ticker}
                {viewer.company ? ` — ${viewer.company}` : ''}
              </span>
              <button
                onClick={() => void reveal(viewer.file)}
                className="flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-xs font-medium hover:bg-edge/60"
              >
                <FolderOpen size={12} /> Go To File
              </button>
              <button
                onClick={() => setViewer(null)}
                className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink"
              >
                <X size={15} />
              </button>
            </div>
            <webview src={fileUrl(viewer.file)} plugins className="min-h-0 w-full flex-1" />
          </div>
        </div>
      )}
    </div>
  )
}

/* ----------------------------- analysis step ----------------------------- */

function DataPanel({ d }: { d: TickerData }): React.JSX.Element {
  const rows: [string, string, string?][] = [
    ['Price', d.quote.price !== null ? `$${d.quote.price.toFixed(2)}` : '—'],
    ['Today', pct(d.quote.changePct), pctCls(d.quote.changePct)],
    ['Volume', d.quote.volume !== null ? d.quote.volume.toLocaleString('en-US') : '—'],
    ['Market cap', money(d.details?.marketCap ?? null)],
    ['P/E', d.pe !== null ? d.pe.toFixed(1) : d.netIncome !== null && d.netIncome <= 0 ? 'n/a (net loss)' : '—'],
    ['Revenue (yr)', money(d.revenue)],
    ['Net income', money(d.netIncome)],
    ['Sector', d.sector || '—'],
    [
      'Next earnings',
      d.earnings ? `${d.earnings.date} (${d.earnings.isEstimate ? 'est.' : 'confirmed'})` : 'not available'
    ]
  ]
  return (
    <div className="rounded-xl border border-edge bg-surface p-4">
      <div className="text-sm font-semibold">{d.details?.name ?? d.symbol}</div>
      <div className="mt-2 space-y-1.5 text-xs">
        {rows.map(([label, value, cls]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="text-muted">{label}</span>
            <span className={`text-right font-medium tabular-nums ${cls ?? 'text-ink'}`}>{value}</span>
          </div>
        ))}
      </div>
      {d.news.length > 0 && (
        <div className="mt-3 border-t border-edge pt-2">
          <div className="text-[10px] font-semibold uppercase text-muted">Headlines</div>
          {d.news.slice(0, 4).map((n, i) => (
            <button
              key={i}
              onClick={() => void window.wicked.invoke('shell:open-external', n.url)}
              className="mt-1.5 block w-full text-left text-xs text-ink hover:text-accent"
            >
              {n.title}
              <span className="ml-1 text-muted">· {n.source}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ReportCard(): React.JSX.Element | null {
  const doc = useStockPlanner((s) => s.doc)
  const busy = useStockPlanner((s) => s.reportBusy)
  const generate = useStockPlanner((s) => s.generateReport)
  const hasAi = useStockPlanner((s) => s.status?.hasAi ?? false)

  if (!doc?.report) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center rounded-xl border border-dashed border-edge p-6 text-center">
        {busy ? (
          <>
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="mt-2 text-sm text-muted">Writing the AI report card…</p>
          </>
        ) : (
          <>
            <Sparkles size={22} className="text-accent" />
            <p className="mt-2 max-w-xs text-sm text-muted">
              {hasAi
                ? 'Generate an AI report card grounded in the live data.'
                : 'Add a Gemini, DeepSeek or OpenAI key in Settings → API Keys to enable AI reports.'}
            </p>
            <button
              onClick={() => void generate()}
              disabled={!hasAi || busy}
              className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              Generate report
            </button>
          </>
        )}
      </div>
    )
  }
  const r = doc.report
  return (
    <div className="rounded-xl border border-edge bg-surface">
      <div className="border-b border-edge p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-base font-bold">{r.title}</h3>
            {r.subtitle && <p className="text-xs text-muted">{r.subtitle}</p>}
          </div>
          <button
            onClick={() => void generate()}
            disabled={busy}
            title="Regenerate report"
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 py-1.5 text-xs font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Redo
          </button>
        </div>
        {r.stats.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {r.stats.map((st, i) => (
              <div key={i} className="rounded-lg bg-raised/60 px-2.5 py-1.5">
                <div className="text-[9px] font-semibold uppercase text-muted">{st.label}</div>
                <div className="text-sm font-bold">{st.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-4 p-4">
        {r.sections.map((sec, i) => (
          <div key={i}>
            <h4 className="flex items-center gap-2 text-sm font-semibold">
              <span className="h-3.5 w-1 rounded bg-accent" /> {sec.heading}
            </h4>
            {sec.body && <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink/90">{sec.body}</p>}
            {sec.bullets.length > 0 && (
              <ul className="mt-1.5 space-y-1 text-sm text-ink/90">
                {sec.bullets.map((b, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {r.disclaimer && <p className="border-t border-edge pt-3 text-[11px] text-muted">{r.disclaimer}</p>}
      </div>
    </div>
  )
}

function AnalysisStep(): React.JSX.Element {
  const s = useStockPlanner()
  if (!s.ticker) return <NoTicker />
  return (
    <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        {s.data ? (
          <DataPanel d={s.data} />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-xl border border-edge bg-surface">
            {s.dataBusy ? <Loader2 size={20} className="animate-spin text-accent" /> : <span className="text-sm text-muted">No data.</span>}
          </div>
        )}
        {/* TradingView free widget (no key) in a webview */}
        <div className="overflow-hidden rounded-xl border border-edge" style={{ height: 380 }}>
          <webview
            src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(s.ticker)}&interval=D&theme=dark&style=1&locale=en&withdateranges=1&hide_side_toolbar=0`}
            className="h-full w-full"
          />
        </div>
      </div>
      <ReportCard />
    </div>
  )
}

/* ---------------------------- trendlines step ---------------------------- */

function TrendlinesStep(): React.JSX.Element {
  const s = useStockPlanner()
  const fileRef = useRef<HTMLInputElement>(null)
  if (!s.ticker) return <NoTicker />
  const images = s.doc?.images ?? []

  const pasteFromClipboard = async (): Promise<void> => {
    const res = (await window.wicked.invoke(`${ID}:clipboard-image`)) as {
      ok?: boolean
      dataUrl?: string
      error?: string
    }
    if (res.ok && res.dataUrl) void s.addImages([res.dataUrl])
    else s.setError(res.error ?? 'No image on the clipboard — copy a screenshot first.')
  }

  return (
    <div
      className="space-y-4 p-4"
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files)
        if (files.length > 0) readFilesAsDataUrls(files, (urls) => void s.addImages(urls))
      }}
    >
      <div className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Chart screenshots ({images.length}/4)</h3>
            <p className="text-xs text-muted">
              Upload or paste screenshots of your drawn trendlines (8&nbsp;MB each). “Analyze trendlines”
              rewrites the report with a Trendline read section.
            </p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) readFilesAsDataUrls(e.target.files, (urls) => void s.addImages(urls))
                e.target.value = ''
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={images.length >= 4}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
            >
              <ImageIcon size={14} /> Add screenshots
            </button>
            <button
              onClick={() => void pasteFromClipboard()}
              disabled={images.length >= 4}
              title="Paste the screenshot you copied (Win+Shift+S, then this button)"
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
            >
              <ClipboardPaste size={14} /> Paste From Clipboard
            </button>
            <button
              onClick={() => void s.analyzeTrendlines()}
              disabled={s.reportBusy || images.length === 0 || !(s.status?.hasAi ?? false)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
            >
              {s.reportBusy ? <Loader2 size={14} className="animate-spin" /> : <LineChart size={14} />} Analyze trendlines
            </button>
          </div>
        </div>
        {images.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {images.map((img, i) => (
              <div key={i} className="group relative overflow-hidden rounded-lg border border-edge">
                <img src={img} alt={`Chart ${i + 1}`} className="max-h-64 w-full object-contain" />
                <button
                  onClick={() => void s.removeImage(i)}
                  className="absolute right-1.5 top-1.5 rounded-md bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <ReportCard />
    </div>
  )
}

/* ------------------------------ summary step ------------------------------ */

function SummaryStep(): React.JSX.Element {
  const s = useStockPlanner()
  if (!s.ticker) return <NoTicker />
  const canExport = !!s.doc?.report

  const exportPdf = async (): Promise<void> => {
    if (!s.doc?.report || s.exporting) return
    s.setExporting(true)
    try {
      // When the user gave no trendline screenshots, embed a generated 2-year
      // price chart instead so the report always has a chart.
      let chartBars: { t: number; c: number }[] = []
      if (!s.doc.images || s.doc.images.length === 0) {
        try {
          const pr = (await window.wicked.invoke(`${ID}:price-series`, s.ticker, 730)) as {
            ok?: boolean
            bars?: { t: number; c: number }[]
          }
          if (pr?.ok && Array.isArray(pr.bars)) chartBars = pr.bars
        } catch {
          /* chart is best-effort — export the report either way */
        }
      }
      // Refresh the stat cards from live data so a cached report still shows the
      // CURRENT cards (Analyst research / 52-week range, real P/E, …) — the AI
      // prose stays as-is; only the deterministic stats are recomputed.
      let stats = s.doc.report.stats
      try {
        const sres = (await window.wicked.invoke(`${ID}:report-stats`, s.ticker)) as {
          ok?: boolean
          stats?: { label: string; value: string }[]
        }
        if (sres?.ok && Array.isArray(sres.stats) && sres.stats.length > 0) stats = sres.stats
      } catch {
        /* keep the cached stats if the refresh fails */
      }
      // stamp the real export date/time — the AI-written asOf can be stale/wrong
      const b64 = buildReportPdf({ ...s.doc.report, stats, asOf: exportStamp() }, s.doc.images, undefined, chartBars)
      const res = (await window.wicked.invoke(`${ID}:save-pdf`, { ticker: s.ticker, data: b64 })) as {
        ok?: boolean
        file?: string
        error?: string
      }
      if (!res.ok) s.setError(res.error ?? 'PDF export failed.')
    } catch (err) {
      s.setError(err instanceof Error ? err.message : String(err))
    } finally {
      s.setExporting(false)
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-edge bg-surface p-5 text-center">
        <FileDown size={24} className="mx-auto text-accent" />
        <h3 className="mt-2 text-base font-bold">Export the {s.ticker} report</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Builds a styled PDF (report card{s.doc?.images.length ? ` + ${s.doc.images.length} screenshot(s)` : ' + a 2-year price chart'}) and
          saves it under <code className="text-xs">Documents\Stock Trading\{s.ticker}…</code>
        </p>
        <button
          onClick={() => void exportPdf()}
          disabled={!canExport || s.exporting}
          className="mx-auto mt-4 flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
        >
          {s.exporting ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />} Export PDF
        </button>
        {!canExport && <p className="mt-2 text-xs text-warn">Generate the report first (Analysis step).</p>}
      </div>
      <ReportCard />
    </div>
  )
}

function NoTicker(): React.JSX.Element {
  const setStep = useStockPlanner((s) => s.setStep)
  return (
    <div className="flex flex-1 items-center justify-center p-10 text-center">
      <div>
        <TrendingUp size={24} className="mx-auto text-accent" />
        <p className="mt-2 text-sm text-muted">Pick a stock first.</p>
        <button onClick={() => setStep('find')} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink">
          Go to Find
        </button>
      </div>
    </div>
  )
}

/* -------------------------------- chat dock ------------------------------- */

function ChatDock(): React.JSX.Element {
  const s = useStockPlanner()
  const endRef = useRef<HTMLDivElement>(null)
  const chat = s.doc?.chat ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.length, s.chatBusy])

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2 text-sm font-semibold">
        <MessageSquare size={14} className="text-accent" /> Assistant
        {s.ticker && <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-bold">{s.ticker}</span>}
        <button onClick={() => s.setChatOpen(false)} className="ml-auto rounded p-1 text-muted hover:bg-raised hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {chat.length === 0 && (
          <p className="text-xs text-muted">
            Ask about {s.ticker || 'any ticker'} — mention a symbol (or $cashtag) and I&apos;ll pull its live
            data. Paste a chart screenshot to discuss it.
          </p>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`max-w-[92%] rounded-lg px-2.5 py-2 text-xs leading-relaxed ${m.role === 'user' ? 'ml-auto bg-accent/15 text-ink' : 'bg-raised text-ink/90'}`}>
            {m.role === 'user' && (m.images ?? 0) > 0 && (
              <div className="mb-1 text-[10px] text-muted">{m.images} chart(s) attached</div>
            )}
            <div className="whitespace-pre-wrap">{m.text}</div>
          </div>
        ))}
        {s.chatBusy && <Loader2 size={14} className="animate-spin text-accent" />}
        <div ref={endRef} />
      </div>
      {s.chatImages.length > 0 && (
        <div className="flex gap-1.5 border-t border-edge px-3 py-1.5">
          {s.chatImages.map((img, i) => (
            <img key={i} src={img} alt="" className="h-9 w-14 rounded border border-edge object-cover" />
          ))}
          <button onClick={s.clearChatImages} className="text-[10px] text-muted hover:text-danger">
            clear
          </button>
        </div>
      )}
      <div className="border-t border-edge p-2">
        <textarea
          value={s.chatInput}
          onChange={(e) => s.setChatInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void s.sendChat()
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length > 0) readFilesAsDataUrls(files, (urls) => urls.forEach((u) => s.addChatImage(u)))
          }}
          rows={2}
          placeholder={s.ticker ? `Ask about ${s.ticker}…` : 'Pick a stock first…'}
          disabled={!s.ticker || s.chatBusy}
          className="w-full resize-none rounded-lg border border-edge bg-raised px-2.5 py-2 text-xs outline-none focus:border-accent disabled:opacity-50"
        />
      </div>
      {/* report card done → walk the flow forward */}
      {s.step === 'analysis' && !!s.doc?.report && (
        <div className="border-t border-edge p-2">
          <button
            onClick={() => s.setStep('trendlines')}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ok px-3 py-2 text-sm font-semibold text-bg hover:opacity-90"
          >
            Next · Trendlines <ArrowRight size={14} />
          </button>
        </div>
      )}
      {s.step === 'trendlines' && !!s.doc?.report && (
        <div className="border-t border-edge p-2">
          <button
            onClick={() => s.setStep('summary')}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-ok px-3 py-2 text-sm font-semibold text-bg hover:opacity-90"
          >
            Next · Summary <ArrowRight size={14} />
          </button>
        </div>
      )}
    </aside>
  )
}

/* --------------------------------- shell ---------------------------------- */

const STEPS: { id: Step; label: string }[] = [
  { id: 'find', label: '1 · Find' },
  { id: 'analysis', label: '2 · Analysis' },
  { id: 'trendlines', label: '3 · Trendlines' },
  { id: 'summary', label: '4 · Summary' }
]

export default function StockPlanner(): React.JSX.Element {
  const s = useStockPlanner()

  useEffect(() => {
    void s.loadStatus()
    // always land on Find when the tool is opened (previous work stays one tab away)
    s.setStep('find')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <NotebookPen size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight"><ModuleTitle fallback="Stock Research" /></h1>
          <p className="truncate text-xs text-muted">
            {s.ticker ? `${s.ticker}${s.doc?.company ? ` — ${s.doc.company}` : ''}` : 'Guided research desk'}
            {s.status ? ` · market ${s.status.session}` : ''}
          </p>
        </div>
        {!s.chatOpen && (
          <button
            onClick={() => s.setChatOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60"
          >
            <MessageSquare size={14} /> Assistant
          </button>
        )}
      </header>

      {s.status && !s.status.hasMassive && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0 text-warn" />
          <span>
            Add your <strong>Massive / Polygon</strong> key (and optionally Finnhub) in{' '}
            <strong>Settings → API Keys</strong> for live market data.
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-edge px-4 pt-2">
        {STEPS.map((st) => (
          <button
            key={st.id}
            onClick={() => s.setStep(st.id)}
            className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-1.5 text-sm ${
              s.step === st.id ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {st.label}
          </button>
        ))}
      </div>

      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {s.step === 'find' && <FindStep />}
          {s.step === 'analysis' && <AnalysisStep />}
          {s.step === 'trendlines' && <TrendlinesStep />}
          {s.step === 'summary' && <SummaryStep />}
        </div>
        {s.chatOpen && <ChatDock />}
      </div>

      <footer className="flex items-center gap-2 border-t border-edge px-5 py-1.5 text-xs text-muted">
        {(s.reportBusy || s.dataBusy || s.chatBusy) && <Loader2 size={12} className="shrink-0 animate-spin text-accent" />}
        <span className="truncate">{s.statusMsg}</span>
      </footer>
    </div>
  )
}

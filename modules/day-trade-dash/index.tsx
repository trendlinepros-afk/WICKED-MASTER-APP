import React, { useEffect, useRef, useState } from 'react'
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { LayoutDashboard, Newspaper, Plus, RefreshCw, Settings, Tv, X } from 'lucide-react'
import { ModuleTitle } from '@/shell/moduleContext'
import { CHART_TFS, DEFAULT_TV_URL, defaultState, type ChartTf, type DashQuote, type DashState, type SessionInfo } from './types'

/**
 * DAY TRADE DASH — renderer.
 *
 * The all-day cockpit: three always-on candle charts across the top (ticker +
 * timeframe each, persisted so backup/sync restores the exact layout), a
 * watchlist whose rows click into a fourth chart, an hourly-on-the-hour
 * market-news column, a Wall-Street-style scrolling tape along the bottom
 * (symbols configurable in Settings), an ET session clock with a countdown to
 * the next bell, and an optional Bloomberg TV live panel (YouTube embed in a
 * webview). Quotes/charts poll Massive/Polygon via main.
 */
const ID = 'day-trade-dash'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

function cssRGB(v: string, fb: string): string {
  // Theme tokens are space-separated RGB ("148 155 170"); lightweight-charts only
  // parses comma-separated rgb(), so join with commas.
  try {
    const s = getComputedStyle(document.documentElement).getPropertyValue(v).trim()
    if (!s) return fb
    const p = s.split(/[\s,]+/).filter(Boolean)
    return p.length >= 3 ? `rgb(${p[0]}, ${p[1]}, ${p[2]})` : s.startsWith('#') || s.startsWith('rgb') ? s : fb
  } catch {
    return fb
  }
}

/**
 * lightweight-charts renders UTCTimestamp axis/crosshair labels in UTC — it
 * never converts to the viewer's timezone, so real epoch times showed 12:00
 * when it was 8:00 in New York. Shift each bar by the LOCAL offset at that
 * bar's moment (per-bar, so DST flips inside the loaded range stay correct);
 * the chart then renders local wall-clock time.
 */
const toChartTime = (ms: number): UTCTimestamp =>
  Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp

const fmtPrice = (n: number): string => (n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toFixed(2))
const fmtPct = (n: number | null): string => (n == null ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`)
const pctTone = (n: number | null | undefined): string => (n == null ? 'text-muted' : n >= 0 ? 'text-ok' : 'text-danger')
const fmtCountdown = (min: number): string => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`)
const fmtNewsTime = (iso: string): string => {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* --------------------------------- chart ---------------------------------- */

/** One live candle chart. Fetches on symbol/tf change, then keeps polling —
 *  fitContent only on the first load of a symbol/tf so panning isn't fought. */
function CandleChart({ symbol, tf }: { symbol: string; tf: ChartTf }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const edge = cssRGB('--wk-edge', '#233043')
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssRGB('--wk-muted', '#94a3b8') },
      grid: { vertLines: { color: edge }, horzLines: { color: edge } },
      rightPriceScale: { borderColor: edge },
      timeScale: { borderColor: edge, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal }
    })
    const up = cssRGB('--wk-ok', '#22c55e')
    const dn = cssRGB('--wk-danger', '#ef4444')
    candleRef.current = chart.addCandlestickSeries({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn })
    volRef.current = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' })
    volRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
    chartRef.current = chart
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    let alive = true
    let first = true
    const load = async (): Promise<void> => {
      if (!symbol) {
        setMsg('Set a ticker.')
        return
      }
      const res = (await invoke('bars', { symbol, tf })) as { ok?: boolean; bars?: Bar[]; error?: string }
      if (!alive) return
      const bars = res?.bars ?? []
      if (!bars.length) {
        setMsg(res?.error || `No data for ${symbol}.`)
        return
      }
      setMsg('')
      const up = cssRGB('--wk-ok', '#22c55e')
      const dn = cssRGB('--wk-danger', '#ef4444')
      candleRef.current?.setData(bars.map((b) => ({ time: toChartTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
      volRef.current?.setData(bars.map((b) => ({ time: toChartTime(b.t), value: b.v, color: b.c >= b.o ? up : dn })))
      if (first) {
        first = false
        chartRef.current?.timeScale().fitContent()
      }
    }
    candleRef.current?.setData([])
    volRef.current?.setData([])
    void load()
    const timer = setInterval(() => void load(), tf === 'D' ? 300_000 : 30_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [symbol, tf])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={wrapRef} className="absolute inset-0" />
      {msg && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg bg-raised/90 px-3 py-1 text-xs text-muted">
          {msg}
        </div>
      )}
    </div>
  )
}

/** Chart card with an editable ticker + timeframe picker in its header. */
function ChartSlotCard({
  symbol,
  tf,
  quote,
  onChange
}: {
  symbol: string
  tf: ChartTf
  quote?: DashQuote
  onChange: (symbol: string, tf: ChartTf) => void
}): React.JSX.Element {
  const [text, setText] = useState(symbol)
  useEffect(() => setText(symbol), [symbol])
  const commit = (): void => {
    const s = text.trim().toUpperCase()
    if (s && s !== symbol) onChange(s, tf)
    else setText(symbol)
  }
  return (
    <section className="flex min-h-0 flex-col rounded-xl border border-edge bg-surface p-2">
      <div className="flex items-center gap-1.5 pb-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value.toUpperCase())}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          spellCheck={false}
          className="w-20 rounded-md border border-edge bg-raised px-2 py-1 text-sm font-bold outline-none focus:border-accent"
        />
        {quote?.price != null && (
          <span className="min-w-0 truncate text-xs tabular-nums text-muted">
            {fmtPrice(quote.price)} <span className={pctTone(quote.changePct)}>{fmtPct(quote.changePct)}</span>
          </span>
        )}
        <span className="flex-1" />
        <div className="flex overflow-hidden rounded-md border border-edge">
          {CHART_TFS.map((t) => (
            <button
              key={t}
              onClick={() => onChange(symbol, t)}
              className={`px-1.5 py-0.5 text-[11px] font-medium ${t === tf ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-raised'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <CandleChart symbol={symbol} tf={tf} />
    </section>
  )
}

/* ---------------------------------- main ----------------------------------- */

interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: string
  tickers?: string[]
}

export default function DayTradeDash(): React.JSX.Element {
  const [dash, setDash] = useState<DashState>(defaultState())
  const [loaded, setLoaded] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, DashQuote>>({})
  const [news, setNews] = useState<NewsItem[]>([])
  const [newsAt, setNewsAt] = useState(0)
  const [newsBusy, setNewsBusy] = useState(false)
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [watchInput, setWatchInput] = useState('')
  const [tapeInput, setTapeInput] = useState('')
  const [tvUrlInput, setTvUrlInput] = useState('')

  const dashRef = useRef(dash)
  dashRef.current = dash

  const applyState = (res: unknown): void => {
    const r = res as { ok?: boolean; state?: DashState; error?: string }
    if (r.state) setDash(r.state)
    if (!r.ok && r.error) setError(r.error)
  }
  const patch = async (p: Partial<DashState>): Promise<void> => applyState(await invoke('state-set', p))

  /* one poll loop feeds the tape, the watchlist AND the chart headers */
  const pollQuotes = async (): Promise<void> => {
    const d = dashRef.current
    const syms = [
      ...new Set([...d.tape, ...d.watch.map((w) => w.symbol), ...d.charts.map((c) => c.symbol), d.selected].filter(Boolean))
    ]
    if (syms.length === 0) return
    const res = (await invoke('quotes', { symbols: syms })) as { ok?: boolean; quotes?: Record<string, DashQuote>; error?: string }
    if (res.ok && res.quotes) {
      setQuotes(res.quotes)
      setError('')
      // backfill missing "% since added" anchors with the first price seen
      for (const w of dashRef.current.watch) {
        const p = res.quotes[w.symbol]?.price
        if (w.addedPrice == null && p != null) applyState(await invoke('watch-anchor', { symbol: w.symbol, price: p }))
      }
    } else if (res.error) setError(res.error)
  }

  const loadNews = async (manual = false): Promise<void> => {
    if (manual) setNewsBusy(true)
    const res = (await invoke('news', { limit: 30 })) as { ok?: boolean; items?: NewsItem[]; at?: number; error?: string }
    setNewsBusy(false)
    if (res.ok) {
      setNews(res.items ?? [])
      setNewsAt(res.at ?? Date.now())
    } else if (res.error) setError(res.error)
  }

  const loadSession = async (): Promise<void> => {
    const res = (await invoke('session')) as { ok?: boolean; info?: SessionInfo }
    if (res.ok && res.info) setSession(res.info)
  }

  useEffect(() => {
    void (async () => {
      applyState(await invoke('state-get'))
      setLoaded(true)
      void pollQuotes()
      void loadNews()
      void loadSession()
    })()
    const q = setInterval(() => void pollQuotes(), 20_000)
    const s = setInterval(() => void loadSession(), 30_000)
    // news refreshes ON THE HOUR (plus a few seconds so the feed has the hour's items)
    let hourly: ReturnType<typeof setInterval> | null = null
    const toHour = setTimeout(
      () => {
        void loadNews()
        hourly = setInterval(() => void loadNews(), 3_600_000)
      },
      3_600_000 - (Date.now() % 3_600_000) + 5_000
    )
    return () => {
      clearInterval(q)
      clearInterval(s)
      clearTimeout(toHour)
      if (hourly) clearInterval(hourly)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setChartSlot = (i: number, symbol: string, tf: ChartTf): void => {
    const charts = dash.charts.map((c, j) => (j === i ? { symbol, tf } : c))
    void patch({ charts })
    setTimeout(() => void pollQuotes(), 500)
  }

  const addWatch = async (): Promise<void> => {
    const sym = watchInput.trim().toUpperCase()
    if (!sym) return
    setWatchInput('')
    applyState(await invoke('watch-add', { symbol: sym }))
    void patch({ selected: sym })
    setTimeout(() => void pollQuotes(), 500)
  }

  const sessionMeta: Record<SessionInfo['session'], { label: string; cls: string }> = {
    premarket: { label: 'Pre-market', cls: 'border-warn/60 bg-warn/10 text-warn' },
    regular: { label: 'Market open', cls: 'border-ok/60 bg-ok/10 text-ok' },
    afterhours: { label: 'After hours', cls: 'border-accent/60 bg-accent/10 text-accent' },
    closed: { label: 'Market closed', cls: 'border-edge bg-raised text-muted' }
  }

  const tapeSyms = dash.tape.filter((s) => quotes[s]?.price != null)
  const selectedQuote = quotes[dash.selected]

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <LayoutDashboard size={19} />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Day Trade Dash" />
          </h1>
        </div>
        {session && (
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${sessionMeta[session.session].cls}`}>
            {sessionMeta[session.session].label}
            {session.minutesToNext != null && (
              <span className="font-normal opacity-80"> · {session.nextLabel} in {fmtCountdown(session.minutesToNext)}</span>
            )}
            <span className="font-normal opacity-60"> · {session.etClock} ET</span>
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={() => void patch({ tvOn: !dash.tvOn })}
          title="Bloomberg TV live (YouTube) — change the stream in Settings"
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${dash.tvOn ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-muted hover:border-accent/60'}`}
        >
          <Tv size={13} /> Live TV
        </button>
        <button
          onClick={() => {
            setTvUrlInput(dash.tvUrl)
            setShowSettings(true)
          }}
          className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-muted hover:border-accent/60 hover:text-ink"
        >
          <Settings size={13} /> Settings
        </button>
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-1.5 text-xs text-danger">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button onClick={() => setError('')} className="rounded p-0.5 hover:bg-danger/15">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-2.5">
        {/* top: the three always-on charts */}
        <div className="grid h-[38%] min-h-[220px] grid-cols-1 gap-2.5 lg:grid-cols-3">
          {loaded &&
            dash.charts.map((c, i) => (
              <ChartSlotCard key={i} symbol={c.symbol} tf={c.tf} quote={quotes[c.symbol]} onChange={(s, t) => setChartSlot(i, s, t)} />
            ))}
        </div>

        {/* middle: watchlist | selected chart | news | (tv) */}
        <div className="flex min-h-0 flex-1 gap-2.5">
          {/* watchlist */}
          <section className="flex w-72 shrink-0 flex-col rounded-xl border border-edge bg-surface p-2">
            <div className="flex items-center gap-1.5 pb-1.5">
              <input
                value={watchInput}
                onChange={(e) => setWatchInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addWatch()
                }}
                placeholder="Add ticker"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-edge bg-raised px-2 py-1 text-xs outline-none focus:border-accent"
              />
              <button onClick={() => void addWatch()} className="rounded-md border border-edge p-1 text-muted hover:border-accent/60 hover:text-ink">
                <Plus size={13} />
              </button>
            </div>
            {dash.watch.length > 0 && (
              <div className="flex items-center gap-1.5 px-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted">
                <span className="min-w-0 flex-1">Sym · last</span>
                <span className="w-14 text-right">Day</span>
                <span className="w-14 text-right" title="% change since you added it to the watchlist">
                  Added
                </span>
                <span className="w-4" />
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {dash.watch.length === 0 && <p className="px-1 pt-2 text-[11px] text-muted">Add tickers — click one to chart it.</p>}
              {dash.watch.map((w) => {
                const sym = w.symbol
                const q = quotes[sym]
                const sinceAdd =
                  q?.price != null && w.addedPrice != null && w.addedPrice > 0
                    ? ((q.price - w.addedPrice) / w.addedPrice) * 100
                    : null
                return (
                  <div
                    key={sym}
                    onClick={() => void patch({ selected: sym })}
                    title={
                      w.addedAt
                        ? `Added ${new Date(w.addedAt).toLocaleDateString()}${w.addedPrice != null ? ` @ $${w.addedPrice.toFixed(2)}` : ''}`
                        : undefined
                    }
                    className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs ${
                      dash.selected === sym ? 'bg-accent/10 text-accent' : 'hover:bg-raised'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">{sym}</span>
                      {q?.price != null && <span className="ml-1.5 tabular-nums text-muted">{fmtPrice(q.price)}</span>}
                    </span>
                    <span className={`w-14 text-right tabular-nums ${pctTone(q?.changePct)}`}>{q ? fmtPct(q.changePct) : '—'}</span>
                    <span className={`w-14 text-right tabular-nums ${pctTone(sinceAdd)}`}>{sinceAdd != null ? fmtPct(sinceAdd) : '—'}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void invoke('watch-remove', { symbol: sym }).then(applyState)
                      }}
                      className="w-4 rounded p-0.5 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
                      title="Remove"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>

          {/* selected ticker chart */}
          <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-edge bg-surface p-2">
            <div className="flex items-center gap-2 pb-1.5">
              <span className="text-sm font-bold">{dash.selected || '—'}</span>
              {selectedQuote?.price != null && (
                <span className="text-xs tabular-nums text-muted">
                  {fmtPrice(selectedQuote.price)} <span className={pctTone(selectedQuote.changePct)}>{fmtPct(selectedQuote.changePct)}</span>
                </span>
              )}
              <span className="flex-1" />
              <div className="flex overflow-hidden rounded-md border border-edge">
                {CHART_TFS.map((t) => (
                  <button
                    key={t}
                    onClick={() => void patch({ selectedTf: t })}
                    className={`px-1.5 py-0.5 text-[11px] font-medium ${t === dash.selectedTf ? 'bg-accent text-accent-ink' : 'text-muted hover:bg-raised'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {dash.selected ? (
              <CandleChart symbol={dash.selected} tf={dash.selectedTf} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-muted">Click a watchlist ticker.</div>
            )}
          </section>

          {/* news */}
          <section className="flex w-72 shrink-0 flex-col rounded-xl border border-edge bg-surface p-2 xl:w-80">
            <div className="flex items-center gap-1.5 pb-1.5">
              <Newspaper size={13} className="text-accent" />
              <span className="text-xs font-semibold">Market news</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-muted">
                {newsAt ? `updated ${new Date(newsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · hourly` : ''}
              </span>
              <button
                onClick={() => void loadNews(true)}
                title="Refresh now (auto-refreshes on the hour)"
                className="rounded p-1 text-muted hover:text-ink"
              >
                <RefreshCw size={12} className={newsBusy ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {news.length === 0 && <p className="px-1 pt-2 text-[11px] text-muted">No headlines yet.</p>}
              {news.map((n, i) => (
                <a
                  key={i}
                  href={n.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-md border border-edge/60 bg-raised/40 px-2 py-1.5 hover:border-accent/50"
                >
                  <p className="text-[11px] font-medium leading-snug">{n.title}</p>
                  <p className="mt-0.5 truncate text-[10px] text-muted">
                    {n.source}
                    {n.publishedAt ? ` · ${fmtNewsTime(n.publishedAt)}` : ''}
                    {n.tickers && n.tickers.length > 0 ? ` · ${n.tickers.join(' ')}` : ''}
                  </p>
                </a>
              ))}
            </div>
          </section>

          {/* live TV */}
          {dash.tvOn && (
            <section className="flex w-[380px] shrink-0 flex-col rounded-xl border border-edge bg-surface p-2">
              <div className="flex items-center gap-1.5 pb-1.5">
                <Tv size={13} className="text-accent" />
                <span className="text-xs font-semibold">Live TV</span>
                <span className="flex-1" />
                <button onClick={() => void patch({ tvOn: false })} className="rounded p-1 text-muted hover:text-ink">
                  <X size={12} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-black/40">
                {/* eslint-disable-next-line react/no-unknown-property */}
                <webview key={dash.tvUrl} src={dash.tvUrl} className="h-full w-full" />
              </div>
              <p className="pt-1 text-[10px] text-muted">Starts muted (autoplay rules) — unmute in the player. Stream URL in Settings.</p>
            </section>
          )}
        </div>

        {/* bottom: the tape */}
        <div className="relative h-9 shrink-0 overflow-hidden rounded-xl border border-edge bg-surface">
          <style>{`@keyframes wk-tape { from { transform: translateX(0); } to { transform: translateX(-50%); } }`}</style>
          {tapeSyms.length === 0 ? (
            <div className="flex h-full items-center px-3 text-[11px] text-muted">
              Tape warming up — quotes load every 20s. Add symbols in Settings.
            </div>
          ) : (
            <div
              className="absolute inset-y-0 flex w-max items-center hover:[animation-play-state:paused]"
              style={{ animation: `wk-tape ${Math.max(24, tapeSyms.length * 6)}s linear infinite` }}
            >
              {[...tapeSyms, ...tapeSyms].map((sym, i) => {
                const q = quotes[sym]
                if (!q || q.price == null) return null
                const upTone = (q.changePct ?? 0) >= 0
                return (
                  <span key={`${sym}-${i}`} className="flex items-center gap-1.5 pr-10 text-xs tabular-nums">
                    <span className="font-bold">{sym}</span>
                    <span className="text-muted">{fmtPrice(q.price)}</span>
                    <span className={upTone ? 'text-ok' : 'text-danger'}>
                      {upTone ? '▲' : '▼'} {fmtPct(q.changePct)}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* settings */}
      {showSettings && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-6" onClick={() => setShowSettings(false)}>
          <div className="w-full max-w-xl rounded-xl border border-edge bg-surface p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Dashboard settings</h2>
              <button onClick={() => setShowSettings(false)} className="rounded p-1 text-muted hover:text-ink">
                <X size={14} />
              </button>
            </div>

            <p className="mt-3 text-xs font-medium">Rotating tape symbols</p>
            <p className="text-[10px] text-muted">
              Stocks and ETFs. For futures/indices use the ETF proxies day traders watch: ES→SPY, NQ→QQQ, YM→DIA, RTY→IWM, CL→USO, GC→GLD, ZB→TLT, VIX→UVXY.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {dash.tape.map((sym) => (
                <span key={sym} className="flex items-center gap-1 rounded-full border border-edge bg-raised px-2 py-0.5 text-xs">
                  {sym}
                  <button
                    onClick={() => void patch({ tape: dash.tape.filter((t) => t !== sym) })}
                    className="text-muted hover:text-danger"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <input
                value={tapeInput}
                onChange={(e) => setTapeInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tapeInput.trim()) {
                    void patch({ tape: [...dash.tape, tapeInput.trim().toUpperCase()] })
                    setTapeInput('')
                    setTimeout(() => void pollQuotes(), 500)
                  }
                }}
                placeholder="Add + Enter"
                spellCheck={false}
                className="w-24 rounded-full border border-edge bg-raised px-2 py-0.5 text-xs outline-none focus:border-accent"
              />
            </div>

            <p className="mt-4 text-xs font-medium">Live TV stream (YouTube embed URL)</p>
            <div className="mt-1 flex gap-1.5">
              <input
                value={tvUrlInput}
                onChange={(e) => setTvUrlInput(e.target.value)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-edge bg-raised px-2 py-1.5 text-xs outline-none focus:border-accent"
              />
              <button
                onClick={() => setTvUrlInput(DEFAULT_TV_URL)}
                className="shrink-0 rounded-md border border-edge px-2 py-1.5 text-xs text-muted hover:border-accent/60 hover:text-ink"
              >
                Bloomberg
              </button>
            </div>
            <p className="mt-1 text-[10px] text-muted">
              Default is Bloomberg Television's 24/7 live stream. Any https://www.youtube.com/embed/… URL works (CNBC-style channels, a specific
              live video, …).
            </p>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => {
                  void patch({ tvUrl: tvUrlInput.trim() || DEFAULT_TV_URL })
                  setShowSettings(false)
                }}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

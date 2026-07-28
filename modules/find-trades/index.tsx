import { useEffect, useRef } from 'react'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Flame,
  Loader2,
  Radar,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  TrendingUp
} from 'lucide-react'
import { useFindTrades, type ChatMsg } from './store'
import type { Pick, TrendRow } from './ipc'

/** Time windows for the X trending pull (mirrors ipc/x.ts X_WINDOWS). */
const X_WINDOWS = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '14d', label: '2wk' },
  { id: '30d', label: '1mo' },
  { id: '90d', label: '90d' },
  { id: '180d', label: '6mo' }
] as const

const scoreCls = (label: string): string =>
  label === 'Hot' ? 'bg-danger/15 text-danger' : label === 'Warm' ? 'bg-warn/15 text-warn' : label === 'Watch' ? 'bg-accent/15 text-accent' : 'bg-raised text-muted'

function agoLabel(ms: number | null): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const money = (v: number | null): string => (v == null ? 'n/a' : `$${v.toFixed(2)}`)
const cap = (v: number | null): string =>
  v == null ? 'n/a' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v.toFixed(0)}`
const vol = (v: number | null): string => (v == null ? 'n/a' : v.toLocaleString('en-US'))
const pctCls = (v: number | null): string => (v == null ? 'text-muted' : v >= 0 ? 'text-ok' : 'text-danger')
const pct = (v: number | null): string => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)

const EXAMPLES = [
  'Stocks under $10 up more than 10% today on heavy volume',
  'Large-cap tech down 3%+ today',
  'Low-priced biotech with recent FDA or trial news',
  'Most active stocks over $50 with a news catalyst',
  'Small caps under $2B market cap gapping up premarket'
]

function PickCard({ p }: { p: Pick }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-edge bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold">{p.ticker}</span>
            {p.name && <span className="min-w-0 truncate text-xs text-muted">{p.name}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <span className="tabular-nums text-ink">{money(p.price)}</span>
            <span className={`flex items-center gap-0.5 tabular-nums ${pctCls(p.changePct)}`}>
              {p.changePct != null && (p.changePct >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />)}
              {pct(p.changePct)}
            </span>
            <span className="tabular-nums">Vol {vol(p.volume)}</span>
            {p.sector && p.sector !== '—' && <span>{p.sector}</span>}
            {p.marketCap != null && <span className="tabular-nums">Cap {cap(p.marketCap)}</span>}
          </div>
        </div>
      </div>
      {p.thesis && <p className="mt-2 text-sm text-ink/90">{p.thesis}</p>}
      {p.flags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {p.flags.map((f, i) => (
            <span key={i} className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
              {f}
            </span>
          ))}
        </div>
      )}
      {p.news.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-edge/60 pt-2">
          {p.news.slice(0, 2).map((n, i) => (
            <button
              key={i}
              onClick={() => void window.wicked.invoke('shell:open-external', n.url)}
              className="flex w-full items-start gap-1.5 text-left text-xs text-muted hover:text-accent"
            >
              <ExternalLink size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{n.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantMsg({ m }: { m: ChatMsg }): React.JSX.Element {
  return (
    <div className="space-y-2">
      {m.text && (
        <div className="flex gap-2">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-accent" />
          <p className="text-sm text-ink/90">{m.text}</p>
        </div>
      )}
      {m.picks && m.picks.length > 0 && (
        <div className="grid grid-cols-1 gap-2 pl-6 md:grid-cols-2">
          {m.picks.map((p) => (
            <PickCard key={p.ticker} p={p} />
          ))}
        </div>
      )}
      {m.provider && <div className="pl-6 text-[10px] text-muted">via {m.provider}</div>}
    </div>
  )
}

function SentimentBar({ r }: { r: TrendRow }): React.JSX.Element {
  const tot = Math.max(1, r.bull + r.bear + r.neutral)
  const bp = (r.bull / tot) * 100
  const rp = (r.bear / tot) * 100
  return (
    <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-raised" title={`${r.bull} bullish · ${r.neutral} neutral · ${r.bear} bearish`}>
      <div className="h-full bg-ok" style={{ width: `${bp}%` }} />
      <div className="h-full bg-muted/40" style={{ width: `${100 - bp - rp}%` }} />
      <div className="h-full bg-danger" style={{ width: `${rp}%` }} />
    </div>
  )
}

function TrendRowItem({ r, rank }: { r: TrendRow; rank: number }): React.JSX.Element {
  const s = useFindTrades()
  const canAsk = !!s.status?.hasAi && !s.busy
  return (
    <div className="grid grid-cols-[20px_1fr_auto] items-center gap-2 border-b border-edge/50 px-3 py-2 text-xs last:border-b-0 hover:bg-raised/40">
      <span className="text-center text-[10px] font-semibold text-muted">{rank}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-bold">${r.ticker}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${scoreCls(r.label)}`}>{r.label} · {r.score}</span>
          <span className="tabular-nums text-muted">{r.mentions} mention{r.mentions === 1 ? '' : 's'}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
          <SentimentBar r={r} />
          {r.price != null && <span className="tabular-nums text-ink">{money(r.price)}</span>}
          {r.changePct != null && (
            <span className={`flex items-center gap-0.5 tabular-nums ${pctCls(r.changePct)}`}>
              {r.changePct >= 0 ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
              {pct(r.changePct)}
            </span>
          )}
          {r.volume != null && <span className="tabular-nums">Vol {vol(r.volume)}</span>}
        </div>
      </div>
      <button
        onClick={() => void s.send(`What's driving $${r.ticker} right now? It's trending on X (${r.mentions} mentions, ${r.label.toLowerCase()}). Is it worth a trade?`)}
        disabled={!canAsk}
        title={canAsk ? 'Ask the AI screener about this ticker' : 'Add an AI key to ask the screener'}
        className="flex items-center gap-1 rounded-lg border border-edge bg-surface px-2 py-1 text-[11px] font-medium hover:border-accent/60 disabled:opacity-40"
      >
        <Sparkles size={11} className="text-accent" /> Ask AI
      </button>
    </div>
  )
}

function TrendingPanel(): React.JSX.Element | null {
  const s = useFindTrades()
  if (!s.status) return null

  return (
    <div className="border-b border-edge bg-surface/50">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-bold">
          <Flame size={15} className="text-danger" /> Trending on X
        </span>
        {s.status.hasX && (
          <>
            <div className="flex items-center gap-1 rounded-lg border border-edge bg-raised p-0.5">
              {X_WINDOWS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => s.setXWindow(w.id)}
                  disabled={s.xBusy}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${s.xWindow === w.id ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
                >
                  {w.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void s.loadTrending(true)}
              disabled={s.xBusy}
              title="Refresh (uses your X API quota)"
              className="flex items-center gap-1 rounded-lg bg-raised px-2 py-1 text-[11px] font-medium hover:bg-edge/60 disabled:opacity-50"
            >
              {s.xBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </button>
            {s.xGeneratedAt && !s.xBusy && <span className="text-[10px] text-muted">as of {agoLabel(s.xGeneratedAt)}</span>}
          </>
        )}
      </div>

      {!s.status.hasX ? (
        <div className="px-4 pb-3 text-xs text-muted">
          Add your <strong>X (Twitter) Bearer Token</strong> in Settings → API Keys to see the tickers
          mentioned most on X — with a bull/bear read and a heat rating — over 24h to 6 months.
        </div>
      ) : s.xArchiveNeeded ? (
        <div className="flex items-start gap-2 px-4 pb-3 text-xs text-warn">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {s.xError} Windows beyond 7 days need X API Pro (full-archive access).
        </div>
      ) : s.xError ? (
        <div className="flex items-start gap-2 px-4 pb-3 text-xs text-danger">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {s.xError}
        </div>
      ) : s.xBusy && s.xRows.length === 0 ? (
        <div className="flex items-center gap-2 px-4 pb-3 text-xs text-muted">
          <Loader2 size={13} className="animate-spin text-accent" /> Scanning X for the most-mentioned tickers…
        </div>
      ) : s.xRows.length === 0 && s.xLoaded ? (
        <div className="px-4 pb-3 text-xs text-muted">No cashtags found in that window — try a longer window or refresh.</div>
      ) : (
        <>
          <div className="max-h-[300px] overflow-y-auto">
            {s.xRows.map((r, i) => (
              <TrendRowItem key={r.ticker} r={r} rank={i + 1} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 text-[10px] text-muted">
            <TrendingUp size={11} />
            <span>
              {s.xSampled} tweets sampled{s.xMarketValidated ? ' · validated against live market data' : ''} · rating = buzz + momentum + sentiment.
            </span>
            {s.xNote && <span className="text-warn">{s.xNote}</span>}
            <span>Uses your X API quota — cached ~30&nbsp;min.</span>
          </div>
        </>
      )}
    </div>
  )
}

export default function FindTrades(): React.JSX.Element {
  const s = useFindTrades()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void s.loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [s.chat.length, s.busy])

  const noMarket = s.status && !s.status.hasMassive
  const noAi = s.status && !s.status.hasAi

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Radar size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">Find Trades</h1>
          <p className="truncate text-xs text-muted">
            Describe what you&apos;re hunting — the AI screens the live market {s.status ? `· market ${s.status.session}` : ''}
          </p>
        </div>
        {s.chat.length > 0 && (
          <button onClick={s.clear} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm hover:bg-edge/60">
            <Trash2 size={14} /> Clear
          </button>
        )}
      </header>

      {(noMarket || noAi) && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0 text-warn" />
          <span>
            {noMarket && (
              <>
                Add your <strong>Massive / Polygon</strong> key for market data.
              </>
            )}
            {noMarket && noAi && ' '}
            {noAi && (
              <>
                Add an <strong>Anthropic (Claude), Gemini, DeepSeek or OpenAI</strong> key to run the AI screener.
              </>
            )}{' '}
            (Settings → API Keys). Finnhub is optional for richer news.
          </span>
        </div>
      )}

      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 break-words">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-1 hover:bg-danger/15">
            ✕
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TrendingPanel />
        {s.chat.length === 0 ? (
          <div className="mx-auto max-w-2xl p-6">
            <div className="rounded-xl border border-edge bg-surface p-5 text-center">
              <Radar size={26} className="mx-auto text-accent" />
              <h2 className="mt-2 text-base font-bold">What are you looking for?</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted">
                Ask in plain English — price, % move, volume, market cap, sector, or a news catalyst. The
                AI turns it into a live screen and comes back with matching tickers and why they fit.
              </p>
            </div>
            <div className="mt-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Try one</div>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => void s.send(ex)}
                  disabled={!!noMarket || !!noAi}
                  className="flex w-full items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-left text-sm hover:border-accent/60 disabled:opacity-40"
                >
                  <Sparkles size={13} className="shrink-0 text-accent" />
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 p-4">
            {s.chat.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="ml-auto max-w-[85%] rounded-xl bg-accent/15 px-3 py-2 text-sm text-ink">
                  {m.text}
                </div>
              ) : (
                <AssistantMsg key={i} m={m} />
              )
            )}
            {s.busy && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 size={15} className="animate-spin text-accent" /> Screening the market…
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-edge p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={s.input}
            onChange={(e) => s.setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void s.send()
              }
            }}
            rows={1}
            placeholder="e.g. stocks under $5 up 20%+ today with news…"
            disabled={!!noMarket || !!noAi || s.busy}
            className="min-h-[42px] flex-1 resize-none rounded-lg border border-edge bg-raised px-3 py-2.5 text-sm outline-none focus:border-accent disabled:opacity-50"
          />
          <button
            onClick={() => void s.send()}
            disabled={!s.input.trim() || s.busy || !!noMarket || !!noAi}
            className="flex h-[42px] items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            {s.busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-muted">
          Screens live data for ideas to research — educational only, not financial advice.
        </p>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { ModuleTitle } from '@/shell/moduleContext'
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Plug,
  RefreshCw,
  Spline,
  Trash2,
  X
} from 'lucide-react'
import { HORIZONS, INTERVALS, useTrendlineCharts, type Recent } from './store'

/** Fixed legend colors that match the lines the API actually draws. */
const HZ_COLOR: Record<string, string> = {
  '30d': '#e0a90b',
  '90d': '#3b82f6',
  '6mo': '#22c55e',
  '1y': '#ef4444'
}

function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function RecentChip({ r, onClick }: { r: Recent; onClick: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-left text-xs hover:border-accent"
      title={`${r.horizons.join(', ') || 'all'} · ${r.interval}`}
    >
      <span className="font-semibold">{r.ticker}</span>
      <span className="flex gap-1">
        {r.horizons.map((h) => (
          <span key={h} className="h-2 w-2 rounded-full" style={{ background: HZ_COLOR[h] ?? '#888' }} />
        ))}
      </span>
      <span className="text-muted">{relTime(r.at)}</span>
    </button>
  )
}

export default function TrendlineCharts(): React.JSX.Element {
  const s = useTrendlineCharts()

  useEffect(() => {
    void s.loadStatus()
    void s.loadRecents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Spline size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Trendline Charts" />
          </h1>
          <p className="truncate text-xs text-muted">
            Algorithmic support/resistance charts from TrendlineFinder
          </p>
        </div>
        <button
          onClick={() => void s.checkHealth()}
          disabled={s.healthBusy}
          className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-xs font-medium hover:bg-edge/60 disabled:opacity-50"
        >
          {s.healthBusy ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />} Test connection
        </button>
      </header>

      {s.hasKey === false && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0 text-warn" />
          <span>
            Add your <strong>TrendlineFinder</strong> API key (<code>tlf_live_…</code>) in{' '}
            <strong>Settings → API Keys</strong> to pull charts.
          </span>
        </div>
      )}

      {s.healthMsg && (
        <div
          className={`flex items-center gap-2 border-b px-5 py-2 text-sm ${
            s.healthOk ? 'border-ok/40 bg-ok/10 text-ok' : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {s.healthOk ? <Check size={14} className="shrink-0" /> : <AlertTriangle size={14} className="shrink-0" />}
          <span>{s.healthMsg}</span>
        </div>
      )}

      {s.error && (
        <div className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-5 py-2 text-sm text-danger">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{s.error}</span>
          <button onClick={s.dismissError} className="rounded p-0.5 hover:bg-danger/20">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-5xl space-y-4">
          {/* controls */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1">
                <label className="text-xs font-semibold text-muted">Ticker</label>
                <input
                  value={s.ticker}
                  onChange={(e) => s.setTicker(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void s.fetchChart()
                  }}
                  placeholder="AAPL"
                  spellCheck={false}
                  autoComplete="off"
                  className="mt-1 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm uppercase outline-none focus:border-accent"
                />
              </div>
              <button
                onClick={() => void s.fetchChart()}
                disabled={s.busy || !s.ticker.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                {s.busy ? <Loader2 size={14} className="animate-spin" /> : <Spline size={14} />} Get chart
              </button>
            </div>

            {/* horizons */}
            <div className="mt-4">
              <label className="text-xs font-semibold text-muted">Trendline horizons (pairs drawn)</label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {HORIZONS.map((h) => {
                  const on = s.horizons.includes(h.id)
                  return (
                    <button
                      key={h.id}
                      onClick={() => s.toggleHorizon(h.id)}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium ${
                        on ? 'border-accent bg-accent/10 text-ink' : 'border-edge bg-raised text-muted hover:text-ink'
                      }`}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: HZ_COLOR[h.id] }} />
                      {h.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                The image zooms to the longest horizon selected. Support = solid, resistance = dashed.
              </p>
            </div>

            {/* interval + options */}
            <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
              <div>
                <label className="text-xs font-semibold text-muted">Candle interval</label>
                <div className="mt-1.5 flex overflow-hidden rounded-lg border border-edge">
                  {INTERVALS.map((iv) => (
                    <button
                      key={iv}
                      onClick={() => s.setInterval(iv)}
                      className={`px-3 py-1.5 text-sm font-medium ${
                        s.interval === iv ? 'bg-accent text-accent-ink' : 'bg-raised text-muted hover:text-ink'
                      }`}
                    >
                      {iv}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted">Size (px)</label>
                <div className="mt-1.5 flex items-center gap-1.5 text-sm">
                  <input
                    type="number"
                    min={320}
                    max={2400}
                    value={s.width}
                    onChange={(e) => s.setWidth(Number(e.target.value))}
                    className="w-20 rounded-lg border border-edge bg-raised px-2 py-1.5 outline-none focus:border-accent"
                  />
                  <span className="text-muted">×</span>
                  <input
                    type="number"
                    min={240}
                    max={1600}
                    value={s.height}
                    onChange={(e) => s.setHeight(Number(e.target.value))}
                    className="w-20 rounded-lg border border-edge bg-raised px-2 py-1.5 outline-none focus:border-accent"
                  />
                </div>
              </div>

              <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={s.branding}
                  onChange={(e) => s.setBranding(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
                <span className="text-muted">Show TrendlineFinder footer</span>
              </label>
            </div>
          </div>

          {/* chart display */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            {s.busy ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted">
                <Loader2 size={28} className="animate-spin" />
                <span className="text-sm">Drawing {s.ticker.trim().toUpperCase()} trendlines…</span>
              </div>
            ) : s.image ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-semibold">{s.image.ticker}</span>
                    <span className="text-muted">
                      {s.image.horizons ? ` · ${s.image.horizons}` : ''}
                      {s.image.spanDays ? ` · ${s.image.spanDays} days shown` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void s.saveChart()}
                      disabled={s.saving}
                      className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-sm font-medium hover:bg-edge/60 disabled:opacity-50"
                    >
                      {s.saving ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Save PNG
                    </button>
                    <button
                      onClick={() => void s.fetchChart()}
                      className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-sm font-medium hover:bg-edge/60"
                    >
                      <RefreshCw size={13} /> Refresh
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-lg border border-edge bg-bg">
                  <img
                    src={s.image.dataUrl}
                    alt={`${s.image.ticker} trendline chart`}
                    className="mx-auto block max-w-full"
                  />
                </div>
                {s.savedMsg && (
                  <p className="flex items-center gap-1.5 text-xs text-ok">
                    <Check size={13} /> {s.savedMsg}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted">
                <ImageIcon size={28} />
                <span className="text-sm">Enter a ticker and hit “Get chart”.</span>
              </div>
            )}
          </div>

          {/* recents */}
          {s.recents.length > 0 && (
            <div className="rounded-xl border border-edge bg-surface p-4">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-muted">Recent</label>
                <button
                  onClick={() => void s.clearRecents()}
                  className="flex items-center gap-1 text-xs text-muted hover:text-danger"
                >
                  <Trash2 size={12} /> Clear
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.recents.map((r) => (
                  <RecentChip key={`${r.ticker}-${r.horizons.join('')}-${r.interval}-${r.at}`} r={r} onClick={() => void s.applyRecent(r)} />
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={() => void window.wicked.invoke('trendline-charts:reveal-exports')}
              className="flex items-center gap-1.5 text-xs text-muted hover:text-ink"
            >
              <FolderOpen size={13} /> Open saved-charts folder
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

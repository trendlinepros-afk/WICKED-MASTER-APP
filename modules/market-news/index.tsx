import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowUpDown, ExternalLink, Layers, Loader2, Newspaper, RefreshCw, Search, X } from 'lucide-react'
import { filterBySector, SECTORS, SORTS, sortRows, type NewsRow, type SortId } from './filters'

const ID = 'market-news'

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function MarketNews(): React.JSX.Element {
  const [rows, setRows] = useState<NewsRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [symbol, setSymbol] = useState('')
  const [sector, setSector] = useState('all')
  const [sort, setSort] = useState<SortId>('newest')

  const shown = useMemo(() => sortRows(filterBySector(rows, sector), sort), [rows, sector, sort])

  const load = async (sym: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = (await window.wicked.invoke(`${ID}:news`, sym)) as {
        ok?: boolean
        rows?: NewsRow[]
        error?: string
      }
      if (res.ok) setRows(res.rows ?? [])
      else setError(res.error ?? 'Could not load news.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Newspaper size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">Market News</h1>
          <p className="truncate text-xs text-muted">
            {symbol ? `${symbol} company news · last 30 days` : 'Market-wide headlines · refreshes on the 6 AM ET news day'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-raised px-2" title="Filter by market sector">
            <Layers size={13} className="shrink-0 text-muted" />
            <select
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              className="max-w-40 cursor-pointer bg-transparent py-2 text-sm text-ink outline-none [&>option]:bg-surface [&>option]:text-ink"
            >
              {SECTORS.map((sec) => (
                <option key={sec.id} value={sec.id}>
                  {sec.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-raised px-2" title="Sort headlines">
            <ArrowUpDown size={13} className="shrink-0 text-muted" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortId)}
              className="cursor-pointer bg-transparent py-2 text-sm text-ink outline-none [&>option]:bg-surface [&>option]:text-ink"
            >
              {SORTS.map((so) => (
                <option key={so.id} value={so.id}>
                  {so.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-raised px-2">
            <Search size={13} className="text-muted" />
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void load(symbol.trim())
              }}
              placeholder="Filter by ticker…"
              spellCheck={false}
              className="w-28 bg-transparent py-2 text-sm outline-none"
            />
            {symbol && (
              <button
                onClick={() => {
                  setSymbol('')
                  void load('')
                }}
                className="text-muted hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <button
            onClick={() => void load(symbol.trim())}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-warn/40 bg-warn/10 px-5 py-2 text-sm">
          <AlertTriangle size={14} className="shrink-0 text-warn" />
          <span>{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {shown.length === 0 && !busy && !error ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            {rows.length > 0
              ? `No headlines match the ${SECTORS.find((x) => x.id === sector)?.label ?? ''} filter — try another sector.`
              : 'No headlines yet.'}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {rows.length > 0 && (
              <p className="px-1 text-[11px] text-muted">
                Showing {shown.length} of {rows.length} headline{rows.length === 1 ? '' : 's'}
              </p>
            )}
            {shown.map((n, i) => (
              <button
                key={i}
                onClick={() => void window.wicked.invoke('shell:open-external', n.url)}
                className="group w-full rounded-xl border border-edge bg-surface p-3.5 text-left hover:border-accent/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium leading-snug text-ink group-hover:text-accent">{n.title}</div>
                    {n.summary && <p className="mt-1 line-clamp-2 text-xs text-muted">{n.summary}</p>}
                    <div className="mt-1.5 text-[11px] text-muted">
                      {n.source} · {when(n.publishedAt)}
                    </div>
                  </div>
                  <ExternalLink size={13} className="mt-1 shrink-0 text-muted group-hover:text-accent" />
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

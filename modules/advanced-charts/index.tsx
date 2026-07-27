import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderOpen, LineChart, Loader2, RefreshCw } from 'lucide-react'

const ID = 'advanced-charts'

interface Status {
  libraryPath: string | null
  configured: boolean
  hasMassive: boolean
  url: string | null
}

export default function AdvancedCharts(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    const res = (await window.wicked.invoke(`${ID}:status`)) as Partial<Status> & { ok?: boolean }
    if (res.ok) {
      setStatus({
        libraryPath: res.libraryPath ?? null,
        configured: !!res.configured,
        hasMassive: !!res.hasMassive,
        url: res.url ?? null
      })
      if (res.url) setUrl(res.url)
    }
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = (await window.wicked.invoke(`${ID}:start`)) as { ok?: boolean; url?: string; error?: string }
      if (res.ok && res.url) setUrl(res.url)
      else setError(res.error ?? 'Could not start the chart host.')
    } finally {
      setBusy(false)
    }
  }

  const locate = async (): Promise<void> => {
    setError('')
    const res = (await window.wicked.invoke(`${ID}:set-library-path`)) as { ok?: boolean; error?: string }
    if (!res.ok && res.error) setError(res.error)
    await refresh()
  }

  useEffect(() => {
    void (async () => {
      await refresh()
      // auto-start when already configured
      const res = (await window.wicked.invoke(`${ID}:status`)) as { configured?: boolean }
      if (res.configured) void start()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (url) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-4 py-2 text-xs text-muted">
          <LineChart size={14} className="text-accent" />
          <span className="font-medium text-ink">Advanced Charts</span>
          <span>· layouts &amp; drawings save via the chart’s own Save menu</span>
          {status && !status.hasMassive && (
            <span className="flex items-center gap-1 text-warn">
              <AlertTriangle size={12} /> no Massive key — charts will be empty
            </span>
          )}
        </div>
        <webview src={url} className="min-h-0 w-full flex-1" />
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
            <LineChart size={20} />
          </span>
          <h1 className="text-xl font-bold tracking-tight">Advanced Charts</h1>
        </div>

        <p className="mt-4 text-sm text-muted">
          Full TradingView charting workspace — candlesticks, every drawing tool, indicators, and
          saved layouts (drawings included), fed by your Massive market data.
        </p>

        <div className="mt-4 rounded-lg border border-edge bg-raised/40 p-4 text-sm">
          <p className="font-medium">One-time setup — the charting library is licensed by TradingView:</p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted">
            <li>
              Request free access at{' '}
              <button
                className="text-accent hover:underline"
                onClick={() => void window.wicked.invoke('shell:open-external', 'https://www.tradingview.com/advanced-charts/')}
              >
                tradingview.com/advanced-charts <ExternalLink size={11} className="inline" />
              </button>{' '}
              (they grant a private GitHub repo).
            </li>
            <li>
              Download it and keep the <code className="text-xs">charting_library</code> folder somewhere permanent.
            </li>
            <li>Point WICKED at that folder below.</li>
          </ol>
        </div>

        {status?.libraryPath && !status.configured && (
          <p className="mt-3 text-xs text-warn">
            Saved path has no charting_library.standalone.js — pick the folder again.
          </p>
        )}
        {error && <p className="mt-3 rounded-lg bg-danger/10 p-2 text-xs text-danger">{error}</p>}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={() => void locate()}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            <FolderOpen size={15} /> Locate library…
          </button>
          <button
            onClick={() => void start()}
            disabled={busy || !status?.configured}
            className="flex items-center gap-2 rounded-lg bg-raised px-4 py-2 text-sm font-medium hover:bg-edge/60 disabled:opacity-40"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Open charts
          </button>
        </div>
        {status?.configured && (
          <p className="mt-2 truncate text-xs text-ok" title={status.libraryPath ?? ''}>
            Library found: {status.libraryPath}
          </p>
        )}
      </div>
    </div>
  )
}

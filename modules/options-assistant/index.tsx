import React, { useEffect, useRef, useState } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  CircleDot,
  Download,
  Loader2,
  Plus,
  Send,
  Target,
  Trash2,
  X
} from 'lucide-react'
import { ModuleTitle } from '@/shell/moduleContext'

/**
 * OPTIONS ASSISTANT — chat UI.
 *
 * Left: watchlist builder (type tickers or import your Webull watchlists) and
 * the play controls (direction + expiration timeframe + optional budget).
 * Right: the chat. "Find the trade" runs the scan (live progress streams into
 * the thread); the result renders as a pick card; follow-up questions go to
 * the same assistant grounded on the latest scan.
 */
const ID = 'options-assistant'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args)

const HORIZON_OPTIONS = [
  { id: '0d', label: 'Zero day (0DTE)' },
  { id: '1d', label: 'Next market day' },
  { id: '2d', label: '2 days' },
  { id: '3d', label: '3 days' },
  { id: '5d', label: '1 week' },
  { id: '10d', label: '2 weeks' },
  { id: '21d', label: '1 month' }
]

interface ContractInfo {
  option_symbol?: string
  expiry?: string
  strike?: number
  type?: string
  bid?: number | null
  ask?: number | null
  mid?: number | null
  spread_pct?: number | null
  est_cost_per_contract?: number | null
}

interface Pick {
  ticker: string
  option_symbol: string
  label: string
  why: string[]
  risks: string[]
  entry: string
  confidence: number
  contract?: ContractInfo | null
}

interface ScanResultMsg {
  summary: string
  best: Pick | null
  runners_up: { ticker: string; option_symbol: string; label: string; note: string; contract?: ContractInfo | null }[]
  avoided: { ticker: string; reason: string }[]
  direction: 'up' | 'down'
  horizonLabel: string
  provider?: string
}

type Msg =
  | { kind: 'user'; text: string; images?: string[] }
  | { kind: 'assistant'; text: string; provider?: string }
  | { kind: 'working'; lines: string[] }
  | { kind: 'result'; result: ScanResultMsg }
  | { kind: 'error'; text: string }

/** Read a pasted/dropped image file and downscale big screenshots (longest
 *  edge 1568px, JPEG) so they stay friendly to the vision models. */
const fileToDataUrl = (file: File): Promise<string | null> =>
  new Promise((resolve) => {
    const fr = new FileReader()
    fr.onerror = () => resolve(null)
    fr.onload = () => {
      const raw = String(fr.result ?? '')
      const img = new Image()
      img.onerror = () => resolve(raw || null)
      img.onload = () => {
        const MAX = 1568
        const scale = Math.min(1, MAX / Math.max(img.width, img.height))
        if (scale === 1 && raw.length < 2_000_000) return resolve(raw)
        const cv = document.createElement('canvas')
        cv.width = Math.max(1, Math.round(img.width * scale))
        cv.height = Math.max(1, Math.round(img.height * scale))
        const c2d = cv.getContext('2d')
        if (!c2d) return resolve(raw)
        c2d.drawImage(img, 0, 0, cv.width, cv.height)
        resolve(cv.toDataURL('image/jpeg', 0.88))
      }
      img.src = raw
    }
    fr.readAsDataURL(file)
  })

interface Status {
  hasWebull: boolean
  hasAi: boolean
  aiProvider?: string | null
  hasMassive: boolean
  watchlist: string[]
  busy: boolean
}

const money = (v: number | null | undefined): string =>
  v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function OptionsAssistant(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [watchlist, setWatchlist] = useState<string[]>([])
  const [symInput, setSymInput] = useState('')
  const [direction, setDirection] = useState<'up' | 'down'>('up')
  const [horizon, setHorizon] = useState('2d')
  const [budget, setBudget] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [pendingImgs, setPendingImgs] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [chatBusy, setChatBusy] = useState(false)
  const [wbLists, setWbLists] = useState<{ id: string; name: string }[] | null>(null)
  const [wbListsBusy, setWbListsBusy] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const msgsRef = useRef<Msg[]>([])
  msgsRef.current = messages

  const refreshStatus = async (): Promise<void> => {
    const st = (await invoke('status')) as Status & { ok?: boolean }
    setStatus(st)
    setWatchlist(st.watchlist ?? [])
  }

  useEffect(() => {
    void refreshStatus()
    const off = window.wicked.on(`${ID}:progress`, (raw) => {
      const p = raw as { kind?: string; text?: string }
      if (p.kind === 'step' && p.text) {
        setMessages((cur) => {
          const next = [...cur]
          const lastIdx = next.length - 1
          if (lastIdx >= 0 && next[lastIdx].kind === 'working') {
            const w = next[lastIdx] as { kind: 'working'; lines: string[] }
            next[lastIdx] = { kind: 'working', lines: [...w.lines.slice(-8), p.text!] }
          }
          return next
        })
      }
    })
    return off
  }, [])

  // keep the thread pinned to the bottom
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  /* ------------------------------ watchlist ------------------------------ */

  const addSymbol = async (): Promise<void> => {
    const sym = symInput.trim().toUpperCase()
    if (!sym) return
    const res = (await invoke('watchlist-add', { symbol: sym })) as { ok?: boolean; watchlist?: string[]; error?: string }
    if (res.ok && res.watchlist) {
      setWatchlist(res.watchlist)
      setSymInput('')
    } else if (res.error) {
      setMessages((m) => [...m, { kind: 'error', text: res.error! }])
    }
  }

  const removeSymbol = async (sym: string): Promise<void> => {
    const res = (await invoke('watchlist-remove', { symbol: sym })) as { ok?: boolean; watchlist?: string[] }
    if (res.ok && res.watchlist) setWatchlist(res.watchlist)
  }

  const loadWbLists = async (): Promise<void> => {
    setWbListsBusy(true)
    try {
      const res = (await invoke('webull-watchlists')) as { ok?: boolean; watchlists?: { id: string; name: string }[]; error?: string }
      if (res.ok) setWbLists(res.watchlists ?? [])
      else setMessages((m) => [...m, { kind: 'error', text: res.error ?? 'Could not load Webull watchlists.' }])
    } finally {
      setWbListsBusy(false)
    }
  }

  const importWbList = async (id: string): Promise<void> => {
    const res = (await invoke('webull-import', { watchlistId: id })) as {
      ok?: boolean
      watchlist?: string[]
      imported?: number
      error?: string
    }
    if (res.ok && res.watchlist) {
      setWatchlist(res.watchlist)
      setWbLists(null)
      setMessages((m) => [...m, { kind: 'assistant', text: `Imported ${res.imported} ticker(s) from your Webull watchlist.` }])
    } else if (res.error) {
      setMessages((m) => [...m, { kind: 'error', text: res.error! }])
    }
  }

  const testConnection = async (): Promise<void> => {
    setTestMsg('Testing…')
    const res = (await invoke('test-connection')) as { ok?: boolean; note?: string; error?: string }
    setTestMsg(res.ok ? (res.note ?? 'OK') : (res.error ?? 'Failed'))
  }

  /* -------------------------------- scan --------------------------------- */

  const runScan = async (): Promise<void> => {
    if (scanning) return
    const dirWord = direction === 'up' ? 'calls (stock going UP)' : 'puts (stock going DOWN)'
    const horizonLabel = HORIZON_OPTIONS.find((h) => h.id === horizon)?.label ?? horizon
    setScanning(true)
    setMessages((m) => [
      ...m,
      { kind: 'user', text: `Find my best ${dirWord} — expiration: ${horizonLabel}${budget ? `, max $${budget} per contract` : ''}.` },
      { kind: 'working', lines: ['Starting scan…'] }
    ])
    try {
      const res = (await invoke('scan', {
        direction,
        horizon,
        budget: budget ? Number(budget) : undefined
      })) as { ok?: boolean; result?: ScanResultMsg; error?: string }
      setMessages((cur) => {
        const next = cur.filter((m) => m.kind !== 'working')
        if (res.ok && res.result) next.push({ kind: 'result', result: res.result })
        else next.push({ kind: 'error', text: res.error ?? 'Scan failed.' })
        return next
      })
    } finally {
      setScanning(false)
    }
  }

  const cancelScan = async (): Promise<void> => {
    await invoke('cancel')
  }

  /* -------------------------------- chat --------------------------------- */

  const addImageFiles = async (files: File[]): Promise<void> => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue
      const url = await fileToDataUrl(f)
      if (url) setPendingImgs((cur) => (cur.length >= 3 ? cur : [...cur, url]))
    }
  }

  /** Ctrl+V anywhere in the chat panel attaches pasted screenshots. */
  const onPanelPaste = (e: React.ClipboardEvent): void => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length > 0) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  const onPanelDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    void addImageFiles([...e.dataTransfer.files])
  }

  const sendChat = async (): Promise<void> => {
    const q = chatInput.trim()
    const images = pendingImgs
    if ((!q && images.length === 0) || chatBusy) return
    setChatInput('')
    setPendingImgs([])
    setChatBusy(true)
    const shown = q || 'Look at this screenshot.'
    setMessages((m) => [...m, { kind: 'user', text: shown, images: images.length ? images : undefined }])
    try {
      // visible transcript (text turns only) becomes the chat history
      const history = msgsRef.current
        .filter((m): m is { kind: 'user' | 'assistant'; text: string } => m.kind === 'user' || m.kind === 'assistant')
        .slice(-12)
        .map((m) => ({ role: m.kind, text: m.text }))
      const res = (await invoke('chat', { question: q, history, images })) as {
        ok?: boolean
        text?: string
        provider?: string
        error?: string
      }
      setMessages((m) => [
        ...m,
        res.ok && res.text
          ? { kind: 'assistant', text: res.text, provider: res.provider }
          : { kind: 'error', text: res.error ?? 'Chat failed.' }
      ])
    } finally {
      setChatBusy(false)
    }
  }

  /* --------------------------------- UI ---------------------------------- */

  const dot = (on: boolean): string => (on ? 'text-ok' : 'text-danger')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent">
          <Target size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-bold tracking-tight">
            <ModuleTitle fallback="Options Assistant" />
          </h1>
          <p className="truncate text-xs text-muted">
            <span className={dot(!!status?.hasWebull)}>● Webull OpenAPI</span>
            {' · '}
            <span className={dot(!!status?.hasAi)}>● AI</span>
            {' · '}
            <span className={dot(!!status?.hasMassive)}>● Market data</span>
            {' · '}
            <button onClick={() => void testConnection()} className="text-accent hover:underline">
              Test connection
            </button>
            {testMsg && <span className="ml-1.5">{testMsg}</span>}
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="mx-auto grid h-full max-w-[1500px] grid-cols-1 gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
          {/* left rail */}
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            {/* play controls */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <h2 className="text-sm font-semibold">The play</h2>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => setDirection('up')}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm font-medium ${
                    direction === 'up' ? 'border-ok bg-ok/15 text-ok' : 'border-edge text-muted hover:text-ink'
                  }`}
                >
                  <ArrowUpRight size={15} /> Up · Calls
                </button>
                <button
                  onClick={() => setDirection('down')}
                  className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm font-medium ${
                    direction === 'down' ? 'border-danger bg-danger/15 text-danger' : 'border-edge text-muted hover:text-ink'
                  }`}
                >
                  <ArrowDownRight size={15} /> Down · Puts
                </button>
              </div>
              <label className="mt-3 block text-xs font-medium text-muted">Expiration timeframe</label>
              <select
                value={horizon}
                onChange={(e) => setHorizon(e.target.value)}
                className="mt-1 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              >
                {HORIZON_OPTIONS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </select>
              <label className="mt-3 block text-xs font-medium text-muted">Max $ per contract (optional)</label>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="e.g. 300"
                className="mt-1 w-full rounded-lg border border-edge bg-raised px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              {scanning ? (
                <button
                  onClick={() => void cancelScan()}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/60 px-3 py-2.5 text-sm font-semibold text-danger hover:bg-danger/10"
                >
                  <Loader2 size={15} className="animate-spin" /> Scanning… click to cancel
                </button>
              ) : (
                <button
                  onClick={() => void runScan()}
                  disabled={watchlist.length === 0}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40"
                >
                  <Target size={15} /> Find the trade
                </button>
              )}
            </section>

            {/* watchlist */}
            <section className="rounded-xl border border-edge bg-surface p-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Watchlist ({watchlist.length})</h2>
                <button
                  onClick={() => void loadWbLists()}
                  disabled={wbListsBusy}
                  title="Import a watchlist you built in Webull"
                  className="flex items-center gap-1 rounded-lg border border-edge px-2 py-1 text-xs text-muted hover:text-ink disabled:opacity-40"
                >
                  {wbListsBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} From Webull
                </button>
              </div>
              {wbLists && (
                <div className="mt-2 rounded-lg border border-edge bg-raised p-2">
                  {wbLists.length === 0 ? (
                    <p className="text-xs text-muted">No watchlists found on your Webull account.</p>
                  ) : (
                    wbLists.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => void importWbList(w.id)}
                        className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-edge/50"
                      >
                        {w.name || w.id}
                      </button>
                    ))
                  )}
                  <button onClick={() => setWbLists(null)} className="mt-1 text-xs text-muted hover:text-ink">
                    Close
                  </button>
                </div>
              )}
              <div className="mt-2 flex gap-1.5">
                <input
                  value={symInput}
                  onChange={(e) => setSymInput(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addSymbol()
                  }}
                  placeholder="Add ticker (AAPL)"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => void addSymbol()}
                  className="rounded-lg border border-edge px-2.5 text-muted hover:text-ink"
                >
                  <Plus size={15} />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {watchlist.length === 0 && (
                  <p className="text-xs text-muted">Empty — add the tickers you want scanned for option plays.</p>
                )}
                {watchlist.map((sym) => (
                  <span
                    key={sym}
                    className="flex items-center gap-1 rounded-full border border-edge bg-raised px-2.5 py-1 text-xs font-medium"
                  >
                    {sym}
                    <button onClick={() => void removeSymbol(sym)} className="text-muted hover:text-danger">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </section>
          </div>

          {/* chat */}
          <div
            className="flex min-h-0 flex-col rounded-xl border border-edge bg-surface"
            onPaste={onPanelPaste}
            onDrop={onPanelDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            <div ref={threadRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 && (
                <div className="py-14 text-center text-sm text-muted">
                  <Target size={28} className="mx-auto mb-3 opacity-50" />
                  <p className="font-medium text-ink">Pick a direction and timeframe, then “Find the trade”.</p>
                  <p className="mx-auto mt-1.5 max-w-md">
                    I scan every options chain on your watchlist through your Webull OpenAPI, weigh earnings, news and
                    momentum, and pick the contract with the best shot at your move — then you can grill me about it.
                  </p>
                </div>
              )}
              {messages.map((m, i) => {
                if (m.kind === 'user')
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-ink">
                        {m.images && m.images.length > 0 && (
                          <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {m.images.map((src, j) => (
                              <img key={j} src={src} alt="pasted screenshot" className="max-h-44 rounded-lg" />
                            ))}
                          </div>
                        )}
                        {m.text}
                      </div>
                    </div>
                  )
                if (m.kind === 'working')
                  return (
                    <div key={i} className="flex">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-edge bg-raised px-3.5 py-2.5">
                        <p className="flex items-center gap-2 text-xs font-semibold text-muted">
                          <Loader2 size={13} className="animate-spin" /> Working…
                        </p>
                        <div className="mt-1.5 space-y-0.5">
                          {m.lines.slice(-6).map((l, j) => (
                            <p key={j} className="text-xs text-muted">
                              {l}
                            </p>
                          ))}
                        </div>
                      </div>
                    </div>
                  )
                if (m.kind === 'error')
                  return (
                    <div key={i} className="flex">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-danger/40 bg-danger/10 px-3.5 py-2 text-sm text-danger">
                        {m.text}
                      </div>
                    </div>
                  )
                if (m.kind === 'result') return <ResultCard key={i} r={m.result} />
                return (
                  <div key={i} className="flex">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-edge bg-raised px-3.5 py-2 text-sm">
                      <span className="whitespace-pre-wrap">{m.text}</span>
                      {m.provider && <p className="mt-1.5 text-right text-[10px] text-muted">via {m.provider}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="border-t border-edge p-3">
              {pendingImgs.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingImgs.map((src, i) => (
                    <span key={i} className="relative">
                      <img src={src} alt="attached screenshot" className="h-14 w-14 rounded-lg border border-edge object-cover" />
                      <button
                        onClick={() => setPendingImgs((cur) => cur.filter((_, j) => j !== i))}
                        title="Remove"
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-white"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) void sendChat()
                  }}
                  placeholder="Ask about the pick, a ticker, liquidity, exits… (paste a screenshot with Ctrl+V)"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => void sendChat()}
                  disabled={chatBusy || (!chatInput.trim() && pendingImgs.length === 0)}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
                >
                  {chatBusy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                </button>
              </div>
              <p className="mt-1.5 text-center text-[10px] text-muted">
                {status?.aiProvider ? `AI: ${status.aiProvider} · ` : ''}Analysis, not financial advice — options can go
                to zero. Quotes via your Webull OpenAPI.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------ result card ------------------------------- */

function ResultCard({ r }: { r: ScanResultMsg }): React.JSX.Element {
  const up = r.direction === 'up'
  return (
    <div className="flex">
      <div className="w-full max-w-[92%] rounded-2xl rounded-bl-md border border-edge bg-raised p-4">
        {r.summary && <p className="text-sm text-muted">{r.summary}</p>}

        {r.best ? (
          <div className="mt-3 rounded-xl border border-accent/50 bg-surface p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${up ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger'}`}>
                  {up ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
                </span>
                <div>
                  <p className="text-base font-bold leading-tight">{r.best.ticker}</p>
                  <p className="text-xs text-muted">{r.best.label || r.best.option_symbol}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Confidence</p>
                <p className={`text-lg font-bold ${r.best.confidence >= 65 ? 'text-ok' : r.best.confidence >= 45 ? 'text-warn' : 'text-danger'}`}>
                  {r.best.confidence}
                </p>
              </div>
            </div>
            {r.best.contract && (
              <div className="mt-2.5 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">
                <Chip label="Expiry" value={String(r.best.contract.expiry ?? '—')} />
                <Chip label="Strike" value={r.best.contract.strike != null ? `$${r.best.contract.strike}` : '—'} />
                <Chip label="Mid" value={money(r.best.contract.mid)} />
                <Chip
                  label="Per contract"
                  value={r.best.contract.est_cost_per_contract != null ? `$${r.best.contract.est_cost_per_contract}` : '—'}
                />
              </div>
            )}
            {r.best.why.length > 0 && (
              <ul className="mt-2.5 space-y-1">
                {r.best.why.map((w, i) => (
                  <li key={i} className="flex gap-1.5 text-xs">
                    <CircleDot size={12} className="mt-0.5 shrink-0 text-ok" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            {r.best.risks.length > 0 && (
              <ul className="mt-2 space-y-1">
                {r.best.risks.map((w, i) => (
                  <li key={i} className="flex gap-1.5 text-xs text-muted">
                    <CircleDot size={12} className="mt-0.5 shrink-0 text-danger" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
            {r.best.entry && <p className="mt-2.5 rounded-lg bg-raised px-2.5 py-1.5 text-xs font-medium">{r.best.entry}</p>}
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-warn/50 bg-warn/10 p-3 text-sm text-warn">
            No trade worth taking in this window — see the read above.
          </p>
        )}

        {r.runners_up.length > 0 && (
          <div className="mt-2.5 space-y-1.5">
            {r.runners_up.map((ru, i) => (
              <div key={i} className="rounded-lg border border-edge bg-surface px-3 py-2 text-xs">
                <span className="font-semibold">{ru.ticker}</span> — {ru.label || ru.option_symbol}
                {ru.contract?.mid != null && <span className="text-muted"> · mid {money(ru.contract.mid)}</span>}
                {ru.note && <p className="mt-0.5 text-muted">{ru.note}</p>}
              </div>
            ))}
          </div>
        )}

        {r.avoided.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {r.avoided.map((a, i) => (
              <span key={i} title={a.reason} className="flex items-center gap-1 rounded-full border border-edge px-2 py-0.5 text-[11px] text-muted">
                <Trash2 size={10} /> {a.ticker}
              </span>
            ))}
          </div>
        )}
        {r.provider && <p className="mt-2 text-right text-[10px] text-muted">via {r.provider}</p>}
      </div>
    </div>
  )
}

function Chip({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-lg bg-raised px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="font-semibold">{value}</p>
    </div>
  )
}

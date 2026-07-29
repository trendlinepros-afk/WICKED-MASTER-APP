import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Loader2,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  User,
  Wrench,
  X
} from 'lucide-react'
import { AI_ADVISOR_EVENT, type AdvisorEvent, type ChatMessage, type ChatMeta, type ToolTrace } from './types'
import { useAdvisor, type LiveTool } from './store'
import { ChartBlock } from './chart'

/* -------------------------------- helpers -------------------------------- */

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const mdCls =
  'leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 ' +
  '[&_code]:rounded [&_code]:bg-raised [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg ' +
  '[&_pre]:bg-raised [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-accent [&_a]:underline [&_strong]:font-semibold ' +
  '[&_h1]:mt-3 [&_h1]:text-[1.2em] [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-[1.08em] [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-semibold ' +
  '[&_table]:my-2 [&_table]:w-full [&_th]:border [&_th]:border-edge [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-edge [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-edge [&_blockquote]:pl-3 [&_blockquote]:text-muted'

/** Render assistant text as markdown, rendering any ```wicked-chart``` blocks as charts. */
const CHART_RE = /```wicked-chart\s*\n?([\s\S]*?)```/g
function renderRich(text: string): React.ReactNode {
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  CHART_RE.lastIndex = 0
  while ((m = CHART_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index)
    if (before.trim())
      out.push(
        <div key={key++} className={mdCls}>
          <Markdown remarkPlugins={[remarkGfm]}>{before}</Markdown>
        </div>
      )
    let spec: Record<string, unknown> | null = null
    try {
      spec = JSON.parse(m[1].trim()) as Record<string, unknown>
    } catch {
      spec = null
    }
    if (spec) out.push(<ChartBlock key={key++} spec={spec} />)
    else
      out.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-lg bg-raised p-2 text-[10px] text-muted">
          {m[1].trim()}
        </pre>
      )
    last = m.index + m[0].length
  }
  const rest = text.slice(last)
  if (rest.trim() || out.length === 0)
    out.push(
      <div key={key++} className={mdCls}>
        <Markdown remarkPlugins={[remarkGfm]}>{rest}</Markdown>
      </div>
    )
  return <>{out}</>
}

function ToolChip({ label, status }: { label: string; status: string }): React.JSX.Element {
  const icon =
    status === 'start' ? (
      <Loader2 size={11} className="animate-spin" />
    ) : status === 'declined' ? (
      <DollarSign size={11} />
    ) : status === 'error' ? (
      <AlertTriangle size={11} />
    ) : (
      <Check size={11} />
    )
  const tone =
    status === 'error' ? 'text-danger' : status === 'declined' ? 'text-warn' : status === 'start' ? 'text-muted' : 'text-ok'
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-edge bg-surface px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      <Wrench size={10} className="text-muted" /> {label} <span className={tone}>{icon}</span>
    </span>
  )
}

function ToolStrip({ tools }: { tools: ToolTrace[] | LiveTool[] }): React.JSX.Element | null {
  if (!tools.length) return null
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {tools.map((t, i) => (
        <ToolChip key={`${t.name}-${i}`} label={t.label} status={t.status} />
      ))}
    </div>
  )
}

function Bubble({ msg }: { msg: ChatMessage }): React.JSX.Element {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Bot size={16} />
        </div>
      )}
      <div className={`min-w-0 max-w-[85%] ${isUser ? 'order-1' : ''}`}>
        {!isUser && msg.tools && msg.tools.length > 0 && <ToolStrip tools={msg.tools} />}
        <div
          className={
            isUser
              ? 'rounded-2xl rounded-tr-sm bg-accent px-3.5 py-2 text-accent-ink whitespace-pre-wrap'
              : 'rounded-2xl rounded-tl-sm border border-edge bg-surface px-3.5 py-2'
          }
        >
          {isUser ? msg.text : renderRich(msg.text)}
        </div>
      </div>
      {isUser && (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          <User size={15} />
        </div>
      )}
    </div>
  )
}

/* --------------------------------- screen -------------------------------- */

export default function AiAdvisor(): React.JSX.Element {
  const s = useAdvisor()
  const endRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const [paneW, setPaneW] = useState(900)
  const [showArchived, setShowArchived] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  useEffect(() => {
    void s.init()
    const off = window.wicked.on(AI_ADVISOR_EVENT, (raw) => s.handleEvent(raw as AdvisorEvent))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [s.convo?.messages.length, s.liveText, s.liveTools.length, s.xGate])

  // Scale chat text + column width with the available space so it isn't tiny on a big screen.
  useEffect(() => {
    const el = mainRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPaneW(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void s.send()
    }
  }

  const messages = s.convo?.messages ?? []
  const showLive = s.streaming || s.liveText || s.liveTools.length > 0 || s.xGate

  const fontPx = Math.round(Math.max(14, Math.min(20, paneW / 62)))
  const colMax = Math.round(Math.max(720, Math.min(1180, paneW * 0.84)))
  const active = s.metas.filter((m) => !m.archived)
  const archived = s.metas.filter((m) => m.archived)

  const commitRename = async (id: string): Promise<void> => {
    const t = renameText.trim()
    setRenamingId(null)
    if (t) await s.rename(id, t)
  }

  const row = (m: ChatMeta, isArchived: boolean): React.JSX.Element => (
    <div
      key={m.id}
      className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 ${m.id === s.currentId ? 'bg-raised' : 'hover:bg-raised/50'}`}
    >
      {renamingId === m.id ? (
        <input
          autoFocus
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename(m.id)
            else if (e.key === 'Escape') setRenamingId(null)
          }}
          onBlur={() => void commitRename(m.id)}
          className="min-w-0 flex-1 rounded border border-edge bg-bg px-1.5 py-1 text-sm outline-none focus:border-accent"
        />
      ) : (
        <button onClick={() => void s.select(m.id)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm">{m.title || 'Untitled'}</div>
          <div className="text-[10px] text-muted">
            {ago(m.updatedAt)}
            {m.count ? ` · ${m.count} msg` : ''}
          </div>
        </button>
      )}
      {renamingId !== m.id && (
        <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
          <button
            onClick={() => {
              setRenamingId(m.id)
              setRenameText(m.title)
            }}
            title="Rename"
            className="rounded p-1 text-muted hover:bg-edge/60 hover:text-ink"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={() => void s.archive(m.id, !isArchived)}
            title={isArchived ? 'Unarchive' : 'Archive'}
            className="rounded p-1 text-muted hover:bg-edge/60 hover:text-ink"
          >
            {isArchived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
          </button>
          <button
            onClick={() => {
              if (window.confirm('Delete this chat permanently? This cannot be undone.')) void s.remove(m.id)
            }}
            title="Delete permanently"
            className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full">
      {/* conversation rail */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-edge bg-surface">
        <div className="border-b border-edge p-3">
          <button
            onClick={() => void s.newChat()}
            disabled={s.streaming}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-40"
          >
            <Plus size={15} /> New chat
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {active.length === 0 && archived.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">No conversations yet.</p>
          ) : (
            <>
              {active.map((m) => row(m, false))}
              {archived.length > 0 && (
                <div className="mt-2 border-t border-edge pt-2">
                  <button
                    onClick={() => setShowArchived((v) => !v)}
                    className="flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted hover:text-ink"
                  >
                    {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Archived ({archived.length})
                  </button>
                  {showArchived && <div className="mt-1">{archived.map((m) => row(m, true))}</div>}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* chat */}
      <main ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
          <Bot size={18} className="text-accent" />
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight">AI Advisor</h1>
            <p className="truncate text-[11px] text-muted">
              Reads your Stocks tools · {s.toolCount} tools · {s.model || 'Claude'}
            </p>
          </div>
        </header>

        {!s.hasKey && (
          <div className="flex items-center gap-2 border-b border-edge bg-warn/10 px-4 py-2 text-xs text-warn">
            <AlertTriangle size={14} /> Add an <strong>Anthropic</strong> API key in Settings → API Keys to use the AI Advisor.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto space-y-4 p-4" style={{ maxWidth: colMax, fontSize: fontPx }}>
            {messages.length === 0 && !showLive && (
              <div className="mt-10 text-center text-muted">
                <Bot size={40} strokeWidth={1.5} className="mx-auto opacity-40" />
                <p className="mt-3 text-sm font-medium text-ink">Ask about your trading</p>
                <p className="mx-auto mt-1 max-w-md text-xs">
                  I can read your Trade Journal, Trade Log, screens, live quotes, candles and market news to reason about your
                  positions and ideas. Try “How did my NVDA trades do this month?” or “Is there news moving my watchlist?”
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <Bubble key={i} msg={m} />
            ))}

            {/* live streaming bubble */}
            {showLive && (
              <div className="flex gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                  <Bot size={16} />
                </div>
                <div className="min-w-0 max-w-[85%]">
                  <ToolStrip tools={s.liveTools} />
                  {s.xGate ? (
                    <div className="rounded-2xl rounded-tl-sm border border-warn/40 bg-warn/10 px-3.5 py-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-warn">
                        <DollarSign size={15} /> Use the X API?
                      </div>
                      <p className="mt-1 text-xs text-ink">
                        The advisor wants to run <strong>{s.xGate.label}</strong>. Using the X API costs real money (per-use
                        billing). Is that OK?
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => void s.respondX(true)}
                          className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90"
                        >
                          <Check size={13} /> Yes, use it
                        </button>
                        <button
                          onClick={() => void s.respondX(false)}
                          className="flex items-center gap-1 rounded-lg bg-raised px-3 py-1.5 text-xs font-medium hover:bg-edge/60"
                        >
                          <X size={13} /> No
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-2xl rounded-tl-sm border border-edge bg-surface px-3.5 py-2">
                      {s.liveText ? (
                        renderRich(s.liveText)
                      ) : (
                        <span className="flex items-center gap-2 text-sm text-muted">
                          <Loader2 size={14} className="animate-spin" /> Thinking…
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {s.error && (
              <div className="rounded-lg bg-danger/10 p-2.5 text-xs text-danger">{s.error}</div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        {/* composer */}
        <div className="border-t border-edge bg-surface p-3">
          <div className="mx-auto flex items-end gap-2" style={{ maxWidth: colMax }}>
            <textarea
              ref={taRef}
              value={s.input}
              onChange={(e) => s.setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              disabled={!s.hasKey}
              style={{ fontSize: fontPx }}
              placeholder={s.hasKey ? 'Ask about your trades, a ticker, the market…' : 'Add an Anthropic key to start'}
              className="max-h-40 min-h-[46px] flex-1 resize-none rounded-xl border border-edge bg-raised px-3 py-2.5 outline-none focus:border-accent disabled:opacity-50"
            />
            {s.streaming ? (
              <button
                onClick={() => s.stop()}
                title="Stop"
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-raised text-ink hover:bg-edge/60"
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                onClick={() => void s.send()}
                disabled={!s.input.trim() || !s.hasKey}
                title="Send"
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-accent text-accent-ink hover:opacity-90 disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <div className="mx-auto mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted" style={{ maxWidth: colMax }}>
            <span className="min-w-0 truncate">
              The advisor reads your Stocks data; it can’t place trades. X-API calls ask first (they cost money).
            </span>
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-edge bg-raised px-2 py-0.5 font-medium"
              title="The AI model answering in this chat"
            >
              <Bot size={10} /> {s.model || 'Claude'}
            </span>
          </div>
        </div>
      </main>
    </div>
  )
}

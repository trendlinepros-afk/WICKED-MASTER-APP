import { useEffect, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Bot,
  Check,
  DollarSign,
  Loader2,
  Plus,
  Send,
  Square,
  Trash2,
  User,
  Wrench,
  X
} from 'lucide-react'
import { AI_ADVISOR_EVENT, type AdvisorEvent, type ChatMessage, type ToolTrace } from './types'
import { useAdvisor, type LiveTool } from './store'

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
  'text-sm leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 ' +
  '[&_code]:rounded [&_code]:bg-raised [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg ' +
  '[&_pre]:bg-raised [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-accent [&_a]:underline [&_strong]:font-semibold ' +
  '[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-bold [&_h3]:mt-2 [&_h3]:font-semibold ' +
  '[&_table]:my-2 [&_table]:w-full [&_th]:border [&_th]:border-edge [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-edge [&_td]:px-2 [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-edge [&_blockquote]:pl-3 [&_blockquote]:text-muted'

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
              ? 'rounded-2xl rounded-tr-sm bg-accent px-3.5 py-2 text-sm text-accent-ink whitespace-pre-wrap'
              : 'rounded-2xl rounded-tl-sm border border-edge bg-surface px-3.5 py-2'
          }
        >
          {isUser ? (
            msg.text
          ) : (
            <div className={mdCls}>
              <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
            </div>
          )}
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

  useEffect(() => {
    void s.init()
    const off = window.wicked.on(AI_ADVISOR_EVENT, (raw) => s.handleEvent(raw as AdvisorEvent))
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [s.convo?.messages.length, s.liveText, s.liveTools.length, s.xGate])

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void s.send()
    }
  }

  const messages = s.convo?.messages ?? []
  const showLive = s.streaming || s.liveText || s.liveTools.length > 0 || s.xGate

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
          {s.metas.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">No conversations yet.</p>
          ) : (
            s.metas.map((m) => (
              <div
                key={m.id}
                className={`group flex items-center gap-1 rounded-lg px-2 py-2 ${m.id === s.currentId ? 'bg-raised' : 'hover:bg-raised/50'}`}
              >
                <button onClick={() => void s.select(m.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm">{m.title || 'Untitled'}</div>
                  <div className="text-[10px] text-muted">{ago(m.updatedAt)}</div>
                </button>
                <button
                  onClick={() => void s.remove(m.id)}
                  title="Delete chat"
                  className="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* chat */}
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
          <Bot size={18} className="text-accent" />
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight">AI Advisor</h1>
            <p className="truncate text-[11px] text-muted">
              Reads your Stocks tools · {s.toolCount} tools · Claude
            </p>
          </div>
        </header>

        {!s.hasKey && (
          <div className="flex items-center gap-2 border-b border-edge bg-warn/10 px-4 py-2 text-xs text-warn">
            <AlertTriangle size={14} /> Add an <strong>Anthropic</strong> API key in Settings → API Keys to use the AI Advisor.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-4 p-4">
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
                        <div className={mdCls}>
                          <Markdown remarkPlugins={[remarkGfm]}>{s.liveText}</Markdown>
                        </div>
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
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref={taRef}
              value={s.input}
              onChange={(e) => s.setInput(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              disabled={!s.hasKey}
              placeholder={s.hasKey ? 'Ask about your trades, a ticker, the market…' : 'Add an Anthropic key to start'}
              className="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border border-edge bg-raised px-3 py-2.5 text-sm outline-none focus:border-accent disabled:opacity-50"
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
          <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10px] text-muted">
            The advisor reads your Stocks data; it can’t place trades. Verify before acting. X-API calls ask first (they cost money).
          </p>
        </div>
      </main>
    </div>
  )
}

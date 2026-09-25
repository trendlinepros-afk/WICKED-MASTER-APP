import { Fragment, useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, MessageSquare, RotateCcw, Sparkles, Square } from 'lucide-react'
import { useTrades, type ChatMessage } from '../store'
import { CHAT_SUGGESTIONS, CHAT_TRADE_LIMIT } from '../lib/chat-context'

/* ------------------------- minimal markdown (safe) ------------------------ */

/** **bold**, *italic* and `code` inside one line — rendered as elements, never HTML. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) out.push(<strong key={k++} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) out.push(<code key={k++} className="rounded bg-raised px-1 font-mono text-[12px]">{tok.slice(1, -1)}</code>)
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = (): void => {
    if (!list) return
    const Tag = list.ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={blocks.length} className={`my-1 space-y-0.5 pl-5 ${list.ordered ? 'list-decimal' : 'list-disc'}`}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>
    )
    list = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? numbered)![1])
      continue
    }
    flush()
    if (!line.trim()) blocks.push(<div key={blocks.length} className="h-2" />)
    else if (heading) blocks.push(<div key={blocks.length} className="mt-1 font-semibold text-ink">{inline(heading[1])}</div>)
    else if (/^-{3,}$/.test(line.trim())) blocks.push(<hr key={blocks.length} className="my-2 border-edge" />)
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>)
  }
  flush()
  return <Fragment>{blocks}</Fragment>
}

/* --------------------------------- panel --------------------------------- */

function Bubble({ m }: { m: ChatMessage }): React.JSX.Element {
  if (m.role === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-ink">{m.content}</div>
      </div>
    )
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Sparkles size={12} />
      </div>
      <div className="min-w-0 max-w-[90%] rounded-2xl rounded-tl-md border border-edge bg-raised/50 px-3.5 py-2 text-sm leading-relaxed text-ink">
        {m.content ? <Markdown text={m.content} /> : m.pending ? <Loader2 size={14} className="my-1 animate-spin text-muted" /> : null}
        {m.pending && m.content && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
        {m.error && <div className={`mt-1 text-xs ${m.error === 'Stopped.' ? 'text-muted' : 'text-danger'}`}>{m.error}</div>}
      </div>
    </div>
  )
}

export default function ChatPanel(): React.JSX.Element {
  const chat = useTrades((s) => s.chat)
  const busy = useTrades((s) => s.chatBusy)
  const stats = useTrades((s) => s.stats)
  const hasAiKey = useTrades((s) => s.hasAiKey)
  const rangeLabel = useTrades((s) => s.rangeLabel)
  const sendChat = useTrades((s) => s.sendChat)
  const stopChat = useTrades((s) => s.stopChat)
  const clearChat = useTrades((s) => s.clearChat)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  const closed = stats?.closedTrades ?? 0
  const ready = hasAiKey && closed > 0

  // follow the conversation as it streams
  const lastLen = chat.length ? chat[chat.length - 1].content.length : 0
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, lastLen])

  // auto-grow the input up to ~6 lines
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`
  }, [draft])

  const send = (text: string): void => {
    if (!text.trim() || busy || !ready) return
    setDraft('')
    void sendChat(text)
  }

  return (
    <div className="flex min-h-[420px] min-w-0 flex-1 flex-col rounded-xl border border-edge bg-surface xl:min-h-0">
      <div className="flex items-center gap-2 border-b border-edge px-3.5 py-2.5">
        <MessageSquare size={15} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Chat with your coach</div>
          <div className="truncate text-[11px] text-muted">
            Sees {closed.toLocaleString()} closed trade{closed === 1 ? '' : 's'}
            {closed > CHAT_TRADE_LIMIT ? ` (latest ${CHAT_TRADE_LIMIT} in detail)` : ''} · {rangeLabel || 'lifetime'} · follows the accounts & dates you’re viewing
          </div>
        </div>
        {chat.length > 0 && (
          <button
            onClick={clearChat}
            disabled={busy}
            title="Start a new conversation"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            <RotateCcw size={12} /> New chat
          </button>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3.5">
        {chat.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Sparkles size={20} className="text-accent" />
            <p className="max-w-xs text-sm text-muted">
              {!hasAiKey
                ? 'Add an AI key in Settings → API Keys to chat with your coach.'
                : closed === 0
                  ? 'Import some closed trades first — the coach answers from your own trade history.'
                  : 'Ask anything about your trading. The coach can see every trade, your stats, strategy and journal notes.'}
            </p>
            {ready && (
              <div className="flex max-w-md flex-wrap justify-center gap-1.5">
                {CHAT_SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="rounded-full border border-edge bg-raised/60 px-3 py-1 text-xs text-ink hover:border-accent hover:text-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          chat.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>

      <div className="border-t border-edge p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-edge bg-raised px-3 py-2 focus-within:border-accent">
          <textarea
            ref={box}
            rows={1}
            value={draft}
            disabled={!ready}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(draft)
              }
            }}
            placeholder={ready ? 'Ask about your trades…  (Enter to send, Shift+Enter for a new line)' : 'Chat unavailable'}
            className="max-h-[150px] min-h-[22px] flex-1 resize-none bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-muted/60 disabled:opacity-50"
          />
          {busy ? (
            <button onClick={() => void stopChat()} title="Stop" className="rounded-lg bg-edge p-1.5 text-ink hover:opacity-80">
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={() => send(draft)}
              disabled={!draft.trim() || !ready}
              title="Send"
              className="rounded-lg bg-accent p-1.5 text-accent-ink hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-muted">
          Your trade data is sent to your AI provider with each message. The chat isn’t saved — it clears when you close WICKED.
        </p>
      </div>
    </div>
  )
}

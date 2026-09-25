import { Fragment, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronDown, Download, FileText, History, Loader2, MessageSquare, Play, Plus, Sparkles, Square, Trash2 } from 'lucide-react'
import { CONTINUE_PROMPT, useTrades, type ChatMessage, type ChatSummary } from '../store'
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

function Bubble({ m, last, onContinue }: { m: ChatMessage; last: boolean; onContinue: () => void }): React.JSX.Element {
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
      <div className="min-w-0 max-w-[92%] rounded-2xl rounded-tl-md border border-edge bg-raised/50 px-3.5 py-2 text-sm leading-relaxed text-ink">
        {m.content ? <Markdown text={m.content} /> : m.pending ? <Loader2 size={14} className="my-1 animate-spin text-muted" /> : null}
        {m.pending && m.content && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
        {m.error && <div className={`mt-1 text-xs ${m.error === 'Stopped.' ? 'text-muted' : 'text-danger'}`}>{m.error}</div>}
        {(m.truncated || (m.error && m.content)) && !m.pending && (
          <div className="mt-2 flex items-center gap-2 border-t border-edge pt-2 text-xs text-muted">
            <span>{m.truncated ? 'This reply hit the length limit.' : 'This reply didn’t finish.'}</span>
            {last && (
              <button onClick={onContinue} className="flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 font-medium text-accent hover:bg-accent/25">
                <Play size={11} /> Continue
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Saved conversations — click one to pick it back up. */
function HistoryRail(): React.JSX.Element {
  const chats = useTrades((s) => s.chats)
  const activeId = useTrades((s) => s.activeChatId)
  const busy = useTrades((s) => s.chatBusy)
  const openChat = useTrades((s) => s.openChat)
  const deleteChat = useTrades((s) => s.deleteChat)
  const clearChat = useTrades((s) => s.clearChat)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  return (
    <div className="flex w-52 shrink-0 flex-col border-r border-edge">
      <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2.5">
        <History size={13} className="text-muted" />
        <span className="flex-1 text-xs font-semibold text-ink">Chats</span>
        <button
          onClick={clearChat}
          disabled={busy}
          title="New chat"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink disabled:opacity-40"
        >
          <Plus size={12} /> New
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {chats.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-muted">Your conversations are saved here — click one to pick it back up.</p>
        ) : (
          chats.map((c: ChatSummary) => {
            const active = c.id === activeId
            return (
              <div
                key={c.id}
                onClick={() => !busy && void openChat(c.id)}
                title={`${c.title}\n${c.scope}`}
                className={`group relative cursor-pointer rounded-lg px-2.5 py-2 ${active ? 'bg-accent/15' : 'hover:bg-raised'} ${busy && !active ? 'opacity-50' : ''}`}
              >
                <div className={`line-clamp-2 pr-4 text-xs leading-snug ${active ? 'font-medium text-ink' : 'text-ink/90'}`}>{c.title}</div>
                <div className="mt-0.5 truncate text-[10px] text-muted">
                  {ago(c.updatedAt)} · {Math.ceil(c.count / 2)} msg{Math.ceil(c.count / 2) === 1 ? '' : 's'}
                </div>
                {confirmId === c.id ? (
                  <div className="mt-1 flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => void deleteChat(c.id).then(() => setConfirmId(null))} className="rounded bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      Delete
                    </button>
                    <button onClick={() => setConfirmId(null)} className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmId(c.id)
                    }}
                    disabled={busy && active}
                    title="Delete chat"
                    className="absolute right-1.5 top-2 rounded p-0.5 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function ExportMenu({ disabled }: { disabled: boolean }): React.JSX.Element {
  const exportChat = useTrades((s) => s.exportChat)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = async (format: 'pdf' | 'md'): Promise<void> => {
    setOpen(false)
    setBusy(true)
    setErr('')
    const e = await exportChat(format)
    setBusy(false)
    if (e) setErr(e)
  }
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
        title={err || 'Export this conversation'}
        className={`flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs hover:bg-raised disabled:opacity-40 ${err ? 'text-danger' : 'text-ink'}`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Export chat <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-edge bg-surface p-1 shadow-xl">
            <button onClick={() => void run('pdf')} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-ink hover:bg-raised">
              <FileText size={13} /> PDF document
            </button>
            <button onClick={() => void run('md')} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-ink hover:bg-raised">
              <FileText size={13} /> Markdown (.md)
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function ChatPanel(): React.JSX.Element {
  const chat = useTrades((s) => s.chat)
  const busy = useTrades((s) => s.chatBusy)
  const stats = useTrades((s) => s.stats)
  const hasAiKey = useTrades((s) => s.hasAiKey)
  const rangeLabel = useTrades((s) => s.rangeLabel)
  const title = useTrades((s) => s.activeChatTitle)
  const sendChat = useTrades((s) => s.sendChat)
  const stopChat = useTrades((s) => s.stopChat)
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
    <div className="flex min-h-[460px] min-w-0 flex-1 overflow-hidden rounded-xl border border-edge bg-surface xl:min-h-0">
      <HistoryRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-edge px-3.5 py-2.5">
          <MessageSquare size={15} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">{title || 'Chat with your coach'}</div>
            <div className="truncate text-[11px] text-muted">
              Sees {closed.toLocaleString()} closed trade{closed === 1 ? '' : 's'}
              {closed > CHAT_TRADE_LIMIT ? ` (latest ${CHAT_TRADE_LIMIT} in detail)` : ''} · {rangeLabel || 'lifetime'} · follows the accounts & dates you’re viewing
            </div>
          </div>
          <ExportMenu disabled={busy || chat.filter((m) => !m.pending).length === 0} />
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
            chat.map((m, i) => <Bubble key={m.id} m={m} last={i === chat.length - 1 && !busy} onContinue={() => send(CONTINUE_PROMPT)} />)
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
            Chats are saved on this PC with your journal. Your trade data is sent to your AI provider with each message.
          </p>
        </div>
      </div>
    </div>
  )
}

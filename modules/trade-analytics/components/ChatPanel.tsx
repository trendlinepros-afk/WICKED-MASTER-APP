import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUp, BarChart3, ChevronDown, Download, ExternalLink, FileText, FolderOpen, History, Loader2, MessageSquare, Play, Plus, Sparkles, Square, Trash2 } from 'lucide-react'
import { CONTINUE_PROMPT, useTrades, type ChatMessage, type ChatSummary } from '../store'
import { CHAT_SUGGESTIONS, CHAT_TRADE_LIMIT } from '../lib/chat-context'
import { calloutTone, inlineTokens, parseRich, pdfDirective, plainText, toneRuns, visibleText, type Block } from '../lib/rich-text'
import { chartFromBlock, chartSvg, SCREEN_PALETTE, type ChartInputs } from '../lib/chat-charts'

/* ------------------------- rich reply rendering (safe) ------------------------ */

/** Signed money / points / percents coloured; never renders HTML from the model. */
function toned(text: string, key: string): React.ReactNode[] {
  return toneRuns(text).map((r, i) =>
    r.tone ? (
      <span key={`${key}-${i}`} className={`font-semibold ${r.tone === 'pos' ? 'text-ok' : 'text-danger'}`}>
        {r.s}
      </span>
    ) : (
      <Fragment key={`${key}-${i}`}>{r.s}</Fragment>
    )
  )
}

/** **bold**, *italic* and `code` inside one line — rendered as elements. */
function inline(text: string): React.ReactNode[] {
  return inlineTokens(text).map((t, i) =>
    t.t === 'b' ? (
      <strong key={i} className="font-semibold text-ink">
        {toned(t.s, `b${i}`)}
      </strong>
    ) : t.t === 'i' ? (
      <em key={i}>{toned(t.s, `i${i}`)}</em>
    ) : t.t === 'code' ? (
      <code key={i} className="rounded bg-raised px-1 font-mono text-[12px]">
        {t.s}
      </code>
    ) : (
      <Fragment key={i}>{toned(t.s, `t${i}`)}</Fragment>
    )
  )
}

const CALLOUT: Record<'good' | 'bad' | 'warn', string> = {
  good: 'border-l-ok bg-ok/10',
  bad: 'border-l-danger bg-danger/10',
  warn: 'border-l-warn bg-warn/10'
}

function ChartBlock({ raw, closed, inputs }: { raw: string; closed: boolean; inputs: ChartInputs | null }): React.JSX.Element {
  const data = useMemo(() => (closed ? chartFromBlock(raw, inputs) : null), [raw, closed, inputs])
  const svg = useMemo(() => (data && !('error' in data) && data.type !== 'stats' ? chartSvg(data, SCREEN_PALETTE, 680) : ''), [data])
  if (!closed)
    return (
      <div className="my-2 flex items-center gap-2 rounded-xl border border-dashed border-edge px-3 py-4 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" /> Drawing a chart…
      </div>
    )
  if (!data || 'error' in data)
    return (
      <div className="my-2 flex items-center gap-1.5 text-[11px] italic text-muted">
        <BarChart3 size={12} /> Chart unavailable{data && 'error' in data ? ` — ${data.error}` : ''}
      </div>
    )
  return (
    <figure className="my-2.5 rounded-xl border border-edge bg-surface/70 p-3">
      {(data.title || data.subtitle) && (
        <figcaption className="mb-1.5">
          {data.title && <div className="text-xs font-semibold text-ink">{data.title}</div>}
          {data.subtitle && <div className="text-[11px] text-muted">{data.subtitle}</div>}
        </figcaption>
      )}
      {data.type === 'stats' ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {data.items.map((it, i) => (
            <div key={i} className={`rounded-lg border border-edge border-t-4 bg-raised/50 px-2.5 py-2 ${it.tone === 'good' ? 'border-t-ok' : it.tone === 'bad' ? 'border-t-danger' : 'border-t-edge'}`}>
              <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted">{it.label}</div>
              <div className={`mt-0.5 truncate text-base font-bold tabular-nums ${it.tone === 'good' ? 'text-ok' : it.tone === 'bad' ? 'text-danger' : 'text-ink'}`}>{it.value}</div>
              {it.sub && <div className="truncate text-[10px] text-muted">{it.sub}</div>}
            </div>
          ))}
        </div>
      ) : (
        // our own SVG — every string in it is escaped by chartSvg
        <div className="w-full max-w-[760px] text-ink" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </figure>
  )
}

function RichBlock({ b, inputs }: { b: Block; inputs: ChartInputs | null }): React.JSX.Element | null {
  switch (b.kind) {
    case 'h':
      return <div className={`mt-2 font-semibold text-ink ${b.level <= 2 ? 'border-l-2 border-accent pl-2 text-[15px]' : 'text-sm'}`}>{inline(b.text)}</div>
    case 'p': {
      const tone = calloutTone(b.text)
      return tone ? <p className={`my-1 rounded-r-lg border-l-4 px-3 py-1.5 ${CALLOUT[tone]}`}>{inline(b.text)}</p> : <p>{inline(b.text)}</p>
    }
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul'
      return (
        <Tag className={`my-1 space-y-1 pl-5 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
          {b.items.map((it, i) => {
            const tone = calloutTone(it)
            return (
              <li key={i} className={tone ? `-ml-5 list-none rounded-r-lg border-l-4 px-3 py-1.5 ${CALLOUT[tone]}` : ''}>
                {inline(it)}
              </li>
            )
          })}
        </Tag>
      )
    }
    case 'table':
      return (
        <div className="my-2 overflow-x-auto rounded-lg border border-edge">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-raised">
                {b.header.map((h, i) => (
                  <th key={i} className={`px-2.5 py-1.5 font-semibold text-ink ${b.align[i] === 'right' ? 'text-right' : b.align[i] === 'center' ? 'text-center' : 'text-left'}`}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri} className="border-t border-edge/70 odd:bg-transparent even:bg-raised/30">
                  {r.map((c, ci) => {
                    const numeric = b.align[ci] === 'right' || /^[+\-−–]?\$?\s?[\d,.]+\s?[%kKmM]?$/.test(plainText(c)) || /^[+\-−–]\$/.test(plainText(c))
                    return (
                      <td key={ci} className={`px-2.5 py-1.5 ${numeric ? 'text-right tabular-nums' : b.align[ci] === 'center' ? 'text-center' : ''}`}>
                        {inline(c)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return <blockquote className="my-1.5 rounded-r-lg border-l-4 border-accent bg-accent/10 px-3 py-1.5">{b.text.split('\n').map((l, i) => <div key={i}>{inline(l)}</div>)}</blockquote>
    case 'hr':
      return <hr className="my-2 border-edge" />
    case 'gap':
      return <div className="h-1.5" />
    case 'chart':
      return <ChartBlock raw={b.raw} closed={b.closed} inputs={inputs} />
    case 'code':
      return <pre className="my-1.5 overflow-x-auto rounded-lg bg-raised p-2 font-mono text-[11.5px]">{b.text}</pre>
  }
}

function RichText({ text, inputs }: { text: string; inputs: ChartInputs | null }): React.JSX.Element {
  const blocks = useMemo(() => parseRich(text), [text])
  return (
    <Fragment>
      {blocks.map((b, i) => (
        <RichBlock key={i} b={b} inputs={inputs} />
      ))}
    </Fragment>
  )
}

/* --------------------------------- panel --------------------------------- */

function PdfCard({ m }: { m: ChatMessage }): React.JSX.Element | null {
  const openPdf = useTrades((s) => s.openPdf)
  const replyPdf = useTrades((s) => s.replyPdf)
  const busyId = useTrades((s) => s.pdfBusyId)
  if (busyId === m.id)
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-ink">
        <Loader2 size={14} className="animate-spin text-accent" /> Making your PDF…
      </div>
    )
  if (m.pdf)
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ink">
        <FileText size={15} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1 truncate font-medium" title={m.pdf.file}>
          {m.pdf.name}
        </span>
        <button onClick={() => void openPdf(m.pdf!.file)} className="flex items-center gap-1 rounded-md bg-ok/20 px-2 py-0.5 font-medium hover:bg-ok/30">
          <ExternalLink size={11} /> Open
        </button>
        <button onClick={() => void openPdf(m.pdf!.file, true)} className="flex items-center gap-1 rounded-md px-2 py-0.5 text-muted hover:text-ink">
          <FolderOpen size={11} /> Show in folder
        </button>
      </div>
    )
  if (m.pdfError)
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-ink">
        <AlertTriangle size={14} className="shrink-0 text-danger" />
        <span className="flex-1">{m.pdfError}</span>
        <button onClick={() => void replyPdf(m.id)} className="rounded-md bg-raised px-2 py-0.5 hover:text-accent">
          Try again
        </button>
      </div>
    )
  return null
}

function Bubble({ m, last, onContinue, inputs }: { m: ChatMessage; last: boolean; onContinue: () => void; inputs: ChartInputs | null }): React.JSX.Element {
  const replyPdf = useTrades((s) => s.replyPdf)
  const busyId = useTrades((s) => s.pdfBusyId)
  const chatBusy = useTrades((s) => s.chatBusy)
  if (m.role === 'user') {
    if (m.kind === 'analysis')
      return (
        <div className="flex justify-end">
          <div className="flex items-center gap-2 rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink">
            <Sparkles size={14} /> {m.display || 'Analyze my trading'}
          </div>
        </div>
      )
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-ink">{m.display || m.content}</div>
      </div>
    )
  }
  const directive = pdfDirective(m.content)
  const shown = visibleText(m.content)
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        <Sparkles size={12} />
      </div>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md border border-edge bg-raised/50 px-3.5 py-2 text-sm leading-relaxed text-ink">
        {directive && (
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
            <FileText size={12} /> PDF report · {directive.title}
            {m.pending && <span className="font-normal normal-case tracking-normal text-muted">— writing it…</span>}
          </div>
        )}
        <PdfCard m={m} />
        {shown ? <RichText text={shown} inputs={inputs} /> : m.pending ? <Loader2 size={14} className="my-1 animate-spin text-muted" /> : null}
        {m.pending && shown && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
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
        {!m.pending && shown.trim() && !m.pdf && (
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => void replyPdf(m.id)}
              disabled={busyId === m.id || chatBusy}
              title="Save this reply (with its charts) as a colour PDF"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              {busyId === m.id ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />} Save as PDF
            </button>
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
              <FileText size={13} /> PDF (charts & colour)
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
  const trades = useTrades((s) => s.trades)
  const metrics = useTrades((s) => s.metrics)
  const inputs = useMemo<ChartInputs | null>(() => (stats ? { stats, trades, metrics } : null), [stats, trades, metrics])
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
                    : 'Click Analyze my trading for a full review with charts — or ask anything. The coach sees every trade, your stats, strategy and journal notes, and can draw charts or make you a PDF.'}
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
            <div className="mx-auto max-w-[980px] space-y-3">
              {chat.map((m, i) => (
                <Bubble key={m.id} m={m} last={i === chat.length - 1 && !busy} onContinue={() => send(CONTINUE_PROMPT)} inputs={inputs} />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-edge p-2.5">
          <div className="mx-auto flex max-w-[980px] items-end gap-2 rounded-xl border border-edge bg-raised px-3 py-2 focus-within:border-accent">
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
          <p className="mx-auto mt-1.5 max-w-[980px] px-1 text-[10px] text-muted">
            Chats are saved on this PC with your journal. Your trade data is sent to your AI provider with each message. Ask for a PDF and the coach makes one (Documents\Stock Trading\Coach reports).
          </p>
        </div>
      </div>
    </div>
  )
}

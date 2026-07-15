import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import type { ChatMode } from '../shared/config'
import { useStore } from '../store'
import { api } from '../lib/bridge'
import { MessageBubble } from './MessageBubble'
import { GeminiAnalysisMessage } from './GeminiAnalysisMessage'

const MODES: { id: ChatMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'Read-only. Plans a solution, makes no edits.' },
  { id: 'ask', label: 'Ask before edits', hint: 'Proposes changes; you approve before they are written.' },
  { id: 'auto', label: 'Full Auto', hint: 'Writes file changes to disk automatically.' }
]

/** Left-side chat interface: message list + input composer. */
export function ChatPanel(): JSX.Element {
  const current = useStore((s) => s.current)
  const isStreaming = useStore((s) => s.isStreaming)
  const sendMessage = useStore((s) => s.sendMessage)
  const stopStreaming = useStore((s) => s.stopStreaming)
  // Chatting requires an active project so generated files have a destination
  // and the AI knows which folder it's working in.
  const project = useStore((s) => s.project)
  const openProject = useStore((s) => s.openProject)
  const setNewProjectOpen = useStore((s) => s.setNewProjectOpen)
  const config = useStore((s) => s.config)
  const setChatMode = useStore((s) => s.setChatMode)
  const pendingEdits = useStore((s) => s.pendingEdits)
  const applyPendingEdits = useStore((s) => s.applyPendingEdits)
  const rejectPendingEdits = useStore((s) => s.rejectPendingEdits)
  const chatMode = config?.chatMode ?? 'ask'
  const recentProjects = config?.recentProjects ?? []

  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messages = current?.messages ?? []
  const lastContent = messages[messages.length - 1]?.content ?? ''

  // Auto-scroll to the bottom when messages change or tokens stream in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, lastContent, isStreaming])

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || isStreaming || !project) return
    void sendMessage(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const newProject = (): void => setNewProjectOpen(true)

  const openFolder = async (): Promise<void> => {
    const dir = await api.pickFolder()
    if (dir) await openProject(dir)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onInput = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex h-full flex-col bg-surface">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {!project ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted">
            <p className="text-sm font-medium text-ink">No project open</p>
            <p className="mt-1 max-w-xs text-xs">
              Create or open a project first so the assistant knows which folder
              to work in and where to write files.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
                onClick={() => void newProject()}
              >
                New Project
              </button>
              <button
                className="rounded-md border border-edge px-4 py-2 text-sm text-ink hover:bg-raised"
                onClick={() => void openFolder()}
              >
                Open Folder
              </button>
            </div>
            {recentProjects.length > 0 && (
              <div className="mt-6 w-full max-w-sm text-left">
                <div className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted">
                  Recent projects
                </div>
                <div className="overflow-hidden rounded-md border border-edge">
                  {recentProjects.map((p) => (
                    <button
                      key={p}
                      onClick={() => void openProject(p)}
                      title={p}
                      className="flex w-full flex-col border-b border-edge px-3 py-2 text-left last:border-b-0 hover:bg-raised"
                    >
                      <span className="truncate text-sm text-ink">
                        {p.split(/[\\/]/).pop() || p}
                      </span>
                      <span className="truncate text-[11px] text-muted">{p}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-muted">
            <p className="text-sm font-medium">Start a conversation</p>
            <p className="mt-1 text-xs">
              Ask a question or describe what you want to build in{' '}
              <span className="font-medium text-ink">{project.name}</span>.
            </p>
          </div>
        ) : (
          messages.map((m) =>
            m.kind === 'gemini-analysis' ? (
              <GeminiAnalysisMessage key={m.id} message={m} />
            ) : (
              <MessageBubble key={m.id} message={m} />
            )
          )
        )}
      </div>

      {/* Pending edits approval bar (Ask mode). */}
      {pendingEdits && (
        <div className="border-t border-warn/40 bg-warn/10 px-3 py-2">
          <div className="mb-1 text-xs font-medium text-warn">
            The assistant proposed {pendingEdits.files.length} file change(s)
            {pendingEdits.commands.length > 0 &&
              ` and ${pendingEdits.commands.length} command(s)`}{' '}
            — review and apply:
          </div>
          <ul className="mb-2 max-h-24 space-y-0.5 overflow-y-auto text-xs text-muted">
            {pendingEdits.files.map((f, i) => (
              <li key={`f-${i}`} className="flex justify-between gap-2">
                <span className="truncate font-mono">{f.path}</span>
                <span className="shrink-0 uppercase">{f.action}</span>
              </li>
            ))}
            {pendingEdits.commands.map((c, i) => (
              <li key={`c-${i}`} className="truncate font-mono text-warn">
                $ {c}
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              className="rounded bg-accent px-3 py-1 text-xs text-accent-ink hover:opacity-90"
              onClick={() => void applyPendingEdits()}
            >
              Apply changes
            </button>
            <button
              className="rounded border border-edge px-3 py-1 text-xs text-ink hover:bg-raised"
              onClick={() => rejectPendingEdits()}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-edge bg-surface p-3">
        <div className="mb-1.5 flex items-center justify-between px-1">
          {/* Mode toggle near the chat bar. */}
          <div className="flex items-center gap-1 rounded-md border border-edge p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => void setChatMode(m.id)}
                className={`rounded px-2 py-0.5 text-xs ${
                  chatMode === m.id
                    ? 'bg-accent text-accent-ink'
                    : 'text-muted hover:bg-raised'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {project && (
            <span className="text-xs text-muted">
              Working in <span className="font-medium text-ink">{project.name}</span>
            </span>
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={onInput}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={!project}
            placeholder={
              project
                ? 'Send a message… (Enter to send, Shift+Enter for newline)'
                : 'Create or open a project to start chatting…'
            }
            className="max-h-40 flex-1 resize-none rounded-md border border-edge bg-raised px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              className="shrink-0 rounded-md border border-danger/40 bg-danger/15 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/25"
              onClick={stopStreaming}
            >
              Stop
            </button>
          ) : (
            <button
              className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50"
              onClick={submit}
              disabled={!text.trim() || !project}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'

/**
 * Left conversation-history sidebar. Lists persisted conversations, supports
 * local text filtering, click-to-load, and right-click-to-delete.
 */

/** Format an ISO timestamp into a compact, readable relative-ish label. */
function formatUpdatedAt(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export function ConversationSidebar(): JSX.Element {
  const conversations = useStore((s) => s.conversations)
  const current = useStore((s) => s.current)
  const project = useStore((s) => s.project)
  const refreshConversations = useStore((s) => s.refreshConversations)
  const newConversation = useStore((s) => s.newConversation)
  const loadConversation = useStore((s) => s.loadConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)

  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q)
    )
  }, [conversations, query])

  const handleDelete = (id: string, title: string): void => {
    if (window.confirm(`Delete conversation "${title}"? This cannot be undone.`)) {
      void deleteConversation(id)
    }
  }

  return (
    <div className="flex h-full w-[260px] flex-col border-r border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-sm font-semibold text-ink">Conversations</span>
        <button
          type="button"
          disabled={!project}
          title={
            project
              ? 'Start a new conversation'
              : 'Create or open a project first'
          }
          className="rounded bg-accent px-2 py-1 text-xs text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => newConversation()}
        >
          + New
        </button>
      </div>

      <div className="border-b border-edge px-2 py-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations…"
          className="w-full rounded border border-edge bg-raised px-2 py-1 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-muted">
            {conversations.length === 0 ? 'No conversations yet' : 'No matches'}
          </div>
        )}
        {filtered.map((c) => {
          const active = current?.id === c.id
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => void loadConversation(c.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                handleDelete(c.id, c.title)
              }}
              className={`flex w-full flex-col gap-0.5 border-b border-edge px-3 py-2 text-left hover:bg-raised ${
                active ? 'bg-accent/15' : ''
              }`}
              title="Right-click to delete"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink">
                  {c.title || 'Untitled'}
                </span>
                <span className="shrink-0 text-[10px] text-muted">
                  {formatUpdatedAt(c.updatedAt)}
                </span>
              </div>
              {c.preview && (
                <span className="truncate text-xs text-muted">{c.preview}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

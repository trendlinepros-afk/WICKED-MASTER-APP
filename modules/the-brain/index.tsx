import { ModuleTitle } from '@/shell/moduleContext'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'

/* ----------------------------- shared types ------------------------------ */

interface BrainFile {
  type: 'file'
  name: string
  rel: string
  title: string
  size: number
  mtime: number
}
interface BrainFolder {
  type: 'folder'
  name: string
  rel: string
  children: BrainNode[]
  fileCount: number
}
type BrainNode = BrainFile | BrainFolder

interface TreeResp {
  ok: boolean
  tree?: BrainNode[]
  stats?: { files: number; folders: number }
  error?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = (channel: string, ...args: unknown[]): Promise<any> =>
  (window as unknown as { wicked: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).wicked.invoke(channel, ...args)

function matchesQuery(node: BrainNode, q: string): boolean {
  if (!q) return true
  const ql = q.toLowerCase()
  if (node.type === 'file') return node.name.toLowerCase().includes(ql) || node.title.toLowerCase().includes(ql)
  return node.name.toLowerCase().includes(ql) || node.children.some((c) => matchesQuery(c, ql))
}

/* ------------------------------- tree row -------------------------------- */

function TreeView({
  nodes,
  depth,
  selected,
  query,
  expanded,
  toggle,
  onSelect,
  onDelete
}: {
  nodes: BrainNode[]
  depth: number
  selected: string | null
  query: string
  expanded: Record<string, boolean>
  toggle: (rel: string) => void
  onSelect: (rel: string) => void
  onDelete: (node: BrainNode) => void
}): React.JSX.Element {
  return (
    <>
      {nodes
        .filter((n) => matchesQuery(n, query))
        .map((node) => {
          const pad = { paddingLeft: 8 + depth * 14 }
          if (node.type === 'folder') {
            const isOpen = expanded[node.rel] ?? (depth === 0 || !!query)
            return (
              <div key={node.rel}>
                <div
                  className="group flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm text-ink hover:bg-raised"
                  style={pad}
                  onClick={() => toggle(node.rel)}
                >
                  {isOpen ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
                  {isOpen ? <FolderOpen size={15} className="shrink-0 text-warn" /> : <Folder size={15} className="shrink-0 text-warn" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted">{node.fileCount}</span>
                  <button
                    title="Delete folder"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(node)
                    }}
                    className="shrink-0 rounded p-0.5 text-muted opacity-0 hover:bg-danger/15 hover:text-danger group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {isOpen && (
                  <TreeView
                    nodes={node.children}
                    depth={depth + 1}
                    selected={selected}
                    query={query}
                    expanded={expanded}
                    toggle={toggle}
                    onSelect={onSelect}
                    onDelete={onDelete}
                  />
                )}
              </div>
            )
          }
          const active = selected === node.rel
          return (
            <div
              key={node.rel}
              className={`group flex cursor-pointer items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm ${
                active ? 'bg-accent/15 text-accent' : 'text-ink hover:bg-raised'
              }`}
              style={pad}
              onClick={() => onSelect(node.rel)}
            >
              <FileText size={15} className={`ml-[14px] shrink-0 ${active ? 'text-accent' : 'text-muted'}`} />
              <span className="min-w-0 flex-1 truncate">{node.title || node.name}</span>
              <button
                title="Delete note"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(node)
                }}
                className="shrink-0 rounded p-0.5 text-muted opacity-0 hover:bg-danger/15 hover:text-danger group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
    </>
  )
}

/* -------------------------------- screen --------------------------------- */

export default function TheBrain(): React.JSX.Element {
  const [tree, setTree] = useState<BrainNode[]>([])
  const [stats, setStats] = useState<{ files: number; folders: number }>({ files: 0, folders: 0 })
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDel, setConfirmDel] = useState<BrainNode | null>(null)

  const refresh = useCallback(async () => {
    const r = (await invoke('the-brain:tree')) as TreeResp
    if (r.ok && r.tree) {
      setTree(r.tree)
      setStats(r.stats ?? { files: 0, folders: 0 })
    } else setErr(r.error || 'Could not load the vault.')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openNote = useCallback(async (rel: string) => {
    setSelected(rel)
    setEditing(false)
    setErr('')
    const r = (await invoke('the-brain:read', rel)) as { ok: boolean; content?: string; error?: string }
    if (r.ok) setContent(r.content ?? '')
    else {
      setContent('')
      setErr(r.error || 'Could not read the note.')
    }
  }, [])

  const toggle = useCallback((rel: string) => setExpanded((e) => ({ ...e, [rel]: !(e[rel] ?? true) })), [])

  const save = useCallback(async () => {
    if (!selected) return
    setBusy(true)
    const r = (await invoke('the-brain:write', selected, draft)) as TreeResp
    setBusy(false)
    if (r.ok) {
      setContent(draft)
      setEditing(false)
      if (r.tree) setTree(r.tree)
    } else setErr(r.error || 'Save failed.')
  }, [selected, draft])

  const doDelete = useCallback(
    async (node: BrainNode) => {
      setBusy(true)
      const r = (await invoke('the-brain:delete', node.rel)) as TreeResp
      setBusy(false)
      setConfirmDel(null)
      if (r.ok) {
        if (r.tree) setTree(r.tree)
        await refresh()
        if (selected && (selected === node.rel || selected.startsWith(node.rel + '/'))) {
          setSelected(null)
          setContent('')
          setEditing(false)
        }
      } else setErr(r.error || 'Delete failed.')
    },
    [refresh, selected]
  )

  const importMd = useCallback(async () => {
    setBusy(true)
    const r = (await invoke('the-brain:import', 'Imported')) as TreeResp & { imported?: number; canceled?: boolean }
    setBusy(false)
    if (r.ok) {
      if (r.tree) setTree(r.tree)
      await refresh()
      setExpanded((e) => ({ ...e, Imported: true }))
    } else if (!r.canceled) setErr(r.error || 'Import failed.')
  }, [refresh])

  const newNote = useCallback(async () => {
    const title = window.prompt('Name this note', 'Untitled note')
    if (title == null) return
    setBusy(true)
    const r = (await invoke('the-brain:new-note', { folder: 'Notes', title: title.trim() || 'Untitled note' })) as TreeResp & {
      rel?: string
    }
    setBusy(false)
    if (r.ok) {
      if (r.tree) setTree(r.tree)
      setExpanded((e) => ({ ...e, Notes: true }))
      if (r.rel) {
        await openNote(r.rel)
        const cur = (await invoke('the-brain:read', r.rel)) as { content?: string }
        setDraft(cur.content ?? '')
        setEditing(true)
      }
    } else setErr(r.error || 'Could not create the note.')
  }, [openNote])

  const previewHtml = useMemo(() => {
    try {
      // Hide the YAML frontmatter block from the rendered view.
      const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
      return DOMPurify.sanitize(marked.parse(body, { async: false }) as string)
    } catch {
      return ''
    }
  }, [content])

  const selectedName = selected ? selected.split('/').pop() : ''

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-edge px-5 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <BrainCircuit size={20} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-semibold"><ModuleTitle fallback="The Brain" /></div>
          <div className="truncate text-xs text-muted">
            {stats.files} note{stats.files === 1 ? '' : 's'} · {stats.folders} folder{stats.folders === 1 ? '' : 's'} · local
            markdown vault · syncs with Backup &amp; Cloud Sync
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={newNote}
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
          >
            <Plus size={15} /> New note
          </button>
          <button
            onClick={importMd}
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
          >
            <Upload size={15} /> Import .md
          </button>
          <button
            onClick={() => void invoke('the-brain:open-vault')}
            title="Open the vault folder"
            className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
          >
            <ExternalLink size={15} /> Open folder
          </button>
          <button
            onClick={() => void refresh()}
            title="Refresh"
            className="flex items-center justify-center rounded-lg border border-edge bg-surface p-2 hover:border-accent/60"
          >
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {err && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/30 bg-danger/10 px-5 py-2 text-sm text-danger">
          <span>{err}</span>
          <button onClick={() => setErr('')}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* tree */}
        <div className="flex w-72 shrink-0 flex-col border-r border-edge">
          <div className="shrink-0 p-2">
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-2.5 py-1.5">
              <Search size={14} className="text-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search notes…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
              />
              {query && (
                <button onClick={() => setQuery('')} className="text-muted hover:text-ink">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {tree.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted">Empty vault. Chats will appear here automatically.</p>
            ) : (
              <TreeView
                nodes={tree}
                depth={0}
                selected={selected}
                query={query}
                expanded={expanded}
                toggle={toggle}
                onSelect={openNote}
                onDelete={setConfirmDel}
              />
            )}
          </div>
        </div>

        {/* editor / viewer */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-2.5">
                <FileText size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{selectedName}</span>
                <span className="hidden truncate text-xs text-muted sm:block">{selected}</span>
                <div className="ml-2 flex items-center gap-1.5">
                  {editing ? (
                    <>
                      <button
                        onClick={save}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-60"
                      >
                        <Save size={14} /> Save
                      </button>
                      <button
                        onClick={() => setEditing(false)}
                        className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-raised"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        setDraft(content)
                        setEditing(true)
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-raised"
                    >
                      <Pencil size={14} /> Edit
                    </button>
                  )}
                  <button
                    onClick={() => void invoke('the-brain:reveal', selected)}
                    title="Show in folder"
                    className="rounded-md border border-edge p-2 hover:bg-raised"
                  >
                    <ExternalLink size={14} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {editing ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="h-full w-full resize-none bg-bg p-5 font-mono text-sm leading-relaxed text-ink outline-none"
                  />
                ) : (
                  <div
                    className="prose prose-sm max-w-none px-6 py-5 dark:prose-invert prose-headings:text-ink prose-p:text-ink prose-li:text-ink prose-strong:text-ink prose-a:text-accent prose-code:text-accent"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
              <BrainCircuit size={44} className="text-muted/60" />
              <p className="text-sm text-muted">
                Select a note on the left, or <span className="font-medium text-ink">New note</span> /{' '}
                <span className="font-medium text-ink">Import .md</span> to add one.
              </p>
              <p className="max-w-md text-xs text-muted">
                Your AI Advisor and Wicked AI Chat conversations save here automatically under <code>Chats/</code>, and agent
                personas live under <code>Personas/</code>. Everything here is included in Backup &amp; Cloud Sync.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* delete confirm */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirmDel(null)}>
          <div className="w-full max-w-sm rounded-xl border border-edge bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2 font-semibold text-danger">
              <Trash2 size={17} /> Delete {confirmDel.type === 'folder' ? 'folder' : 'note'}
            </div>
            <p className="text-sm text-muted">
              Delete <span className="font-medium text-ink">{confirmDel.type === 'folder' ? confirmDel.name : confirmDel.title || confirmDel.name}</span>
              {confirmDel.type === 'folder' ? ` and its ${confirmDel.fileCount} note(s)` : ''}? This removes the file from the
              vault (and the next sync).
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="rounded-md border border-edge px-3 py-1.5 text-sm hover:bg-raised">
                Cancel
              </button>
              <button
                onClick={() => void doDelete(confirmDel)}
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-white"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

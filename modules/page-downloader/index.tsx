import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, FolderOpen, Globe, Image as ImageIcon, Loader2, Package, Download, Trash2, X } from 'lucide-react'

/* ---------------------------------------------------------------------------
 *  Webpage Downloader: paste an address, get the whole page — text, images,
 *  styles, fonts, frames — in its own folder (Downloads by default) that
 *  opens offline in any browser. Several addresses (spaces / new lines) are
 *  saved one after another.
 * ------------------------------------------------------------------------- */

const ID = 'page-downloader'
const inv = <T,>(action: string, arg?: unknown): Promise<T> => window.wicked.invoke(`${ID}:${action}`, arg) as Promise<T>

interface SavedPage {
  id: string
  url: string
  title: string
  dir: string
  index: string
  savedAt: number
  files: number
  bytes: number
  external: number
  screenshot: boolean
  mhtml: boolean
  exists: boolean
}
interface Prefs {
  screenshot: boolean
  keepMhtml: boolean
}
interface Status {
  saveDir: string
  defaultDir: string
  prefs: Prefs
  history: SavedPage[]
}
interface Job {
  jobId: string
  url: string
  step: string
  state: 'running' | 'done' | 'error'
  page?: SavedPage
}

const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}
const host = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
  }
}
const when = (t: number): string => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default function PageDownloader(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [text, setText] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = async (): Promise<void> => setStatus(await inv<Status>('status'))
  useEffect(() => {
    void load()
    const offs = [
      window.wicked.on(`${ID}:progress`, (raw) => {
        const p = raw as Job
        setJobs((js) => (js.some((j) => j.jobId === p.jobId) ? js.map((j) => (j.jobId === p.jobId ? { ...j, ...p } : j)) : [p, ...js]))
      }),
      window.wicked.on(`${ID}:history`, (h) => setStatus((s) => (s ? { ...s, history: h as SavedPage[] } : s)))
    ]
    return () => offs.forEach((o) => o())
  }, [])

  const urls = text
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /\w\.\w|localhost/.test(u))

  const start = (): void => {
    setError('')
    if (!urls.length) return setError('Paste a web address first — e.g. https://example.com/page')
    for (const url of urls) {
      const jobId = crypto.randomUUID()
      setJobs((js) => [{ jobId, url, step: 'Starting…', state: 'running' }, ...js])
      void inv<{ ok: boolean; error?: string }>('save', { url, jobId }).then((r) => {
        if (!r.ok) setJobs((js) => js.map((j) => (j.jobId === jobId ? { ...j, state: 'error', step: r.error ?? 'Couldn’t save the page.' } : j)))
      })
    }
    setText('')
  }

  const setPref = async (patch: Partial<Prefs>): Promise<void> => {
    const r = await inv<{ prefs: Prefs }>('prefs-set', patch)
    setStatus((s) => (s ? { ...s, prefs: r.prefs } : s))
  }

  const running = jobs.filter((j) => j.state === 'running').length
  const prefs = status?.prefs ?? { screenshot: true, keepMhtml: true }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-ink">
      <header className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface px-5 py-3">
        <Globe size={18} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Webpage Downloader</div>
          <div className="truncate text-xs text-muted" title={status?.saveDir}>
            Saves to {status?.saveDir ?? '…'}
            {status && status.saveDir !== status.defaultDir && (
              <button onClick={() => void inv('reset-folder').then(load)} className="ml-2 text-accent hover:underline">
                use Downloads
              </button>
            )}
          </div>
        </div>
        <button onClick={() => void inv('pick-folder').then(load)} className="rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60">
          Change folder
        </button>
        <button onClick={() => void inv('open-folder')} className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-sm font-medium hover:bg-edge/60">
          <FolderOpen size={14} /> Folder
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-4xl space-y-5">
          {/* address + go */}
          <div className="rounded-xl border border-edge bg-surface p-4">
            <label className="text-sm font-semibold">Web page address</label>
            <div className="mt-2 flex gap-2">
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && start()}
                placeholder="https://example.com/page — paste several to save them all"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-3 py-2.5 font-mono text-sm outline-none focus:border-accent"
              />
              <button onClick={start} disabled={!urls.length} className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-40">
                <Download size={16} /> {urls.length > 1 ? `Download ${urls.length} pages` : 'Download page'}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={prefs.screenshot} onChange={(e) => void setPref({ screenshot: e.target.checked })} />
                <ImageIcon size={14} className="text-muted" /> Full-page picture <span className="text-xs text-muted">(screenshot.png)</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-accent" checked={prefs.keepMhtml} onChange={(e) => void setPref({ keepMhtml: e.target.checked })} />
                <Package size={14} className="text-muted" /> Single-file copy <span className="text-xs text-muted">(page.mhtml — opens in Edge / Chrome)</span>
              </label>
            </div>
            <p className="mt-3 text-xs text-muted">
              The page is opened in a hidden, private browser window (no cookies, nothing of yours), scrolled to the bottom so every image loads, and saved exactly as it looked — text, images, colours, fonts and frames — as <b>index.html</b> + an <b>assets</b> folder you can open offline. Scripts are left out, so the copy stays as it was. Pages behind a login save as a logged-out visitor sees them.
            </p>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          </div>

          {/* in progress / just finished */}
          {jobs.length > 0 && (
            <div className="space-y-2">
              {jobs.slice(0, 12).map((j) => (
                <div key={j.jobId} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${j.state === 'error' ? 'border-danger/40 bg-danger/5' : j.state === 'done' ? 'border-ok/40 bg-ok/5' : 'border-accent/40 bg-surface'}`}>
                  {j.state === 'running' ? <Loader2 size={16} className="shrink-0 animate-spin text-accent" /> : j.state === 'done' ? <CheckCircle2 size={16} className="shrink-0 text-ok" /> : <AlertTriangle size={16} className="shrink-0 text-danger" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{j.page?.title || j.url}</div>
                    <div className={`truncate text-xs ${j.state === 'error' ? 'text-danger' : 'text-muted'}`}>
                      {j.state === 'done' && j.page ? `Saved ${j.page.files} files (${bytes(j.page.bytes)}) to ${j.page.dir}` : j.step}
                    </div>
                  </div>
                  {j.state === 'done' && j.page && (
                    <>
                      <button onClick={() => void inv('open', { id: j.page!.id })} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90">
                        Open page
                      </button>
                      <button onClick={() => void inv('reveal', { id: j.page!.id })} className="rounded-lg border border-edge px-3 py-1.5 text-xs font-medium hover:border-accent">
                        Show folder
                      </button>
                    </>
                  )}
                  {j.state !== 'running' && (
                    <button onClick={() => setJobs((js) => js.filter((x) => x.jobId !== j.jobId))} className="rounded-md p-1 text-muted hover:bg-raised hover:text-ink">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
              {running > 1 && <p className="text-xs text-muted">Pages are saved one after another — the rest wait their turn.</p>}
            </div>
          )}

          {/* saved pages */}
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Saved pages</h2>
              <span className="text-xs text-muted">{status?.history.length ?? 0}</span>
            </div>
            {!status?.history.length ? (
              <div className="mt-2 rounded-xl border border-dashed border-edge p-6 text-center text-sm text-muted">Pages you download show up here.</div>
            ) : (
              <div className="mt-2 divide-y divide-edge rounded-xl border border-edge bg-surface">
                {status.history.map((h) => (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Globe size={15} className="shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={h.title}>
                        {h.title || host(h.url)}
                      </div>
                      <div className="truncate text-xs text-muted" title={h.dir}>
                        {host(h.url)} · {when(h.savedAt)} · {h.files} files · {bytes(h.bytes)}
                        {!h.exists && <span className="text-warn"> · folder moved or deleted</span>}
                      </div>
                    </div>
                    {confirmDel === h.id ? (
                      <span className="flex items-center gap-2 text-xs">
                        Move the folder to the Recycle Bin?
                        <button onClick={() => void inv('delete', { id: h.id }).then(() => setConfirmDel(null))} className="rounded-md bg-danger px-2 py-1 font-semibold text-white">
                          Delete
                        </button>
                        <button onClick={() => setConfirmDel(null)} className="text-muted hover:text-ink">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <>
                        <button onClick={() => void inv('open', { id: h.id })} disabled={!h.exists} className="rounded-lg border border-edge px-2.5 py-1 text-xs font-medium hover:border-accent disabled:opacity-40">
                          Open
                        </button>
                        <button onClick={() => void inv('reveal', { id: h.id })} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink" title="Show in folder">
                          <FolderOpen size={14} />
                        </button>
                        <button onClick={() => void inv('open-original', { id: h.id })} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink" title={`Open the live page: ${h.url}`}>
                          <ExternalLink size={14} />
                        </button>
                        <button onClick={() => (h.exists ? setConfirmDel(h.id) : void inv('forget', { id: h.id }))} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-danger" title={h.exists ? 'Delete the saved copy' : 'Remove from the list'}>
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

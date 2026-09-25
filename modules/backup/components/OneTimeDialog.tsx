import { useEffect, useState } from 'react'
import { CheckCircle2, Cloud, File as FileIcon, FilePlus, Folder, FolderPlus, HardDrive, Loader2, Network, Play, X, XCircle, Zap } from 'lucide-react'
import { useBackup, inv } from '../store'
import { DEFAULT_EXCLUSIONS } from '../lib/paths'
import { btn, btnAccent, fmtBytes, input, Toggle } from './ui'

const isUnc = (p: string): boolean => /^\\\\[^\\]+\\[^\\]+/.test(p.trim())

/**
 * "Back these folders up once": sources + destination, then go. The result is
 * a one-time entry in the sidebar (browsable/restorable, never scheduled).
 */
export default function OneTimeDialog(): React.JSX.Element {
  const close = (): void => useBackup.getState().setOneTimeOpen(false)
  const startOneTime = useBackup((s) => s.startOneTime)
  const drive = useBackup((s) => s.drive)

  const [sources, setSources] = useState<string[]>([])
  const [dest, setDest] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [cloud, setCloud] = useState(false)
  const [verify, setVerify] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false })

  // start from the destination used last time
  useEffect(() => {
    void (async () => {
      const last = (await inv('last-one-time-dest')) as { path: string; username: string } | null
      if (last?.path) {
        setDest((cur) => cur || last.path)
        setUsername((cur) => cur || last.username)
      }
    })()
  }, [])

  const add = (paths: string[]): void => {
    setSources((cur) => {
      const have = new Set(cur.map((s) => s.toLowerCase()))
      return [...cur, ...paths.filter((p) => p && !have.has(p.toLowerCase()))]
    })
  }

  const unc = isUnc(dest)

  const testDest = async (): Promise<void> => {
    setTest({ busy: true })
    const r = (await inv('test-destination', { path: dest, username: unc ? username : '', password: password || null })) as {
      ok: boolean
      error?: string
      free?: number | null
    }
    setTest(r.ok ? { busy: false, ok: true, text: `Connected and writable${r.free ? ` · ${fmtBytes(r.free)} free` : ''}` } : { busy: false, ok: false, text: r.error })
  }

  const go = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const r = await startOneTime({
      name: name.trim() || undefined,
      sources,
      exclusions: DEFAULT_EXCLUSIONS,
      destination: { path: dest.trim(), username: unc ? username.trim() : '', hasPassword: false },
      password: unc && username.trim() && password ? password : null,
      cloud: { enabled: cloud },
      verifyAfter: verify
    })
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'Could not start the backup')
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onMouseDown={close}>
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-bg shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-surface px-6 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Zap size={18} />
          </div>
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-ink">One-time backup</h2>
            <p className="text-xs text-muted">Copy these folders once — no schedule. You can browse and restore it later.</p>
          </div>
          <button className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink" onClick={close}>
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {/* sources */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">What to back up</span>
              <div className="flex gap-2">
                <button className={btn} onClick={async () => add((await inv('pick-sources', { kind: 'folders' })) as string[])}>
                  <FolderPlus size={14} /> Add folders
                </button>
                <button className={btn} onClick={async () => add((await inv('pick-sources', { kind: 'files' })) as string[])}>
                  <FilePlus size={14} /> Add files
                </button>
              </div>
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                add([...e.dataTransfer.files].map((f) => window.wicked.getPathForFile(f)).filter(Boolean))
              }}
              className={`min-h-[84px] rounded-lg border border-dashed p-2 ${dragOver ? 'border-accent bg-accent/5' : 'border-edge'}`}
            >
              {sources.length === 0 ? (
                <div className="flex h-16 items-center justify-center text-sm text-muted">Drop folders or files here, or use the buttons</div>
              ) : (
                <ul className="space-y-1">
                  {sources.map((s) => (
                    <li key={s} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
                      {/\.[a-z0-9]{1,6}$/i.test(s) ? <FileIcon size={15} className="text-muted" /> : <Folder size={15} className="text-accent" />}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={s}>
                        {s}
                      </span>
                      <button
                        className="rounded p-1 text-muted opacity-0 hover:text-danger group-hover:opacity-100"
                        onClick={() => setSources((cur) => cur.filter((x) => x !== s))}
                        title="Remove"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* destination */}
          <div>
            <div className="mb-2 text-sm font-semibold text-ink">Where to put it</div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                  {unc ? <Network size={15} /> : <HardDrive size={15} />}
                </span>
                <input
                  className={`${input} pl-9 font-mono text-xs`}
                  value={dest}
                  onChange={(e) => {
                    setDest(e.target.value)
                    setTest({ busy: false })
                  }}
                  placeholder="E:\Backups  or  \\server\share\Backups"
                />
              </div>
              <button
                className={btn}
                onClick={async () => {
                  const p = (await inv('pick-folder', { title: 'Where should the backup go?' })) as string | null
                  if (p) {
                    setDest(p)
                    setTest({ busy: false })
                  }
                }}
              >
                Browse…
              </button>
              <button className={btn} disabled={!dest.trim() || test.busy} onClick={() => void testDest()}>
                {test.busy && <Loader2 size={14} className="animate-spin" />} Test
              </button>
            </div>
            {test.text && (
              <div className={`mt-2 flex items-center gap-1.5 text-xs ${test.ok ? 'text-ok' : 'text-danger'}`}>
                {test.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {test.text}
              </div>
            )}
            {unc && (
              <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-edge bg-surface p-3">
                <div className="col-span-2 text-xs text-muted">Network login (optional) — leave blank if Windows can already open this share.</div>
                <label className="text-xs text-muted">
                  User name
                  <input className={`${input} mt-1`} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="NAS\backupuser" />
                </label>
                <label className="text-xs text-muted">
                  Password
                  <input className={`${input} mt-1`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
              </div>
            )}
            <p className="mt-2 text-xs text-muted">
              Saved as plain copies in <span className="font-mono">{dest.trim() ? `${dest.trim().replace(/[\\/]+$/, '')}\\WICKED Backup\\…` : '<folder>\\WICKED Backup\\…'}</span>
            </p>
          </div>

          {/* options */}
          <div className="space-y-3 rounded-lg border border-edge bg-surface p-3">
            <label className="block text-xs text-muted">
              Name (optional)
              <input className={`${input} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the folder name and today’s date" />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
              Validate the copies when done (re-reads and checks checksums)
            </label>
            <div className="flex items-center gap-3">
              <Cloud size={16} className={cloud ? 'text-accent' : 'text-muted'} />
              <span className="flex-1 text-sm text-ink">
                Also upload a copy to Google Drive
                {!drive.connected && <span className="ml-1 text-xs text-muted">(connect Drive in File Vault first)</span>}
              </span>
              <Toggle on={cloud} onChange={setCloud} disabled={!drive.connected} />
            </div>
          </div>

          {error && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-edge bg-surface px-6 py-4">
          <button className={btn} onClick={close}>
            Cancel
          </button>
          <button className={btnAccent} disabled={busy || !sources.length || !dest.trim()} onClick={() => void go()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Back up now
          </button>
        </div>
      </div>
    </div>
  )
}

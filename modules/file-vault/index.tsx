import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cloud,
  ExternalLink,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
  Vault,
  X,
  XCircle
} from 'lucide-react'
import { useVault } from './store'
import type { Transfer, VaultFile } from './types'

/* --------------------------------- helpers -------------------------------- */

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u++
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`
}

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtSpeed(bps: number): string {
  return bps > 0 ? `${fmtBytes(bps)}/s` : ''
}

const EXT_ICONS: { re: RegExp; icon: typeof FileIcon }[] = [
  { re: /\.(exe|msi|msix|appx|bat|cmd|ps1|apk|dmg|pkg|deb|rpm|appimage)$/i, icon: Package },
  { re: /\.(zip|rar|7z|tar|gz|bz2|xz|iso|img)$/i, icon: FileArchive },
  { re: /\.(mp4|mkv|avi|mov|wmv|webm)$/i, icon: FileVideo },
  { re: /\.(mp3|wav|flac|m4a|ogg|aac)$/i, icon: FileAudio },
  { re: /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i, icon: FileImage },
  { re: /\.(txt|md|pdf|docx?|xlsx?|pptx?|csv|json|xml|log)$/i, icon: FileText }
]

function iconFor(name: string): typeof FileIcon {
  for (const { re, icon } of EXT_ICONS) if (re.test(name)) return icon
  return FileIcon
}

const btn =
  'inline-flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-3 py-1.5 text-sm text-ink hover:bg-raised/70 disabled:opacity-50'
const btnAccent =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50'
const iconBtn = 'rounded-md p-1.5 text-muted hover:bg-raised hover:text-ink'
const input =
  'w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent focus:outline-none'

/* ------------------------------- setup screen ------------------------------ */

function SetupScreen({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const s = useVault()
  const [cid, setCid] = useState('')
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)

  const step = 'flex gap-3 text-sm text-ink'
  const num = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent'

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15">
          <Vault size={24} className="text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-ink">File Vault</h1>
          <p className="text-sm text-muted">Store installers, executables and big files on your own Google Drive — $0 extra.</p>
        </div>
      </div>

      <div className="space-y-4 rounded-xl border border-edge bg-surface p-5">
        <h2 className="text-sm font-semibold text-ink">One-time setup (~10 minutes, free)</h2>
        <p className="text-sm text-muted">
          File Vault talks to Google Drive with your own private OAuth app. With a Google Workspace / Business account
          this is free, needs no Google review, and the connection never expires.
        </p>
        <ol className="space-y-3">
          <li className={step}>
            <span className={num}>1</span>
            <span>
              Open <b>console.cloud.google.com</b> (sign in with your Drive Business account) and create a new project —
              name it anything, e.g. <i>WICKED</i>.
            </span>
          </li>
          <li className={step}>
            <span className={num}>2</span>
            <span>
              In the search bar find <b>Google Drive API</b> and click <b>Enable</b>.
            </span>
          </li>
          <li className={step}>
            <span className={num}>3</span>
            <span>
              Go to <b>APIs &amp; Services → OAuth consent screen</b>. Choose user type <b>Internal</b> (this is the
              Business-account superpower — no verification, tokens never expire). App name <i>WICKED</i>, your email,
              save through the steps.
            </span>
          </li>
          <li className={step}>
            <span className={num}>4</span>
            <span>
              Go to <b>APIs &amp; Services → Credentials → Create credentials → OAuth client ID</b>. Application type:{' '}
              <b>Desktop app</b>. Create it.
            </span>
          </li>
          <li className={step}>
            <span className={num}>5</span>
            <span>Copy the <b>Client ID</b> and <b>Client secret</b> it shows into the boxes below.</span>
          </li>
        </ol>
      </div>

      <div className="space-y-3 rounded-xl border border-edge bg-surface p-5">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted">Client ID</span>
          <input
            className={input}
            value={cid}
            onChange={(e) => setCid(e.target.value)}
            placeholder="1234567890-xxxxxxxx.apps.googleusercontent.com"
            spellCheck={false}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted">Client secret</span>
          <input
            className={input}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="GOCSPX-…"
            spellCheck={false}
          />
        </label>
        <p className="text-xs text-muted">
          Stored encrypted on this PC only (Windows DPAPI) — never synced, never backed up, never shown again.
        </p>
        {s.error && <p className="text-sm text-danger">{s.error}</p>}
        <button
          className={btnAccent}
          disabled={!cid.trim() || !secret.trim() || saving}
          onClick={async () => {
            setSaving(true)
            const ok = await s.saveClient(cid.trim(), secret.trim())
            setSaving(false)
            if (ok) {
              onSaved()
              void s.connect()
            }
          }}
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Cloud size={15} />}
          Save &amp; connect Google Drive
        </button>
      </div>
    </div>
  )
}

/* ------------------------------ connect screen ----------------------------- */

function ConnectScreen({ onChangeClient }: { onChangeClient: () => void }): React.JSX.Element {
  const s = useVault()
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15">
        <Vault size={28} className="text-accent" />
      </div>
      <h1 className="text-lg font-bold text-ink">Connect your Google Drive</h1>
      <p className="text-sm text-muted">
        Your OAuth client is saved ({s.status?.clientIdTail}). Click Connect — your browser opens Google&apos;s sign-in,
        and WICKED gets its own &quot;WICKED Vault&quot; folder in your Drive.
      </p>
      {s.error && <p className="text-sm text-danger">{s.error}</p>}
      <button className={btnAccent} disabled={s.connecting} onClick={() => void s.connect()}>
        {s.connecting ? <Loader2 size={15} className="animate-spin" /> : <Cloud size={15} />}
        {s.connecting ? 'Waiting for the browser sign-in…' : 'Connect Google Drive'}
      </button>
      <button className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline" onClick={onChangeClient}>
        Use a different OAuth client…
      </button>
    </div>
  )
}

/* ------------------------------ transfers panel ---------------------------- */

function TransferRow({ t }: { t: Transfer }): React.JSX.Element {
  const s = useVault()
  const pct = t.size > 0 ? Math.min(100, (t.done / t.size) * 100) : 0
  const active = t.status === 'active' || t.status === 'verifying' || t.status === 'queued'
  const Icon = t.kind === 'upload' ? ArrowUpFromLine : ArrowDownToLine
  const label =
    t.status === 'queued'
      ? 'Queued'
      : t.status === 'verifying'
        ? 'Verifying checksum…'
        : t.status === 'done'
          ? `Done${t.verified ? ' · verified' : ''}${t.replaced ? ' · replaced older copy' : ''}`
          : t.status === 'error'
            ? t.error || 'Failed'
            : t.status === 'cancelled'
              ? 'Cancelled'
              : `${fmtBytes(t.done)} / ${fmtBytes(t.size)}${t.bps > 0 ? ` · ${fmtSpeed(t.bps)}` : ''}`
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge bg-bg px-3 py-2">
      <Icon size={15} className={t.kind === 'upload' ? 'shrink-0 text-accent' : 'shrink-0 text-ok'} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-sm text-ink">{t.name}</span>
          <span
            className={`shrink-0 text-xs ${
              t.status === 'error' ? 'text-danger' : t.status === 'done' ? 'text-ok' : 'text-muted'
            }`}
            title={t.status === 'error' ? t.error : undefined}
          >
            {t.status === 'done' && <CheckCircle2 size={12} className="mr-1 inline-block" />}
            {t.status === 'error' && <XCircle size={12} className="mr-1 inline-block" />}
            {label}
          </span>
        </div>
        {active && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
            <div
              className={`h-full rounded-full ${t.status === 'verifying' ? 'animate-pulse bg-warn' : 'bg-accent'}`}
              style={{ width: `${t.status === 'verifying' ? 100 : pct}%` }}
            />
          </div>
        )}
      </div>
      {t.status === 'done' && t.kind === 'download' && (
        <button className={iconBtn} title="Show in folder" onClick={() => s.reveal(t.localPath)}>
          <FolderOpen size={15} />
        </button>
      )}
      {active && (
        <button className={iconBtn} title="Cancel" onClick={() => void s.cancel(t.id)}>
          <X size={15} />
        </button>
      )}
    </div>
  )
}

function TransfersPanel(): React.JSX.Element | null {
  const transfers = useVault((v) => v.transfers)
  const clearDone = useVault((v) => v.clearDone)
  const [open, setOpen] = useState(true)
  if (transfers.length === 0) return null
  const activeCount = transfers.filter((t) => t.status === 'active' || t.status === 'queued' || t.status === 'verifying').length
  const shown = [...transfers].reverse()
  return (
    <div className="shrink-0 border-t border-edge bg-surface">
      <div className="flex items-center justify-between px-4 py-2">
        <button className="flex items-center gap-2 text-sm font-medium text-ink" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          Transfers
          {activeCount > 0 && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">{activeCount} active</span>
          )}
        </button>
        <button className="text-xs text-muted hover:text-ink" onClick={() => void clearDone()}>
          Clear finished
        </button>
      </div>
      {open && (
        <div className="max-h-56 space-y-1.5 overflow-y-auto px-4 pb-3">
          {shown.map((t) => (
            <TransferRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

/* -------------------------------- vault screen ----------------------------- */

function FileRow({ f }: { f: VaultFile }): React.JSX.Element {
  const s = useVault()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(f.name)
  const [confirmDel, setConfirmDel] = useState(false)
  const Icon = iconFor(f.name)

  return (
    <div className="group flex items-center gap-3 border-b border-edge/60 px-4 py-2.5 hover:bg-raised/40">
      <Icon size={18} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            className={`${input} py-1`}
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                setRenaming(false)
                if (name.trim() !== f.name) void s.rename(f.id, name.trim())
              }
              if (e.key === 'Escape') {
                setRenaming(false)
                setName(f.name)
              }
            }}
            onBlur={() => {
              setRenaming(false)
              setName(f.name)
            }}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm text-ink">{f.name}</span>
            {f.md5 && (
              <span title={`MD5 ${f.md5} — every transfer is verified against this`}>
                <ShieldCheck size={13} className="shrink-0 text-ok/70" />
              </span>
            )}
          </div>
        )}
      </div>
      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted">{fmtBytes(f.size)}</span>
      <span className="hidden w-24 shrink-0 text-right text-xs text-muted sm:block">{fmtDate(f.modifiedTime)}</span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button className={iconBtn} title="Download" onClick={() => void s.download(f.id, f.name)}>
          <ArrowDownToLine size={15} />
        </button>
        <button className={iconBtn} title="Open in Google Drive" onClick={() => s.openDrive(f.id)}>
          <ExternalLink size={15} />
        </button>
        <button
          className={iconBtn}
          title="Rename"
          onClick={() => {
            setName(f.name)
            setRenaming(true)
          }}
        >
          <Pencil size={15} />
        </button>
        {confirmDel ? (
          <button
            className="rounded-md bg-danger px-2 py-1 text-xs font-semibold text-white"
            title="Really move to Drive trash?"
            onMouseLeave={() => setConfirmDel(false)}
            onClick={() => {
              setConfirmDel(false)
              void s.del(f.id)
            }}
          >
            Sure?
          </button>
        ) : (
          <button className={`${iconBtn} hover:text-danger`} title="Move to Drive trash (recoverable ~30 days)" onClick={() => setConfirmDel(true)}>
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

function VaultScreen(): React.JSX.Element {
  const s = useVault()
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const filtered = useMemo(() => {
    const q = s.search.trim().toLowerCase()
    return q ? s.files.filter((f) => f.name.toLowerCase().includes(q)) : s.files
  }, [s.files, s.search])

  const totalBytes = useMemo(() => s.files.reduce((a, f) => a + f.size, 0), [s.files])
  const quotaPct = s.quota && s.quota.limit > 0 ? Math.min(100, (s.quota.usage / s.quota.limit) * 100) : null

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          dragDepth.current++
          setDragOver(true)
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => {
            try {
              return window.wicked.getPathForFile(f)
            } catch {
              return ''
            }
          })
          .filter(Boolean)
        if (paths.length > 0) void s.uploadPaths(paths)
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10">
          <div className="rounded-xl bg-surface px-6 py-4 text-center shadow-xl">
            <Upload size={24} className="mx-auto mb-2 text-accent" />
            <p className="text-sm font-medium text-ink">Drop to upload to your Drive vault</p>
          </div>
        </div>
      )}

      {/* header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15">
            <Vault size={18} className="text-accent" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-tight text-ink">File Vault</h1>
            <p className="text-xs leading-tight text-muted">{s.status?.email}</p>
          </div>
        </div>
        <div className="min-w-[10rem] flex-1" />
        {s.quota && (
          <div className="hidden items-center gap-2 md:flex" title={`Google Drive storage${quotaPct != null ? ` · ${quotaPct.toFixed(1)}% used` : ''}`}>
            <div className="text-right text-xs leading-tight text-muted">
              <div>
                {fmtBytes(s.quota.usage)} of {s.quota.limit > 0 ? fmtBytes(s.quota.limit) : '∞'} used
              </div>
              <div>{s.files.length} files in vault · {fmtBytes(totalBytes)}</div>
            </div>
            {quotaPct != null && (
              <div className="relative h-8 w-1.5 overflow-hidden rounded-full bg-raised">
                <div className="absolute bottom-0 w-full rounded-full bg-accent" style={{ height: `${Math.max(4, quotaPct)}%` }} />
              </div>
            )}
          </div>
        )}
        <button className={btnAccent} onClick={() => void s.pickUpload()}>
          <Upload size={15} />
          Upload files
        </button>
        <button className={btn} title="Open the WICKED Vault folder on drive.google.com" onClick={() => s.openDrive()}>
          <ExternalLink size={15} />
          Open in Drive
        </button>
        <button className={iconBtn} title="Refresh" onClick={() => void s.refreshFiles()}>
          <RefreshCw size={16} className={s.loadingFiles ? 'animate-spin' : ''} />
        </button>
        <button className={iconBtn} title={`Disconnect ${s.status?.email ?? ''}`} onClick={() => void s.disconnect()}>
          <Unplug size={16} />
        </button>
      </div>

      {s.error && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
          <span className="min-w-0">{s.error}</span>
          <button className="shrink-0 text-danger/80 hover:text-danger" onClick={() => s.clearError()}>
            <X size={15} />
          </button>
        </div>
      )}

      {/* search */}
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-4 py-2">
        <Search size={15} className="shrink-0 text-muted" />
        <input
          className="w-full bg-transparent text-sm text-ink placeholder:text-muted/60 focus:outline-none"
          placeholder="Search the vault…"
          value={s.search}
          onChange={(e) => s.setSearch(e.target.value)}
          spellCheck={false}
        />
        {s.search && (
          <button className="shrink-0 text-muted hover:text-ink" onClick={() => s.setSearch('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {/* file list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {s.loadingFiles && s.files.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Cloud size={28} className="text-muted/50" />
            <p className="text-sm text-muted">
              {s.search
                ? 'Nothing matches your search.'
                : 'The vault is empty — click Upload files or drag anything onto this window. Any size, no limits beyond your Drive plan.'}
            </p>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 border-b border-edge bg-surface px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              <span className="w-[18px] shrink-0" />
              <span className="min-w-0 flex-1">Name</span>
              <span className="w-20 shrink-0 text-right">Size</span>
              <span className="hidden w-24 shrink-0 text-right sm:block">Modified</span>
              <span className="w-[8.5rem] shrink-0" />
            </div>
            {filtered.map((f) => (
              <FileRow key={f.id} f={f} />
            ))}
          </div>
        )}
      </div>

      <TransfersPanel />
    </div>
  )
}

/* ---------------------------------- root ----------------------------------- */

export default function FileVault(): React.JSX.Element {
  const status = useVault((v) => v.status)
  const init = useVault((v) => v.init)
  const setTransfers = useVault((v) => v.setTransfers)
  const [forceSetup, setForceSetup] = useState(false)

  useEffect(() => {
    void init()
    const off = window.wicked.on('file-vault:transfers-changed', (list) => setTransfers(list as Transfer[]))
    return off
  }, [init, setTransfers])

  if (!status)
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  if (!status.clientConfigured || forceSetup)
    return (
      <div className="h-full overflow-y-auto">
        <SetupScreen onSaved={() => setForceSetup(false)} />
      </div>
    )
  if (!status.connected)
    return (
      <div className="h-full overflow-y-auto">
        <ConnectScreen onChangeClient={() => setForceSetup(true)} />
      </div>
    )
  return <VaultScreen />
}

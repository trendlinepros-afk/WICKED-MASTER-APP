import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Cloud, DownloadCloud, Loader2 } from 'lucide-react'
import { SHELL_IPC, type SyncStatus } from '@shared/types'

/** "2m ago" style relative time; '' if the timestamp is empty/unparseable. */
function rel(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * A compact Cloud Sync indicator for the sidebar. Hidden until sync is set up;
 * then shows synced/last-time, a "Syncing…" spinner, "Cloud has updates" when
 * the repo is ahead of this device, or a warning on error. Click → Settings.
 * Does ONE remote check on mount (cheap manifest GET) so a pull-only device sees
 * pending updates without opening Settings; further updates arrive via events.
 */
export default function SyncBadge({ expanded }: { expanded: boolean }): React.JSX.Element | null {
  const [st, setSt] = useState<SyncStatus | null>(null)
  const navigate = useNavigate()
  const checked = useRef(false)

  useEffect(() => {
    let alive = true
    window.wicked.invoke(SHELL_IPC.syncStatus).then((s) => {
      if (alive) setSt(s as SyncStatus)
    })
    const off = window.wicked.on(SHELL_IPC.syncEvent, (raw) => setSt(raw as SyncStatus))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (st?.configured && !checked.current) {
      checked.current = true
      // fire-and-forget; the resulting broadcast updates this badge
      window.wicked.invoke(SHELL_IPC.syncCheckRemote).catch(() => undefined)
    }
  }, [st?.configured])

  if (!st || !st.configured) return null

  const compare =
    st.remote == null
      ? 'no-remote'
      : st.remote.version > st.lastSyncedVersion
        ? 'remote-newer'
        : st.remote.version < st.lastSyncedVersion
          ? 'local-ahead'
          : 'up-to-date'

  let Icon = Cloud
  let label = 'Sync ready'
  let tone = 'text-muted'
  let spin = false
  let dot = ''
  if (st.busy) {
    Icon = Loader2
    label = 'Syncing…'
    spin = true
  } else if (st.error) {
    Icon = AlertTriangle
    label = 'Sync issue'
    tone = 'text-warn'
    dot = 'bg-warn'
  } else if (compare === 'remote-newer') {
    Icon = DownloadCloud
    label = 'Cloud has updates'
    tone = 'text-accent'
    dot = 'bg-accent'
  } else {
    const when = rel(st.lastPushUtc || st.lastPullUtc)
    label = when ? `Synced ${when}` : 'Sync ready'
  }

  const title = st.error
    ? `Cloud Sync error: ${st.error}`
    : compare === 'remote-newer'
      ? `Cloud is v${st.remote?.version} from ${st.remote?.device || 'another device'} — open Settings to Pull`
      : `Cloud Sync${st.lastPushUtc ? ` · pushed ${rel(st.lastPushUtc)}` : ''}${st.lastPullUtc ? ` · pulled ${rel(st.lastPullUtc)}` : ''}`

  return (
    <button
      onClick={() => navigate('/settings')}
      title={title}
      className={`relative flex h-9 items-center rounded-lg text-muted transition-colors hover:bg-raised/70 hover:text-ink ${
        expanded ? 'w-full gap-3 px-3' : 'w-10 justify-center'
      }`}
    >
      <Icon size={18} strokeWidth={1.8} className={`shrink-0 ${tone} ${spin ? 'animate-spin' : ''}`} />
      {expanded && <span className={`min-w-0 flex-1 truncate text-left text-xs ${tone}`}>{label}</span>}
      {!expanded && dot && <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${dot}`} />}
    </button>
  )
}

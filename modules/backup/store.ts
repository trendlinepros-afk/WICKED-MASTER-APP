import { create } from 'zustand'
import type { BackupPlan, DriveStatus, GlobalSettings, HistoryEntry, PlanView, QueueState, VersionInfo } from './types'

const inv = (action: string, ...args: unknown[]): Promise<unknown> => window.wicked.invoke(`backup:${action}`, ...args)

export type PlanDraft = Partial<BackupPlan> & { password?: string | null }

export type Tab = 'overview' | 'recovery' | 'activity'

export interface VersionsState {
  loading: boolean
  list: VersionInfo[]
  localError: string
  cloudError: string
  loadedAt: number
}

interface Res {
  ok?: boolean
  error?: string
  canceled?: boolean
}

interface BackupState {
  ready: boolean
  plans: PlanView[]
  queue: QueueState
  history: HistoryEntry[]
  drive: DriveStatus
  settings: GlobalSettings
  selectedId: string | null
  tab: Tab
  /** editor: null = closed, {} = new plan, plan = editing */
  editing: PlanDraft | null
  versions: Record<string, VersionsState>
  /** version to preselect when switching to Recovery */
  focusVersion: string | null
  toast: { kind: 'ok' | 'warn' | 'err'; text: string } | null

  init: () => Promise<() => void>
  refresh: () => Promise<void>
  select: (id: string | null) => void
  setTab: (t: Tab) => void
  openRecovery: (versionId: string | null) => void
  openEditor: (plan?: PlanView | null) => void
  closeEditor: () => void
  savePlan: (d: PlanDraft) => Promise<{ ok: boolean; error?: string; plan?: PlanView }>
  deletePlan: (id: string, deleteBackups: boolean) => Promise<Res & { note?: string }>
  run: (id: string, full?: boolean) => Promise<void>
  cancel: (jobId?: string) => Promise<void>
  cloudSync: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  adopt: (id: string) => Promise<void>
  openExisting: () => Promise<void>
  setOpenAtLogin: (on: boolean) => Promise<void>
  loadVersions: (planId: string, force?: boolean) => Promise<void>
  refreshDrive: () => Promise<void>
  showToast: (kind: 'ok' | 'warn' | 'err', text: string) => void
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useBackup = create<BackupState>((set, get) => ({
  ready: false,
  plans: [],
  queue: { running: null, queued: [] },
  history: [],
  drive: { connected: false, email: '' },
  settings: { openAtLogin: false, machine: '' },
  selectedId: null,
  tab: 'overview',
  editing: null,
  versions: {},
  focusVersion: null,
  toast: null,

  init: async () => {
    const [plans, queue, history, drive, settings] = (await Promise.all([
      inv('list-plans'),
      inv('queue'),
      inv('history', { limit: 300 }),
      inv('drive-status'),
      inv('settings')
    ])) as [PlanView[], QueueState, HistoryEntry[], DriveStatus, GlobalSettings]
    const sel = get().selectedId
    set({
      ready: true,
      plans,
      queue,
      history,
      drive,
      settings,
      selectedId: sel && plans.some((p) => p.id === sel) ? sel : plans[0]?.id ?? null
    })
    const offQueue = window.wicked.on('backup:queue', (q) => set({ queue: q as QueueState }))
    const offChanged = window.wicked.on('backup:changed', () => void get().refresh())
    const offDone = window.wicked.on('backup:job-done', (e) => {
      const entry = e as HistoryEntry
      const kind = entry.status === 'success' ? 'ok' : entry.status === 'failed' ? 'err' : 'warn'
      if (entry.status !== 'cancelled') get().showToast(kind, `${entry.planName}: ${entry.message}`)
      if (entry.kind !== 'restore') void get().loadVersions(entry.planId, true)
    })
    return () => {
      offQueue()
      offChanged()
      offDone()
    }
  },

  refresh: async () => {
    const [plans, history] = (await Promise.all([inv('list-plans'), inv('history', { limit: 300 })])) as [
      PlanView[],
      HistoryEntry[]
    ]
    const sel = get().selectedId
    set({ plans, history, selectedId: sel && plans.some((p) => p.id === sel) ? sel : plans[0]?.id ?? null })
  },

  select: (id) => set({ selectedId: id, focusVersion: null }),
  setTab: (tab) => set({ tab }),
  openRecovery: (versionId) => set({ tab: 'recovery', focusVersion: versionId }),
  openEditor: (plan) => set({ editing: plan ? { ...plan } : {} }),
  closeEditor: () => set({ editing: null }),

  savePlan: async (d) => {
    const r = (await inv('save-plan', d)) as { ok: boolean; error?: string; plan?: PlanView }
    if (r.ok && r.plan) {
      await get().refresh()
      set({ selectedId: r.plan.id, editing: null })
    }
    return r
  },

  deletePlan: async (id, deleteBackups) => {
    const r = (await inv('delete-plan', { planId: id, deleteBackups })) as Res & { note?: string }
    if (r.ok) {
      const versions = { ...get().versions }
      delete versions[id]
      set({ versions })
      await get().refresh()
    }
    return r
  },

  run: async (id, full) => {
    const r = (await inv('run', { planId: id, full: !!full })) as Res
    if (!r.ok) get().showToast('err', r.error ?? 'Could not start the backup')
  },

  cancel: async (jobId) => {
    await inv('cancel', { jobId })
  },

  cloudSync: async (id) => {
    const r = (await inv('cloud-sync', { planId: id })) as Res
    if (!r.ok) get().showToast('err', r.error ?? 'Could not start the Google Drive copy')
  },

  setEnabled: async (id, enabled) => {
    await inv('set-enabled', { planId: id, enabled })
    await get().refresh()
  },

  adopt: async (id) => {
    await inv('adopt', { planId: id })
    await get().refresh()
  },

  openExisting: async () => {
    const r = (await inv('open-existing')) as Res & { added?: number; found?: number }
    if (r.canceled) return
    if (!r.ok) get().showToast('err', r.error ?? 'Nothing found')
    else get().showToast('ok', r.added ? `Added ${r.added} backup plan${r.added === 1 ? '' : 's'}` : 'Those backups were already in the list (location updated)')
    await get().refresh()
  },

  setOpenAtLogin: async (on) => {
    const settings = (await inv('set-open-at-login', { enabled: on })) as GlobalSettings
    set({ settings })
  },

  loadVersions: async (planId, force) => {
    const cur = get().versions[planId]
    if (cur && !force && (cur.loading || Date.now() - cur.loadedAt < 15_000)) return
    set({
      versions: {
        ...get().versions,
        [planId]: { loading: true, list: cur?.list ?? [], localError: '', cloudError: '', loadedAt: cur?.loadedAt ?? 0 }
      }
    })
    const r = (await inv('versions', { planId })) as {
      ok: boolean
      error?: string
      versions: VersionInfo[]
      localError: string
      cloudError: string
    }
    set({
      versions: {
        ...get().versions,
        [planId]: {
          loading: false,
          list: r.versions ?? [],
          localError: r.ok ? r.localError : r.error ?? 'Could not list versions',
          cloudError: r.cloudError ?? '',
          loadedAt: Date.now()
        }
      }
    })
  },

  refreshDrive: async () => {
    set({ drive: (await inv('drive-status')) as DriveStatus })
  },

  showToast: (kind, text) => {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { kind, text } })
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'ok' ? 5000 : 9000)
  }
}))

export { inv }

import { create } from 'zustand'
import type { QuotaInfo, Transfer, VaultFile, VaultStatus } from './types'

const inv = (action: string, ...args: unknown[]): Promise<unknown> =>
  window.wicked.invoke(`file-vault:${action}`, ...args)

type Res = { ok?: boolean; canceled?: boolean; error?: string; status?: VaultStatus; queued?: number; errors?: string[] }

/** One hop in the folder breadcrumb (root is implicit; [] = at the vault root). */
export interface Crumb {
  id: string
  name: string
}

interface VaultState {
  status: VaultStatus | null
  quota: QuotaInfo | null
  files: VaultFile[]
  transfers: Transfer[]
  loadingFiles: boolean
  connecting: boolean
  /** last error banner ('' = none) */
  error: string
  search: string
  /** breadcrumb from the vault root to the folder being viewed ([] = root) */
  path: Crumb[]

  init: () => Promise<void>
  refreshFiles: () => Promise<void>
  refreshQuota: () => Promise<void>
  saveClient: (clientId: string, clientSecret: string) => Promise<boolean>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  pickUpload: () => Promise<void>
  pickUploadFolder: () => Promise<void>
  uploadPaths: (paths: string[]) => Promise<void>
  download: (fileId: string, name: string) => Promise<void>
  openFolder: (f: VaultFile) => void
  /** navigate to a breadcrumb entry; index -1 = the vault root */
  goToCrumb: (index: number) => void
  cancel: (id: string) => Promise<void>
  clearDone: () => Promise<void>
  del: (fileId: string) => Promise<void>
  rename: (fileId: string, name: string) => Promise<void>
  openDrive: (fileId?: string, isFolder?: boolean) => void
  reveal: (path: string) => void
  chooseDownloadDir: () => Promise<void>
  setSearch: (s: string) => void
  setTransfers: (t: Transfer[]) => void
  clearError: () => void
}

/** Drive id of the folder currently being viewed ('' = the vault root). */
const curFolderId = (path: Crumb[]): string => (path.length ? path[path.length - 1].id : '')

export const useVault = create<VaultState>((set, get) => ({
  status: null,
  quota: null,
  files: [],
  transfers: [],
  loadingFiles: false,
  connecting: false,
  error: '',
  search: '',
  path: [],

  init: async () => {
    const status = (await inv('status')) as VaultStatus
    const transfers = (await inv('transfers')) as Transfer[]
    set({ status, transfers })
    if (status.connected) {
      void get().refreshFiles()
      void get().refreshQuota()
    }
  },

  refreshFiles: async () => {
    set({ loadingFiles: true })
    const folderId = curFolderId(get().path)
    const r = (await inv('list', folderId)) as { files?: VaultFile[]; error?: string }
    // ignore a response that arrived after the user navigated elsewhere
    if (curFolderId(get().path) !== folderId) return
    if (r.error) set({ error: r.error, loadingFiles: false })
    else set({ files: r.files ?? [], loadingFiles: false, error: '' })
  },

  refreshQuota: async () => {
    const r = (await inv('quota')) as QuotaInfo & { error?: string }
    if (!r.error) set({ quota: r })
  },

  saveClient: async (clientId, clientSecret) => {
    const r = (await inv('save-client', { clientId, clientSecret })) as Res
    if (r.error) {
      set({ error: r.error })
      return false
    }
    set({ status: r.status ?? get().status, error: '' })
    return true
  },

  connect: async () => {
    set({ connecting: true, error: '' })
    const r = (await inv('connect')) as Res
    if (r.error) set({ error: r.error, connecting: false })
    else {
      set({ status: r.status ?? get().status, connecting: false })
      void get().refreshFiles()
      void get().refreshQuota()
    }
  },

  disconnect: async () => {
    const r = (await inv('disconnect')) as Res
    set({ status: r.status ?? get().status, files: [], quota: null, path: [] })
  },

  pickUpload: async () => {
    const r = (await inv('pick-upload', curFolderId(get().path))) as Res
    if (r.error) set({ error: r.error })
    else if (r.errors && r.errors.length > 0) set({ error: r.errors.join('; ') })
  },

  pickUploadFolder: async () => {
    const r = (await inv('pick-upload-folder', curFolderId(get().path))) as Res
    if (r.error) set({ error: r.error })
    else if (r.errors && r.errors.length > 0) set({ error: r.errors.join('; ') })
  },

  uploadPaths: async (paths) => {
    const r = (await inv('upload-paths', { paths, folderId: curFolderId(get().path) })) as Res
    if (r.error) set({ error: r.error })
    else if (r.errors && r.errors.length > 0) set({ error: r.errors.join('; ') })
  },

  download: async (fileId, name) => {
    const r = (await inv('download', { fileId, name })) as Res
    if (r.error) set({ error: r.error })
  },

  openFolder: (f) => {
    if (!f.isFolder) return
    set({ path: [...get().path, { id: f.id, name: f.name }], files: [], search: '' })
    void get().refreshFiles()
  },

  goToCrumb: (index) => {
    const next = index < 0 ? [] : get().path.slice(0, index + 1)
    set({ path: next, files: [], search: '' })
    void get().refreshFiles()
  },

  cancel: async (id) => {
    await inv('cancel', id)
  },

  clearDone: async () => {
    await inv('clear-done')
    set({ transfers: get().transfers.filter((t) => t.status === 'queued' || t.status === 'active' || t.status === 'verifying') })
  },

  del: async (fileId) => {
    const r = (await inv('delete', { fileId })) as Res
    if (r.error) set({ error: r.error })
    else void get().refreshFiles()
  },

  rename: async (fileId, name) => {
    const r = (await inv('rename', { fileId, name })) as Res
    if (r.error) set({ error: r.error })
    else void get().refreshFiles()
  },

  openDrive: (fileId, isFolder) => {
    void inv('open-drive', fileId ? { fileId, isFolder: !!isFolder } : undefined)
  },

  reveal: (path) => {
    void inv('reveal', path)
  },

  chooseDownloadDir: async () => {
    const r = (await inv('set-download-dir')) as Res
    if (r.status) set({ status: r.status })
  },

  setSearch: (search) => set({ search }),

  setTransfers: (incoming) => {
    const prev = get().transfers
    const doneBefore = prev.filter((t) => t.status === 'done').length
    const doneNow = incoming.filter((t) => t.status === 'done').length
    // deep-ish copy: the array arrives via IPC already detached, but keep a new
    // reference so React re-renders
    set({ transfers: [...incoming] })
    // a transfer just finished → the vault's contents (or a local file) changed
    if (doneNow > doneBefore) {
      if (incoming.some((t) => t.status === 'done' && t.kind === 'upload')) void get().refreshFiles()
      void get().refreshQuota()
    }
  },

  clearError: () => set({ error: '' })
}))

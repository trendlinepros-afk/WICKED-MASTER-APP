import { create } from 'zustand'

export const ID = 'finance-tracker'

export type Tab = 'overview' | 'transactions' | 'subs'

export interface Account {
  id: string
  name: string
  createdAt: number
  txCount: number
}

export interface Tx {
  account: string
  hash: string
  ymd: string
  postedAt: number
  merchant: string
  rawDesc: string
  name: string
  amount: number
  category: string
  isSub: boolean
  edited: boolean
}

interface Res {
  ok: boolean
  error?: string
  canceled?: boolean
  [k: string]: unknown
}

const invoke = <T = Res>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

interface RawTx extends Omit<Tx, 'isSub' | 'edited'> {
  isSub: number
  edited: number
}

const mapTx = (r: RawTx): Tx => ({ ...r, isSub: !!r.isSub, edited: !!r.edited })

interface State {
  loaded: boolean
  busy: boolean
  importing: boolean
  error: string
  status: string
  tab: Tab
  accounts: Account[]
  /** selected account id; '' = all accounts */
  active: string
  txns: Tx[]

  setTab: (t: Tab) => void
  dismissError: () => void
  load: () => Promise<void>
  refresh: () => Promise<void>
  setActive: (id: string) => Promise<void>
  importCsv: () => Promise<void>
  importPaths: (paths: string[]) => Promise<void>
  createAccount: (name: string) => Promise<void>
  renameAccount: (id: string, name: string) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  clearData: (account?: string) => Promise<void>
  updateTx: (tx: Tx, patch: { name?: string; category?: string; isSub?: boolean }) => Promise<void>
  setMerchantSub: (merchant: string, isSub: boolean) => Promise<void>
}

export const useFinance = create<State>((set, get) => {
  const reloadTxns = async (): Promise<void> => {
    const res = (await invoke('transactions', get().active)) as Res & { transactions?: RawTx[] }
    if (res.ok) set({ txns: (res.transactions ?? []).map(mapTx) })
    else set({ error: res.error ?? 'Could not load transactions.' })
  }
  const reloadAccounts = async (): Promise<void> => {
    const res = (await invoke('bootstrap')) as Res & { accounts?: Account[]; active?: string }
    if (res.ok) set({ accounts: res.accounts ?? [] })
  }

  return {
    loaded: false,
    busy: false,
    importing: false,
    error: '',
    status: 'Import a credit-card statement CSV to begin.',
    tab: 'overview',
    accounts: [],
    active: '',
    txns: [],

    setTab: (t) => set({ tab: t }),
    dismissError: () => set({ error: '' }),

    load: async () => {
      const res = (await invoke('bootstrap')) as Res & { accounts?: Account[]; active?: string }
      if (res.ok) set({ accounts: res.accounts ?? [], active: res.active ?? '' })
      else set({ error: res.error ?? 'Could not load accounts.' })
      await reloadTxns()
      set({ loaded: true })
    },

    refresh: async () => {
      await reloadAccounts()
      await reloadTxns()
    },

    setActive: async (id) => {
      set({ active: id })
      await invoke('set-active', id)
      await reloadTxns()
    },

    importCsv: async () => {
      if (get().importing) return
      const target = get().active || get().accounts[0]?.id || ''
      set({ importing: true, error: '', status: 'Importing…' })
      try {
        const res = (await invoke('import-dialog', target)) as Res & { imported?: number; skipped?: number; errors?: number; flaggedSubs?: number }
        if (!res.ok) {
          if (!res.canceled) set({ error: res.error ?? 'Import failed.', status: 'Import failed.' })
          return
        }
        await get().refresh()
        const subNote = res.flaggedSubs ? ` · flagged ${res.flaggedSubs} subscription charge(s)` : ''
        set({ status: `Imported ${res.imported ?? 0} new transaction(s), skipped ${res.skipped ?? 0} duplicate(s)${subNote}.` })
      } finally {
        set({ importing: false })
      }
    },

    importPaths: async (paths) => {
      if (get().importing || paths.length === 0) return
      const target = get().active || get().accounts[0]?.id || ''
      set({ importing: true, error: '', status: 'Importing…' })
      try {
        const res = (await invoke('import-file', paths, target)) as Res & { imported?: number; skipped?: number; flaggedSubs?: number }
        if (!res.ok) {
          set({ error: res.error ?? 'Import failed.', status: 'Import failed.' })
          return
        }
        await get().refresh()
        const subNote = res.flaggedSubs ? ` · flagged ${res.flaggedSubs} subscription charge(s)` : ''
        set({ status: `Imported ${res.imported ?? 0} new transaction(s), skipped ${res.skipped ?? 0} duplicate(s)${subNote}.` })
      } finally {
        set({ importing: false })
      }
    },

    createAccount: async (name) => {
      const res = (await invoke('accounts-create', name)) as Res & { accounts?: Account[] }
      if (res.ok) set({ accounts: res.accounts ?? get().accounts })
      else set({ error: res.error ?? 'Could not create the account.' })
    },

    renameAccount: async (id, name) => {
      const res = (await invoke('accounts-rename', { id, name })) as Res & { accounts?: Account[] }
      if (res.ok) set({ accounts: res.accounts ?? get().accounts })
      else set({ error: res.error ?? 'Could not rename the account.' })
    },

    deleteAccount: async (id) => {
      const res = (await invoke('accounts-delete', id)) as Res & { accounts?: Account[] }
      if (!res.ok) {
        set({ error: res.error ?? 'Could not delete the account.' })
        return
      }
      if (get().active === id) set({ active: '' })
      set({ accounts: res.accounts ?? get().accounts })
      await reloadTxns()
    },

    clearData: async (account) => {
      set({ busy: true })
      try {
        const res = await invoke('clear', account ?? '')
        if (!res.ok) set({ error: res.error ?? 'Could not clear data.' })
        await get().refresh()
        set({ status: account ? 'Account transactions cleared.' : 'All transactions cleared.' })
      } finally {
        set({ busy: false })
      }
    },

    updateTx: async (tx, patch) => {
      const res = await invoke('tx-update', { account: tx.account, hash: tx.hash, ...patch })
      if (!res.ok) {
        set({ error: res.error ?? 'Could not update the transaction.' })
        return
      }
      await reloadTxns()
    },

    setMerchantSub: async (merchant, isSub) => {
      const res = await invoke('merchant-sub', { merchant, isSub })
      if (!res.ok) {
        set({ error: res.error ?? 'Could not update the subscription.' })
        return
      }
      await reloadTxns()
    }
  }
})

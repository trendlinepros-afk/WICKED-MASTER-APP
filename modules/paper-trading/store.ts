import { create } from 'zustand'
import type { PaperAccount, PaperData } from './types'

const ID = 'paper-trading'
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

export type Timeframe = '1D' | '5D' | '1M' | '3M' | '1Y'
export type Tab = 'positions' | 'history' | 'review'

interface DataRes {
  ok: boolean
  data?: PaperData
  error?: string
  fillPrice?: number
  closedCount?: number
}

export interface OrderDraft {
  kind: 'stock' | 'option'
  symbol: string
  side: 'long' | 'short'
  qty: number
  stop?: number | null
  takeProfit?: number | null
  // option
  optionType?: 'call' | 'put'
  strike?: number
  expiry?: string
  price?: number // premium (options) — ignored for stocks (filled live)
}

interface State {
  data: PaperData | null
  marks: Record<string, number>
  loading: boolean
  busy: boolean
  error: string
  status: string
  chartSymbol: string
  timeframe: Timeframe
  tab: Tab

  active: () => PaperAccount | null
  load: () => Promise<void>
  pollQuotes: () => Promise<void>
  setActive: (id: string) => Promise<void>
  createAccount: (name: string, startingBalance: number) => Promise<void>
  renameAccount: (id: string, name: string) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  placeOrder: (o: OrderDraft) => Promise<string | null>
  closePosition: (positionId: string, qty?: number, price?: number) => Promise<void>
  updatePosition: (positionId: string, patch: { stop?: number | null; takeProfit?: number | null }) => Promise<void>
  setChartSymbol: (s: string) => void
  setTimeframe: (t: Timeframe) => void
  setTab: (t: Tab) => void
}

function heldSymbols(data: PaperData | null): string[] {
  const acct = data?.accounts.find((a) => a.id === data.activeId)
  return [...new Set((acct?.positions ?? []).map((p) => p.symbol))]
}

export const usePaper = create<State>((set, get) => ({
  data: null,
  marks: {},
  loading: true,
  busy: false,
  error: '',
  status: '',
  chartSymbol: 'AAPL',
  timeframe: '1D',
  tab: 'positions',

  active: () => {
    const d = get().data
    return d?.accounts.find((a) => a.id === d.activeId) ?? null
  },

  load: async () => {
    set({ loading: true })
    const res = await invoke<DataRes>('get')
    let data = res.data ?? null
    set({ data, loading: false })
    // On open, backdate any stops/targets that were hit while the app was closed.
    if (data) {
      const rec = await invoke<DataRes>('reconcile', data.activeId)
      if (rec.ok && rec.data) {
        data = rec.data
        set({ data, status: rec.closedCount ? `Backdated ${rec.closedCount} stop/target exit(s) that hit while you were away.` : '' })
      }
    }
    void get().pollQuotes()
  },

  pollQuotes: async () => {
    const data = get().data
    const syms = [...new Set([...heldSymbols(data), get().chartSymbol.toUpperCase()].filter(Boolean))]
    if (syms.length === 0) return
    const res = await invoke<{ ok: boolean; quotes?: Record<string, number> }>('quotes', syms)
    if (res.ok && res.quotes) set({ marks: { ...get().marks, ...res.quotes } })
  },

  setActive: async (id) => {
    const res = await invoke<DataRes>('accounts-active', id)
    if (res.ok && res.data) {
      set({ data: res.data })
      const rec = await invoke<DataRes>('reconcile', id)
      if (rec.ok && rec.data) set({ data: rec.data })
      void get().pollQuotes()
    }
  },

  createAccount: async (name, startingBalance) => {
    const res = await invoke<DataRes>('accounts-create', { name, startingBalance })
    if (res.ok && res.data) set({ data: res.data })
  },
  renameAccount: async (id, name) => {
    const res = await invoke<DataRes>('accounts-rename', id, name)
    if (res.ok && res.data) set({ data: res.data })
  },
  deleteAccount: async (id) => {
    const res = await invoke<DataRes>('accounts-delete', id)
    if (res.ok && res.data) set({ data: res.data })
  },

  placeOrder: async (o) => {
    set({ busy: true, error: '' })
    const res = await invoke<DataRes>('order', { ...o, accountId: get().data?.activeId })
    set({ busy: false })
    if (res.ok && res.data) {
      set({ data: res.data, status: `Filled ${o.side} ${o.qty} ${o.symbol.toUpperCase()}${res.fillPrice ? ` @ $${res.fillPrice.toFixed(2)}` : ''}.` })
      void get().pollQuotes()
      return null
    }
    set({ error: res.error ?? 'Order failed.' })
    return res.error ?? 'Order failed.'
  },

  closePosition: async (positionId, qty, price) => {
    set({ busy: true, error: '' })
    const res = await invoke<DataRes>('close', { positionId, qty, price, accountId: get().data?.activeId })
    set({ busy: false })
    if (res.ok && res.data) set({ data: res.data, status: 'Position closed.' })
    else set({ error: res.error ?? 'Close failed.' })
  },

  updatePosition: async (positionId, patch) => {
    const res = await invoke<DataRes>('update-position', { positionId, ...patch, accountId: get().data?.activeId })
    if (res.ok && res.data) set({ data: res.data })
  },

  setChartSymbol: (s) => {
    set({ chartSymbol: s.toUpperCase() })
    void get().pollQuotes()
  },
  setTimeframe: (t) => set({ timeframe: t }),
  setTab: (t) => set({ tab: t })
}))

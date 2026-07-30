import { create } from 'zustand'

const ID = 'risk-calculator'
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  window.wicked.invoke(`${ID}:${channel}`, ...args) as Promise<T>

export type Tab = 'position' | 'rr' | 'options' | 'expectancy'

export interface Inputs {
  account: string
  riskPercent: string
  // position size
  entry: string
  stop: string
  direction: 'long' | 'short'
  // risk / reward
  rrEntry: string
  rrStop: string
  rrTarget: string
  rrWinRate: string
  // options
  optType: 'call' | 'put'
  underlying: string
  strike: string
  premium: string
  contracts: string
  // expectancy
  winRate: string
  avgWin: string
  avgLoss: string
}

const DEFAULTS: Inputs = {
  account: '10000',
  riskPercent: '1',
  entry: '100',
  stop: '95',
  direction: 'long',
  rrEntry: '100',
  rrStop: '95',
  rrTarget: '115',
  rrWinRate: '50',
  optType: 'call',
  underlying: '100',
  strike: '105',
  premium: '2.50',
  contracts: '2',
  winRate: '45',
  avgWin: '2',
  avgLoss: '1'
}

interface State {
  tab: Tab
  inputs: Inputs
  loaded: boolean
  setTab: (t: Tab) => void
  set: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  load: () => Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useRisk = create<State>((setState, get) => {
  const persist = (inputs: Inputs, tab: Tab): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void invoke('set', { inputs, tab }), 400)
  }
  return {
    tab: 'position',
    inputs: DEFAULTS,
    loaded: false,

    setTab: (t) => {
      setState({ tab: t })
      persist(get().inputs, t)
    },

    set: (key, value) => {
      const inputs = { ...get().inputs, [key]: value }
      setState({ inputs })
      persist(inputs, get().tab)
    },

    load: async () => {
      const res = await invoke<{ ok: boolean; state?: { inputs?: Partial<Inputs>; tab?: Tab } }>('get')
      const saved = res?.state ?? {}
      setState({
        inputs: { ...DEFAULTS, ...(saved.inputs ?? {}) },
        tab: saved.tab ?? 'position',
        loaded: true
      })
    }
  }
})

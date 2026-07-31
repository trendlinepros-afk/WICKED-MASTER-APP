import { randomUUID } from 'crypto'
import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getSnapshot, getAggregates } from '../stock-planner/ipc/market/massive'
import { closePosition, detectExit, openPosition, type OpenOrder } from './engine'
import type { PaperAccount, PaperData } from './types'

/**
 * Paper Trading — main process. Holds the accounts, executes fills at live
 * Polygon/Massive prices, and on open reconciles resting stops/targets against
 * minute history so an exit is backdated to when the level was actually crossed.
 */
const ID = 'paper-trading'
const KEY = `${ID}.data`
const DEFAULT_BALANCE = 5000

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

interface TF {
  mult: number
  timespan: 'minute' | 'day'
  days: number
}
const TIMEFRAMES: Record<string, TF> = {
  '1D': { mult: 1, timespan: 'minute', days: 2 },
  '5D': { mult: 5, timespan: 'minute', days: 7 },
  '1M': { mult: 1, timespan: 'day', days: 40 },
  '3M': { mult: 1, timespan: 'day', days: 100 },
  '1Y': { mult: 1, timespan: 'day', days: 380 }
}

export default function register(ctx: ModuleIpcContext): void {
  const readData = (): PaperData => {
    const d = ctx.storeGet<PaperData>(KEY, { accounts: [], activeId: '' })
    const data: PaperData = { accounts: Array.isArray(d?.accounts) ? d.accounts : [], activeId: d?.activeId ?? '' }
    if (data.accounts.length === 0) {
      const now = Date.now()
      const acct: PaperAccount = {
        id: randomUUID(),
        name: 'Practice',
        startingBalance: DEFAULT_BALANCE,
        cash: DEFAULT_BALANCE,
        createdAt: now,
        lastReconciledAt: now,
        positions: [],
        closed: []
      }
      data.accounts = [acct]
      data.activeId = acct.id
      ctx.storeSet(KEY, data)
    }
    if (!data.accounts.some((a) => a.id === data.activeId)) data.activeId = data.accounts[0]?.id ?? ''
    return data
  }
  const writeData = (data: PaperData): PaperData => {
    ctx.storeSet(KEY, data)
    return data
  }
  const key = (): string | null => ctx.getApiKey('massive')

  const livePrice = async (sym: string): Promise<number | null> => {
    const k = key()
    if (!k || !sym) return null
    const s = await getSnapshot(k, sym.toUpperCase())
    const p = s?.lastTrade?.p ?? s?.min?.c ?? s?.day?.c ?? s?.prevDay?.c
    return typeof p === 'number' && p > 0 ? p : null
  }

  /* ------------------------------- accounts ------------------------------- */

  ctx.ipcMain.handle(`${ID}:get`, () => ({ ok: true, data: readData() }))

  ctx.ipcMain.handle(`${ID}:accounts-create`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const name = str(r.name).trim().slice(0, 60) || 'New account'
    const bal = num(r.startingBalance) > 0 ? num(r.startingBalance) : DEFAULT_BALANCE
    const data = readData()
    const now = Date.now()
    const acct: PaperAccount = {
      id: randomUUID(),
      name,
      startingBalance: bal,
      cash: bal,
      createdAt: now,
      lastReconciledAt: now,
      positions: [],
      closed: []
    }
    data.accounts = [...data.accounts, acct]
    data.activeId = acct.id
    return { ok: true, data: writeData(data) }
  })

  ctx.ipcMain.handle(`${ID}:accounts-rename`, (_e, id: unknown, name: unknown) => {
    const data = readData()
    const i = data.accounts.findIndex((a) => a.id === String(id))
    if (i === -1) return { ok: false, error: 'Account not found.' }
    data.accounts[i] = { ...data.accounts[i], name: str(name).trim().slice(0, 60) || data.accounts[i].name }
    return { ok: true, data: writeData(data) }
  })

  ctx.ipcMain.handle(`${ID}:accounts-delete`, (_e, id: unknown) => {
    const data = readData()
    data.accounts = data.accounts.filter((a) => a.id !== String(id))
    if (!data.accounts.some((a) => a.id === data.activeId)) data.activeId = data.accounts[0]?.id ?? ''
    writeData(data)
    return { ok: true, data: readData() } // readData re-seeds a default if we deleted the last one
  })

  ctx.ipcMain.handle(`${ID}:accounts-active`, (_e, id: unknown) => {
    const data = readData()
    if (data.accounts.some((a) => a.id === String(id))) data.activeId = String(id)
    return { ok: true, data: writeData(data) }
  })

  /* -------------------------------- pricing ------------------------------- */

  ctx.ipcMain.handle(`${ID}:quotes`, async (_e, rawSyms: unknown) => {
    const syms = [...new Set((Array.isArray(rawSyms) ? rawSyms : []).map((s) => str(s).toUpperCase()).filter(Boolean))]
    if (!key()) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys.', quotes: {} }
    const entries = await Promise.all(syms.map(async (s) => [s, await livePrice(s)] as const))
    const quotes: Record<string, number> = {}
    for (const [s, p] of entries) if (p != null) quotes[s] = p
    return { ok: true, quotes }
  })

  ctx.ipcMain.handle(`${ID}:candles`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const symbol = str(r.symbol).trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '')
    const tfKey = TIMEFRAMES[str(r.timeframe)] ? str(r.timeframe) : '1D'
    if (!symbol) return { ok: false, error: 'Enter a symbol.', bars: [] }
    const k = key()
    if (!k) return { ok: false, error: 'Add your Massive/Polygon key in Settings → API Keys.', bars: [] }
    const tf = TIMEFRAMES[tfKey]
    const to = Date.now()
    try {
      const bars = await getAggregates(k, symbol, tf.mult, tf.timespan, to - tf.days * 86_400_000, to)
      return { ok: true, bars }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), bars: [] }
    }
  })

  /* --------------------------------- orders ------------------------------- */

  const findActive = (data: PaperData, accountId?: unknown): PaperAccount | null =>
    data.accounts.find((a) => a.id === (accountId ? String(accountId) : data.activeId)) ?? null

  ctx.ipcMain.handle(`${ID}:order`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const data = readData()
    const acct = findActive(data, r.accountId)
    if (!acct) return { ok: false, error: 'No account selected.' }
    const kind = r.kind === 'option' ? 'option' : 'stock'
    const symbol = str(r.symbol).trim().toUpperCase()
    if (!symbol) return { ok: false, error: 'Enter a ticker.' }
    const side = r.side === 'short' ? 'short' : 'long'
    // options are priced manually (enter the premium); stocks fill at the live price
    let price = num(r.price)
    if (kind === 'stock') {
      const live = await livePrice(symbol)
      if (live == null) return { ok: false, error: `No live price for ${symbol} (market data unavailable).` }
      price = live
    } else if (!(price > 0)) return { ok: false, error: 'Enter the option premium.' }

    const order: OpenOrder = {
      kind,
      symbol,
      side: kind === 'option' ? 'long' : side, // options long-only in v1
      qty: Math.floor(num(r.qty)),
      price,
      stop: r.stop != null && num(r.stop) > 0 ? num(r.stop) : null,
      takeProfit: r.takeProfit != null && num(r.takeProfit) > 0 ? num(r.takeProfit) : null,
      trailingStop: r.trailingStop != null && num(r.trailingStop) > 0 ? num(r.trailingStop) : null,
      ...(kind === 'option'
        ? { optionType: r.optionType === 'put' ? 'put' : 'call', strike: num(r.strike), expiry: str(r.expiry), multiplier: 100 }
        : {})
    }
    const res = openPosition(acct, order, Date.now(), randomUUID())
    if (!res.ok || !res.account) return { ok: false, error: res.error ?? 'Order rejected.' }
    data.accounts = data.accounts.map((a) => (a.id === acct.id ? res.account! : a))
    return { ok: true, data: writeData(data), fillPrice: price }
  })

  ctx.ipcMain.handle(`${ID}:update-position`, (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const data = readData()
    const acct = findActive(data, r.accountId)
    if (!acct) return { ok: false, error: 'No account.' }
    acct.positions = acct.positions.map((p) =>
      p.id === String(r.positionId)
        ? {
            ...p,
            stop: r.stop === null ? null : num(r.stop) > 0 ? num(r.stop) : p.stop,
            takeProfit: r.takeProfit === null ? null : num(r.takeProfit) > 0 ? num(r.takeProfit) : p.takeProfit,
            trailingStop:
              r.trailingStop === null ? null : num(r.trailingStop) > 0 ? num(r.trailingStop) : p.trailingStop ?? null
          }
        : p
    )
    return { ok: true, data: writeData(data) }
  })

  ctx.ipcMain.handle(`${ID}:close`, async (_e, raw: unknown) => {
    const r = (typeof raw === 'object' && raw ? raw : {}) as Record<string, unknown>
    const data = readData()
    const acct = findActive(data, r.accountId)
    if (!acct) return { ok: false, error: 'No account.' }
    const pos = acct.positions.find((p) => p.id === String(r.positionId))
    if (!pos) return { ok: false, error: 'Position not found.' }
    let price = num(r.price)
    if (pos.kind === 'stock') {
      const live = await livePrice(pos.symbol)
      if (live == null) return { ok: false, error: `No live price for ${pos.symbol}.` }
      price = live
    } else if (!(price > 0)) return { ok: false, error: 'Enter the closing premium.' }
    const res = closePosition(acct, pos.id, price, Date.now(), 'manual', randomUUID(), num(r.qty) > 0 ? Math.floor(num(r.qty)) : undefined)
    if (!res.ok || !res.account) return { ok: false, error: res.error ?? 'Close failed.' }
    data.accounts = data.accounts.map((a) => (a.id === acct.id ? res.account! : a))
    return { ok: true, data: writeData(data), fillPrice: price }
  })

  /* ---------------------- reconcile stops/targets (backdate) -------------- */

  ctx.ipcMain.handle(`${ID}:reconcile`, async (_e, accountId: unknown) => {
    const data = readData()
    const acct = findActive(data, accountId)
    if (!acct) return { ok: true, data }
    const k = key()
    const now = Date.now()
    if (!k) return { ok: true, data } // no data key → can't check history
    let account = acct
    const toCheck = acct.positions.filter(
      (p) => p.kind === 'stock' && (p.stop != null || p.takeProfit != null || (p.trailingStop != null && p.trailingStop > 0))
    )
    let closedCount = 0
    for (const p of toCheck) {
      const from = Math.max(p.entryAt, account.lastReconciledAt || 0)
      if (now - from < 60_000) continue
      let bars
      try {
        bars = await getAggregates(k, p.symbol, 1, 'minute', from, now)
      } catch {
        continue
      }
      const hit = detectExit(p, bars)
      if (hit) {
        const res = closePosition(account, p.id, hit.price, hit.at, hit.reason, randomUUID())
        if (res.ok && res.account) {
          account = res.account
          closedCount++
        }
      }
    }
    account = { ...account, lastReconciledAt: now }
    data.accounts = data.accounts.map((a) => (a.id === account.id ? account : a))
    return { ok: true, data: writeData(data), closedCount }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    let base = ''
    try {
      base = ctx.app.getPath('userData')
    } catch {
      /* not available */
    }
    return [
      {
        label: 'Paper accounts & trades',
        path: base ? join(base, 'wicked-modules.json') : null,
        note: 'Stored under the "paper-trading.data" key. Included in Backup & Cloud Sync.'
      }
    ]
  })
}

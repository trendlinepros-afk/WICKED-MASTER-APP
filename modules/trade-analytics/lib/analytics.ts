import type { Execution, Side } from './parse'
import { etParts } from './et'

/**
 * Position matching + trade analytics (pure, unit-testable).
 *
 * Executions are grouped per symbol and replayed in fill-time order through a
 * signed-FIFO engine. A "trade" is one round-trip EPISODE: the position leaves
 * flat, takes on entries, is reduced by exits, and (usually) returns to flat.
 * An episode that never returns to flat is an OPEN position — this is how the
 * dashboard knows "there's a buy but no sell yet".
 *
 * Signed quantity: Buy = +qty, Sell = −qty, Short = −qty. A Buy that runs
 * against a short position covers it (realizing P&L) before opening any long.
 */

export interface Fill {
  side: Side
  qty: number
  price: number
  at: number | null
  hash: string
  /** account the underlying execution belongs to */
  account: string
}

export interface Trade {
  id: string
  /** account this episode's executions belong to (for edit/delete targeting) */
  account: string
  symbol: string
  name: string
  direction: 'long' | 'short'
  /** total shares opened in this episode */
  qty: number
  /** quantity already closed */
  closedQty: number
  /** quantity still open (0 = fully closed) */
  openQty: number
  isOpen: boolean
  avgEntry: number
  /** avg exit over the closed portion (0 if nothing closed yet) */
  avgExit: number
  costBasis: number
  realizedPnl: number
  /** realized P&L as % of the closed cost basis */
  realizedPct: number
  openedAt: number | null
  closedAt: number | null
  /** seconds from first entry to last exit (null while open) */
  holdSeconds: number | null
  fills: Fill[]
}

const signOf = (side: Side): 1 | -1 => (side === 'buy' ? 1 : -1)

interface Lot {
  qty: number // remaining shares (always > 0)
  price: number
  at: number | null
}

interface Episode {
  symbol: string
  name: string
  account: string
  direction: 'long' | 'short'
  lots: Lot[]
  entryQty: number
  entryCost: number // sum(price*qty) of entries
  closedQty: number
  exitProceeds: number // sum(exitPrice*qty) over closed
  realizedPnl: number
  openedAt: number | null
  closedAt: number | null
  fills: Fill[]
}

function toTrade(ep: Episode, seq: number): Trade {
  const openQty = ep.lots.reduce((n, l) => n + l.qty, 0)
  const avgEntry = ep.entryQty > 0 ? ep.entryCost / ep.entryQty : 0
  const avgExit = ep.closedQty > 0 ? ep.exitProceeds / ep.closedQty : 0
  const closedCost = avgEntry * ep.closedQty
  return {
    id: `${ep.account}-${ep.symbol}-${seq}-${ep.openedAt ?? 0}`,
    account: ep.account,
    symbol: ep.symbol,
    name: ep.name,
    direction: ep.direction,
    qty: ep.entryQty,
    closedQty: ep.closedQty,
    openQty,
    isOpen: openQty > 1e-9,
    avgEntry,
    avgExit,
    costBasis: avgEntry * ep.entryQty,
    realizedPnl: ep.realizedPnl,
    realizedPct: closedCost > 0 ? (ep.realizedPnl / closedCost) * 100 : 0,
    openedAt: ep.openedAt,
    closedAt: openQty > 1e-9 ? null : ep.closedAt,
    holdSeconds:
      openQty > 1e-9 || ep.openedAt == null || ep.closedAt == null
        ? null
        : Math.round((ep.closedAt - ep.openedAt) / 1000),
    fills: ep.fills
  }
}

/** Build round-trip trades (and open positions) from filled executions. */
export function buildTrades(executions: Execution[]): Trade[] {
  const filled = executions.filter((e) => e.filled && e.qty > 0)
  const bySymbol = new Map<string, Execution[]>()
  for (const e of filled) {
    const arr = bySymbol.get(e.symbol) ?? []
    arr.push(e)
    bySymbol.set(e.symbol, arr)
  }

  const trades: Trade[] = []
  for (const [symbol, execs] of bySymbol) {
    execs.sort((a, b) => (a.filledAt ?? 0) - (b.filledAt ?? 0) || a.hash.localeCompare(b.hash))
    let ep: Episode | null = null
    let seq = 0

    const openEpisode = (dir: 'long' | 'short', name: string, account: string): Episode => ({
      symbol,
      name,
      account,
      direction: dir,
      lots: [],
      entryQty: 0,
      entryCost: 0,
      closedQty: 0,
      exitProceeds: 0,
      realizedPnl: 0,
      openedAt: null,
      closedAt: null,
      fills: []
    })

    for (const e of execs) {
      let remaining = e.qty
      const dirOfExec = signOf(e.side) === 1 ? 'long' : 'short'

      // If flat, this fill opens a new episode in its own direction.
      if (!ep) {
        ep = openEpisode(dirOfExec, e.name, e.account ?? 'default')
        ep.openedAt = e.filledAt
      }

      const posSign = ep.direction === 'long' ? 1 : -1
      const execSign = signOf(e.side)
      ep.fills.push({ side: e.side, qty: e.qty, price: e.price, at: e.filledAt, hash: e.hash, account: e.account ?? 'default' })

      if (execSign === posSign) {
        // Adding to the position (entry).
        ep.lots.push({ qty: remaining, price: e.price, at: e.filledAt })
        ep.entryQty += remaining
        ep.entryCost += remaining * e.price
        if (ep.openedAt == null) ep.openedAt = e.filledAt
      } else {
        // Reducing the position (exit), FIFO across lots.
        while (remaining > 1e-9 && ep.lots.length > 0) {
          const lot = ep.lots[0]
          const m = Math.min(remaining, lot.qty)
          // long: (exit - entry); short: (entry - exit) === (entry-exit)
          const pnl = ep.direction === 'long' ? (e.price - lot.price) * m : (lot.price - e.price) * m
          ep.realizedPnl += pnl
          ep.closedQty += m
          ep.exitProceeds += m * e.price
          ep.closedAt = e.filledAt
          lot.qty -= m
          remaining -= m
          if (lot.qty <= 1e-9) ep.lots.shift()
        }
        // Episode fully closed → emit; any leftover opens a new opposite episode.
        if (ep.lots.length === 0) {
          trades.push(toTrade(ep, seq++))
          ep = null
          if (remaining > 1e-9) {
            ep = openEpisode(dirOfExec, e.name, e.account ?? 'default')
            ep.openedAt = e.filledAt
            ep.lots.push({ qty: remaining, price: e.price, at: e.filledAt })
            ep.entryQty += remaining
            ep.entryCost += remaining * e.price
          }
        }
      }
    }
    if (ep) trades.push(toTrade(ep, seq++)) // still-open position
  }

  // newest first by close (open trades — null close — sort to top)
  trades.sort((a, b) => (b.closedAt ?? Infinity) - (a.closedAt ?? Infinity))
  return trades
}

/**
 * Build trades across MULTIPLE accounts without letting them mix: each
 * account's executions are FIFO-matched independently (a buy in account A must
 * never close a short in account B), then the resulting trades are merged. When
 * only one account is present this is identical to buildTrades.
 */
export function buildTradesByAccount(executions: Execution[]): Trade[] {
  const byAccount = new Map<string, Execution[]>()
  for (const e of executions) {
    const acct = e.account || 'default'
    const arr = byAccount.get(acct) ?? []
    arr.push(e)
    byAccount.set(acct, arr)
  }
  if (byAccount.size <= 1) return buildTrades(executions)
  const all: Trade[] = []
  for (const execs of byAccount.values()) all.push(...buildTrades(execs))
  all.sort((a, b) => (b.closedAt ?? Infinity) - (a.closedAt ?? Infinity))
  return all
}

/* --------------------------------- stats --------------------------------- */

export interface SymbolStat {
  symbol: string
  name: string
  trades: number
  realizedPnl: number
  wins: number
  losses: number
  volume: number
  openQty: number
}

export interface EquityPoint {
  at: number
  pnl: number
  cumulative: number
  symbol: string
}

export interface Bucket {
  label: string
  pnl: number
  trades: number
  wins: number
}

export interface Stats {
  totalRealized: number
  closedTrades: number
  openTrades: number
  wins: number
  losses: number
  breakeven: number
  winRate: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  expectancy: number
  largestWin: number
  largestLoss: number
  grossProfit: number
  grossLoss: number
  avgHoldSeconds: number
  totalVolume: number
  sharesTraded: number
  longPnl: number
  shortPnl: number
  longTrades: number
  shortTrades: number
  openCostBasis: number
  bestSymbol: SymbolStat | null
  worstSymbol: SymbolStat | null
  maxWinStreak: number
  maxLossStreak: number
  equityCurve: EquityPoint[]
  bySymbol: SymbolStat[]
  byDayOfWeek: Bucket[]
  byHour: Bucket[]
  byDay: Bucket[]
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function computeStats(trades: Trade[]): Stats {
  const closed = trades.filter((t) => !t.isOpen && t.closedQty > 0)
  const open = trades.filter((t) => t.isOpen)
  // realized order = by close time ascending, for streaks + equity curve
  const closedAsc = [...closed].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))

  let grossProfit = 0
  let grossLoss = 0
  let wins = 0
  let losses = 0
  let breakeven = 0
  let largestWin = 0
  let largestLoss = 0
  let holdSum = 0
  let holdCount = 0
  let longPnl = 0
  let shortPnl = 0
  let longTrades = 0
  let shortTrades = 0
  let maxWinStreak = 0
  let maxLossStreak = 0
  let curWin = 0
  let curLoss = 0

  const symMap = new Map<string, SymbolStat>()
  const dowMap = new Map<number, Bucket>()
  const hourMap = new Map<number, Bucket>()
  const dayMap = new Map<string, Bucket>()
  const equityCurve: EquityPoint[] = []
  let cumulative = 0

  const bump = (
    map: Map<number | string, Bucket>,
    key: number | string,
    label: string,
    pnl: number
  ): void => {
    const b = map.get(key) ?? { label, pnl: 0, trades: 0, wins: 0 }
    b.pnl += pnl
    b.trades += 1
    if (pnl > 0) b.wins += 1
    map.set(key, b)
  }

  for (const t of closedAsc) {
    const pnl = t.realizedPnl
    if (pnl > 1e-6) {
      wins++
      grossProfit += pnl
      largestWin = Math.max(largestWin, pnl)
      curWin++
      curLoss = 0
      maxWinStreak = Math.max(maxWinStreak, curWin)
    } else if (pnl < -1e-6) {
      losses++
      grossLoss += -pnl
      largestLoss = Math.min(largestLoss, pnl)
      curLoss++
      curWin = 0
      maxLossStreak = Math.max(maxLossStreak, curLoss)
    } else breakeven++

    if (t.direction === 'long') {
      longPnl += pnl
      longTrades++
    } else {
      shortPnl += pnl
      shortTrades++
    }
    if (t.holdSeconds != null) {
      holdSum += t.holdSeconds
      holdCount++
    }

    const s = symMap.get(t.symbol) ?? {
      symbol: t.symbol,
      name: t.name,
      trades: 0,
      realizedPnl: 0,
      wins: 0,
      losses: 0,
      volume: 0,
      openQty: 0
    }
    s.trades++
    s.realizedPnl += pnl
    if (pnl > 0) s.wins++
    else if (pnl < 0) s.losses++
    s.volume += t.costBasis
    symMap.set(t.symbol, s)

    if (t.closedAt != null) {
      // group by ET (market clock) so results don't depend on the host TZ and
      // match the Breakdown/Calendar tabs (the UI labels these "ET")
      const p = etParts(t.closedAt)
      bump(dowMap as Map<number | string, Bucket>, p.dow, DOW[p.dow], pnl)
      bump(hourMap as Map<number | string, Bucket>, p.hour, `${p.hour}:00`, pnl)
      bump(dayMap as Map<number | string, Bucket>, p.ymd, p.ymd, pnl)
      cumulative += pnl
      equityCurve.push({ at: t.closedAt, pnl, cumulative, symbol: t.symbol })
    }
  }

  // fold open positions into per-symbol view (open qty + cost basis)
  let openCostBasis = 0
  for (const t of open) {
    openCostBasis += t.avgEntry * t.openQty
    const s = symMap.get(t.symbol) ?? {
      symbol: t.symbol,
      name: t.name,
      trades: 0,
      realizedPnl: 0,
      wins: 0,
      losses: 0,
      volume: 0,
      openQty: 0
    }
    s.openQty += t.openQty
    symMap.set(t.symbol, s)
  }

  const totalRealized = grossProfit - grossLoss
  const totalVolume = [...symMap.values()].reduce((n, s) => n + s.volume, 0)
  const sharesTraded = trades.reduce((n, t) => n + t.qty, 0)
  const bySymbol = [...symMap.values()].sort((a, b) => b.realizedPnl - a.realizedPnl)
  const withTrades = bySymbol.filter((s) => s.trades > 0)

  return {
    totalRealized,
    closedTrades: closed.length,
    openTrades: open.length,
    wins,
    losses,
    breakeven,
    winRate: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    avgWin: wins > 0 ? grossProfit / wins : 0,
    avgLoss: losses > 0 ? -(grossLoss / losses) : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: closed.length > 0 ? totalRealized / closed.length : 0,
    largestWin,
    largestLoss,
    grossProfit,
    grossLoss,
    avgHoldSeconds: holdCount > 0 ? holdSum / holdCount : 0,
    totalVolume,
    sharesTraded,
    longPnl,
    shortPnl,
    longTrades,
    shortTrades,
    openCostBasis,
    bestSymbol: withTrades.length > 0 ? withTrades[0] : null,
    worstSymbol: withTrades.length > 0 ? withTrades[withTrades.length - 1] : null,
    maxWinStreak,
    maxLossStreak,
    equityCurve,
    bySymbol,
    byDayOfWeek: [0, 1, 2, 3, 4, 5, 6]
      .map((d) => dowMap.get(d))
      .filter((b): b is Bucket => !!b),
    byHour: [...Array(24).keys()].map((h) => hourMap.get(h)).filter((b): b is Bucket => !!b),
    byDay: [...dayMap.values()].sort((a, b) => (a.label < b.label ? -1 : 1))
  }
}

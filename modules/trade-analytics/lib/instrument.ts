/**
 * Instrument helpers for charting a trade (pure): which market-data ticker to
 * ask for, sensible price precision, the unit a quantity is in, and which
 * candle interval / time window to show around a trade.
 */
import { futuresRoot, isForexInstrument } from './parse'

/* ------------------------------ tickers ------------------------------ */

const MONTH_CODES = 'FGHJKMNQUVXZ'
const MON3 = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Yahoo exchange suffix for a specific futures contract ("ESZ26.CME"). */
const EXCHANGE: Record<string, string> = {}
for (const r of ['ES', 'MES', 'NQ', 'MNQ', 'RTY', 'M2K', 'EMD', 'NKD', '6E', '6B', '6J', '6A', '6C', '6S', '6N', '6M', 'M6E', 'M6A', 'M6B', 'BTC', 'MBT', 'ETH', 'MET', 'HE', 'LE', 'GF'])
  EXCHANGE[r] = 'CME'
for (const r of ['YM', 'MYM', 'ZB', 'ZN', 'ZF', 'ZT', 'UB', 'TN', 'ZC', 'ZS', 'ZW', 'ZM', 'ZL', 'ZO', 'KE', 'ZR']) EXCHANGE[r] = 'CBT'
for (const r of ['CL', 'MCL', 'QM', 'HO', 'RB', 'NG', 'QG', 'BZ', 'PL', 'PA']) EXCHANGE[r] = 'NYM'
for (const r of ['GC', 'MGC', 'SI', 'SIL', 'QI', 'HG', 'MHG', 'QC']) EXCHANGE[r] = 'CMX'

export interface FuturesContract {
  root: string
  monthCode: string
  year: number
}

/** "MNQZ6", "ESZ25", "MES 09-26", "MES SEP26" → root + month code + full year. */
export function futuresContract(symbol: string, now = Date.now()): FuturesContract | null {
  const s = symbol.trim().toUpperCase()
  const root = futuresRoot(s)
  if (!root) return null
  const cur = new Date(now).getFullYear()
  const fullYear = (y: string): number => {
    if (y.length >= 4) return Number(y)
    if (y.length === 2) return 2000 + Number(y)
    let yr = Math.floor(cur / 10) * 10 + Number(y) // one digit: nearest decade
    if (yr < cur - 2) yr += 10
    return yr
  }
  const code = s.startsWith(root) ? /^([FGHJKMNQUVXZ])(\d{1,2})$/.exec(s.slice(root.length)) : null
  if (code) return { root, monthCode: code[1], year: fullYear(code[2]) }
  const dash = /\s(\d{2})-(\d{2})$/.exec(s)
  if (dash) return { root, monthCode: MONTH_CODES[Number(dash[1]) - 1] ?? 'H', year: fullYear(dash[2]) }
  const named = /\s(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?(\d{2,4})$/.exec(s)
  if (named) return { root, monthCode: MONTH_CODES[MON3.indexOf(named[1])], year: fullYear(named[2]) }
  return { root, monthCode: '', year: cur }
}

const CRYPTO = /^(BTC|ETH|SOL|XRP|DOGE|ADA|LTC|AVAX|DOT|LINK|BNB|MATIC|SHIB|BCH|XLM|UNI|ATOM|TRX)[-/]?(USD|USDT|USDC)$/

/**
 * Yahoo Finance tickers to try for a traded symbol, best first. Futures try
 * the exact contract, then the continuous front month; FX uses "=X".
 */
export function marketTickers(symbol: string, now = Date.now()): { tickers: string[]; kind: 'future' | 'forex' | 'crypto' | 'stock' } {
  const raw = symbol.trim().toUpperCase().replace(/^[A-Z_]+:/, '') // strip "NASDAQ:" / "CME_MINI:" prefixes
  const fut = futuresContract(raw, now)
  if (fut) {
    const ex = EXCHANGE[fut.root]
    const exact = fut.monthCode && ex ? [`${fut.root}${fut.monthCode}${String(fut.year).slice(-2)}.${ex}`] : []
    return { tickers: [...exact, `${fut.root}=F`], kind: 'future' }
  }
  if (isForexInstrument(raw)) return { tickers: [`${raw.replace(/[/_\-.]/g, '')}=X`], kind: 'forex' }
  const c = CRYPTO.exec(raw)
  if (c) return { tickers: [`${c[1]}-USD`], kind: 'crypto' }
  return { tickers: [raw.replace(/\./g, '-')], kind: 'stock' }
}

/* ----------------------------- formatting ----------------------------- */

function decimalsOf(n: number): number {
  const s = String(Number(n.toFixed(6)))
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** Decimals to show prices with: 5 for FX (3 for JPY pairs), else what the fills use. */
export function priceDecimals(symbol: string, prices: number[]): number {
  const up = symbol.toUpperCase().replace(/[/_\-.]/g, '')
  if (isForexInstrument(up)) return up.endsWith('JPY') ? 3 : 5
  const seen = prices.filter((p) => Number.isFinite(p) && p > 0).reduce((d, p) => Math.max(d, decimalsOf(p)), 0)
  if (futuresRoot(symbol.toUpperCase())) return Math.min(seen, 5)
  return Math.min(Math.max(seen, 2), 4)
}

export function fmtPrice(p: number, decimals: number): string {
  if (!Number.isFinite(p)) return '—'
  return p.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** "lots" / "units" (FX), "contracts" (futures), "sh" (stocks). */
export function qtyUnit(symbol: string, multiplier: number, qty: number): string {
  if (isForexInstrument(symbol)) return multiplier >= 1000 ? (qty === 1 ? 'lot' : 'lots') : 'units'
  if (futuresRoot(symbol.toUpperCase())) return qty === 1 ? 'contract' : 'contracts'
  return 'sh'
}

/** A move in price units → "12.5 pts", or "8.3 pips" for FX. */
export function fmtMove(symbol: string, pts: number, decimals: number): string {
  const up = symbol.toUpperCase().replace(/[/_\-.]/g, '')
  const sign = pts > 0 ? '+' : pts < 0 ? '−' : ''
  if (isForexInstrument(up)) {
    const pip = up.endsWith('JPY') ? 0.01 : 0.0001
    return `${sign}${Math.abs(pts / pip).toFixed(1)} pips`
  }
  return `${sign}${Math.abs(pts).toFixed(Math.min(decimals, 2))} pts`
}

/* ------------------------------ intervals ------------------------------ */

export interface Candle {
  /** bar start, epoch ms */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type Interval = '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '1d'
export const INTERVALS: Interval[] = ['1m', '2m', '5m', '15m', '30m', '60m', '1d']
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '60m': 3_600_000,
  '1d': 86_400_000
}
const DAY = 86_400_000

/** Intervals Yahoo serves for data starting at `from` (1m: last ~30 days; intraday: ~60; hourly: ~2 years). */
export function allowedIntervals(from: number, to: number, now = Date.now()): Interval[] {
  const age = now - from
  return INTERVALS.filter((iv) => {
    if (iv === '1m') return age < 29 * DAY && to - from <= 7 * DAY
    if (iv === '60m') return age < 725 * DAY
    if (iv === '1d') return true
    return age < 58 * DAY
  })
}

export type Context = 'tight' | 'normal' | 'wide'

/** Time window to fetch/show for a trade at an interval. */
export function chartWindow(openedAt: number, closedAt: number, interval: Interval, context: Context): { from: number; to: number } {
  const span = Math.max(0, closedAt - openedAt)
  const bars = { tight: 10, normal: 25, wide: 70 }[context]
  const frac = { tight: 0.25, normal: 0.6, wide: 1.5 }[context]
  const pad = Math.max(span * frac, bars * INTERVAL_MS[interval])
  return { from: openedAt - pad, to: closedAt + pad }
}

/** Pick an interval that shows the trade with enough bars, within what's available. */
export function autoInterval(openedAt: number, closedAt: number, now = Date.now()): Interval {
  const span = Math.max(0, closedAt - openedAt)
  const want: Interval = span < 40 * 60_000 ? '1m' : span < 3 * 3600_000 ? '5m' : span < 12 * 3600_000 ? '15m' : span < 5 * DAY ? '60m' : '1d'
  const order = INTERVALS.slice(INTERVALS.indexOf(want))
  for (const iv of order) {
    const w = chartWindow(openedAt, closedAt, iv, 'normal')
    if (allowedIntervals(w.from, w.to, now).includes(iv)) return iv
  }
  return '1d'
}

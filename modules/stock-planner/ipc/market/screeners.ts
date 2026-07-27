/**
 * Screeners — ported gating + filter rules:
 *  - Pre-market gainers: only 4:00–9:30 ET; ref = prev close; requires
 *    day volume == 0 (regular session hasn't traded yet).
 *  - After-hours gainers: blocked during pre/regular; ref = today's close.
 *  - Daily gainers: always available.
 *  - Period gainers 7/30/182/365d: whole-market grouped closes, walking back
 *    up to 6 days on each end to land on real trading days.
 *  - Filters: price >= $1; volume >= 1,000 (extended) / 50,000 (daily+period).
 */

import { getFullSnapshot, getGroupedDaily } from './massive'
import { marketSession, etTodayYmd, etYmdDaysAgo } from './sessions'

export interface ScreenerRow {
  symbol: string
  price: number
  changePct: number
  volume: number
}

export interface ScreenerResult {
  ok: boolean
  rows: ScreenerRow[]
  /** why the screener is unavailable right now (session gating) */
  reason?: string
}

const MIN_PRICE = 1
const MIN_VOL_EXTENDED = 1_000
const MIN_VOL_DAILY = 50_000
const TOP = 25

const real = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export async function preMarketGainers(massiveKey: string): Promise<ScreenerResult> {
  if (marketSession() !== 'premarket')
    return { ok: false, rows: [], reason: 'Pre-market gainers only run 4:00–9:30 AM ET on trading days.' }
  const rows: ScreenerRow[] = []
  for (const t of await getFullSnapshot(massiveKey)) {
    const price = t.min?.c ?? t.lastTrade?.p
    const ref = t.prevDay?.c
    const vol = t.min?.av
    if (!real(price) || !real(ref) || !real(vol)) continue
    if (real(t.day?.v)) continue // regular session already traded -> not pre-market
    if (price < MIN_PRICE || vol < MIN_VOL_EXTENDED) continue
    rows.push({ symbol: t.ticker, price, changePct: ((price - ref) / ref) * 100, volume: vol })
  }
  return { ok: true, rows: rows.sort((a, b) => b.changePct - a.changePct).slice(0, TOP) }
}

export async function afterHoursGainers(massiveKey: string): Promise<ScreenerResult> {
  const s = marketSession()
  if (s === 'premarket' || s === 'regular')
    return { ok: false, rows: [], reason: 'After-hours gainers run after the 4:00 PM ET close.' }
  const rows: ScreenerRow[] = []
  for (const t of await getFullSnapshot(massiveKey)) {
    const price = t.min?.c ?? t.lastTrade?.p
    const ref = t.day?.c // today's close is the reference
    const vol = t.min?.av
    if (!real(price) || !real(ref) || !real(vol)) continue
    if (price < MIN_PRICE || vol < MIN_VOL_EXTENDED) continue
    rows.push({ symbol: t.ticker, price, changePct: ((price - ref) / ref) * 100, volume: vol })
  }
  return { ok: true, rows: rows.sort((a, b) => b.changePct - a.changePct).slice(0, TOP) }
}

export async function dailyGainers(massiveKey: string): Promise<ScreenerResult> {
  const rows: ScreenerRow[] = []
  for (const t of await getFullSnapshot(massiveKey)) {
    const price = t.day?.c ?? t.lastTrade?.p ?? t.prevDay?.c
    const pct = t.todaysChangePerc
    const vol = t.day?.v
    if (!real(price) || typeof pct !== 'number' || !Number.isFinite(pct) || !real(vol)) continue
    if (price < MIN_PRICE || vol < MIN_VOL_DAILY) continue
    rows.push({ symbol: t.ticker, price, changePct: pct, volume: vol })
  }
  return { ok: true, rows: rows.sort((a, b) => b.changePct - a.changePct).slice(0, TOP) }
}

/** Find a grouped-daily date with data, walking back up to 6 calendar days. */
async function groupedNear(
  massiveKey: string,
  startDaysAgo: number
): Promise<Map<string, { c: number; v: number }> | null> {
  for (let back = 0; back <= 6; back++) {
    const ymd = startDaysAgo + back === 0 ? etTodayYmd() : etYmdDaysAgo(startDaysAgo + back)
    const rows = await getGroupedDaily(massiveKey, ymd)
    if (rows.length > 0) return new Map(rows.map((r) => [r.T, { c: r.c, v: r.v }]))
  }
  return null
}

export async function periodGainers(massiveKey: string, days: 7 | 30 | 182 | 365): Promise<ScreenerResult> {
  const [now, past] = await Promise.all([groupedNear(massiveKey, 0), groupedNear(massiveKey, days)])
  if (!now || !past)
    return { ok: false, rows: [], reason: 'No market data available for that period yet.' }
  const rows: ScreenerRow[] = []
  for (const [sym, cur] of now) {
    const old = past.get(sym)
    if (!old || !real(cur.c) || !real(old.c)) continue
    if (cur.c < MIN_PRICE || !real(cur.v) || cur.v < MIN_VOL_DAILY) continue
    rows.push({ symbol: sym, price: cur.c, changePct: ((cur.c - old.c) / old.c) * 100, volume: cur.v })
  }
  return { ok: true, rows: rows.sort((a, b) => b.changePct - a.changePct).slice(0, TOP) }
}

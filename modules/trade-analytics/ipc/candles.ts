/**
 * Price candles around a trade, from Yahoo Finance's public chart endpoint
 * (no key; covers futures, FX, crypto and stocks incl. extended hours).
 * No Electron imports — fetch is injectable for headless tests.
 */
import { INTERVAL_MS, marketTickers, type Candle, type Interval } from '../lib/instrument'

export type { Candle }

export interface CandleResult {
  ok: boolean
  candles: Candle[]
  ticker: string
  interval: Interval
  /** shown under the chart (data source, caveats) */
  note: string
  /** the candles don't bracket the fill prices (e.g. a different contract month) */
  mismatch?: boolean
  error?: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

interface YahooChart {
  chart?: {
    result?: {
      meta?: { symbol?: string; exchangeName?: string; instrumentType?: string }
      timestamp?: number[]
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] }
    }[]
    error?: { code?: string; description?: string } | null
  }
}

export function parseYahooChart(j: YahooChart): Candle[] {
  const r = j.chart?.result?.[0]
  const ts = r?.timestamp ?? []
  const q = r?.indicators?.quote?.[0] ?? {}
  const out: Candle[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const c = q.close?.[i]
    if (o == null || h == null || l == null || c == null || !Number.isFinite(o + h + l + c)) continue
    out.push({ t: ts[i] * 1000, o, h, l, c, v: q.volume?.[i] ?? 0 })
  }
  return out
}

export async function yahooCandles(ticker: string, from: number, to: number, interval: Interval, fetchFn: Fetch = fetch): Promise<Candle[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${Math.floor(from / 1000)}&period2=${Math.ceil(to / 1000)}&interval=${interval}&includePrePost=true&events=`
  const resp = await fetchFn(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
  let j: YahooChart = {}
  try {
    j = (await resp.json()) as YahooChart
  } catch {
    /* non-JSON */
  }
  if (!resp.ok || j.chart?.error) throw new Error(j.chart?.error?.description || `HTTP ${resp.status}`)
  return parseYahooChart(j)
}

/** Do these candles plausibly contain the traded prices around the fill time? */
function brackets(candles: Candle[], refPrice: number, refFrom: number, refTo: number, intervalMs: number): boolean {
  if (!(refPrice > 0)) return true
  const near = candles.filter((c) => c.t + intervalMs >= refFrom - 30 * intervalMs && c.t <= refTo + 30 * intervalMs)
  const pool = near.length ? near : candles
  if (!pool.length) return false
  const lo = Math.min(...pool.map((c) => c.l))
  const hi = Math.max(...pool.map((c) => c.h))
  const slack = (hi - lo) * 0.5 + refPrice * 0.002
  return refPrice >= lo - slack && refPrice <= hi + slack
}

const cache = new Map<string, { at: number; candles: Candle[] }>()

export async function tradeCandles(
  req: { symbol: string; from: number; to: number; interval: Interval; refPrice: number; refFrom: number; refTo: number },
  fetchFn: Fetch = fetch,
  now = Date.now()
): Promise<CandleResult> {
  const { tickers, kind } = marketTickers(req.symbol, now)
  const ivMs = INTERVAL_MS[req.interval]
  const errors: string[] = []
  let fallback: { ticker: string; candles: Candle[] } | null = null

  for (const ticker of tickers) {
    const key = `${ticker}|${req.interval}|${Math.floor(req.from / ivMs)}|${Math.floor(req.to / ivMs)}`
    const hit = cache.get(key)
    // recent windows can still grow a bar or two; old ones never change
    const ttl = now - req.to < 2 * 3600_000 ? 60_000 : 24 * 3600_000
    let candles: Candle[]
    if (hit && now - hit.at < ttl) candles = hit.candles
    else {
      try {
        candles = await yahooCandles(ticker, req.from, req.to, req.interval, fetchFn)
        cache.set(key, { at: now, candles })
        if (cache.size > 200) cache.delete(cache.keys().next().value as string)
      } catch (err) {
        errors.push(`${ticker}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
    }
    if (!candles.length) {
      errors.push(`${ticker}: no bars in that window`)
      continue
    }
    if (brackets(candles, req.refPrice, req.refFrom, req.refTo, ivMs)) {
      const cont = ticker.endsWith('=F')
      return {
        ok: true,
        candles,
        ticker,
        interval: req.interval,
        note: `${req.interval} candles · Yahoo Finance (${ticker}${cont ? ', continuous front month' : ''})`
      }
    }
    fallback ??= { ticker, candles }
  }

  if (fallback)
    return {
      ok: true,
      candles: fallback.candles,
      ticker: fallback.ticker,
      interval: req.interval,
      mismatch: true,
      note: `${req.interval} candles · Yahoo Finance (${fallback.ticker}) — prices don't line up with your fills${
        kind === 'future' ? ' (likely a different contract month than the one you traded)' : ''
      }`
    }
  return {
    ok: false,
    candles: [],
    ticker: tickers[0] ?? req.symbol,
    interval: req.interval,
    note: '',
    error: errors.length ? `No market data for ${req.symbol} — ${errors.join(' · ')}` : `No market data for ${req.symbol}.`
  }
}

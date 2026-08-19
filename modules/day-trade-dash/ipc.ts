import { join } from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { getAggregates, getFullSnapshot, getMarketNews, getSnapshot, searchTickers } from '../stock-planner/ipc/market/massive'
import { resolveQuote } from '../stock-planner/ipc/market/quotes'
import { etParts, marketSession } from '../stock-planner/ipc/market/sessions'
import {
  CHART_TFS,
  DEFAULT_TV_URL,
  LEGACY_TV_URL,
  defaultState,
  type ChartTf,
  type DashQuote,
  type DashState,
  type SessionInfo,
  type WatchEntry
} from './types'

/* ------------------------------------------------------------------------ *
 *  DAY TRADE DASH — main process.
 *
 *  Thin data plumbing for the all-day dashboard: persisted layout state
 *  (chart tickers/timeframes, watchlist, tape symbols, TV url — all in the
 *  shared module store, so Backup & Cloud Sync carry the whole setup),
 *  candles + live quotes from Massive/Polygon, market-wide news, and the ET
 *  session clock. All market calls are fail-soft like the rest of the suite.
 * ------------------------------------------------------------------------ */

const ID = 'day-trade-dash'
const KEY = `${ID}.state`
const MAX_WATCH = 100
const MAX_TAPE = 40

const TF: Record<ChartTf, { mult: number; timespan: 'minute' | 'hour' | 'day'; days: number }> = {
  '1m': { mult: 1, timespan: 'minute', days: 2 },
  '5m': { mult: 5, timespan: 'minute', days: 7 },
  '15m': { mult: 15, timespan: 'minute', days: 12 },
  '1h': { mult: 1, timespan: 'hour', days: 60 },
  '4h': { mult: 4, timespan: 'hour', days: 150 },
  D: { mult: 1, timespan: 'day', days: 380 }
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

const cleanSym = (v: unknown): string =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, '')
    .slice(0, 10)

const cleanTf = (v: unknown, fb: ChartTf): ChartTf => (CHART_TFS.includes(v as ChartTf) ? (v as ChartTf) : fb)

const cleanSyms = (v: unknown, cap: number): string[] => [
  ...new Set((Array.isArray(v) ? v : []).map(cleanSym).filter(Boolean))
].slice(0, cap)

/** Watch entries — accepts the old plain-string layout and migrates it. */
const cleanWatch = (v: unknown): WatchEntry[] => {
  const out: WatchEntry[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(v) ? v : []) {
    const r = asRecord(raw)
    const symbol = cleanSym(typeof raw === 'string' ? raw : r.symbol)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    const price = Number(r.addedPrice)
    out.push({
      symbol,
      addedAt: Number(r.addedAt) > 0 ? Number(r.addedAt) : 0,
      addedPrice: Number.isFinite(price) && price > 0 ? price : null
    })
    if (out.length >= MAX_WATCH) break
  }
  return out
}

/** Merge any stored/patched shape into a fully-valid DashState. */
function sanitize(raw: unknown): DashState {
  const d = defaultState()
  const r = asRecord(raw)
  const charts = (Array.isArray(r.charts) ? r.charts : []).slice(0, 3).map((c, i) => {
    const cc = asRecord(c)
    return { symbol: cleanSym(cc.symbol) || d.charts[i]?.symbol || 'SPY', tf: cleanTf(cc.tf, d.charts[i]?.tf ?? '5m') }
  })
  while (charts.length < 3) charts.push({ ...d.charts[charts.length] })
  const watch = 'watch' in r ? cleanWatch(r.watch) : d.watch
  let tvUrl = typeof r.tvUrl === 'string' && /^https:\/\//i.test(r.tvUrl.trim()) ? r.tvUrl.trim().slice(0, 500) : d.tvUrl
  if (tvUrl === LEGACY_TV_URL) tvUrl = DEFAULT_TV_URL // pre-always-on default (muted autoplay) → play-on-demand
  // selected may be ANY symbol (a watchlist row or a clicked top-mover)
  const selected = cleanSym(r.selected) || watch[0]?.symbol || ''
  return {
    charts,
    watch,
    selected,
    selectedTf: cleanTf(r.selectedTf, d.selectedTf),
    tape: 'tape' in r ? cleanSyms(r.tape, MAX_TAPE) : d.tape,
    tvUrl,
    tvOn: r.tvOn === true
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const readState = (): DashState => sanitize(ctx.storeGet<unknown>(KEY, null) ?? defaultState())
  const writeState = (s: DashState): DashState => {
    ctx.storeSet(KEY, s)
    return s
  }
  const key = (): string | null => ctx.getApiKey('massive')
  const NO_KEY = 'Add your Massive/Polygon key in Settings → API Keys.'

  ctx.ipcMain.handle(`${ID}:state-get`, () => ({ ok: true, state: readState() }))

  /** Patch any subset of the state; the whole thing is sanitized on write. */
  ctx.ipcMain.handle(`${ID}:state-set`, (_e, raw: unknown) => {
    const next = sanitize({ ...readState(), ...asRecord(raw) })
    return { ok: true, state: writeState(next) }
  })

  ctx.ipcMain.handle(`${ID}:watch-add`, async (_e, raw: unknown) => {
    const sym = cleanSym(asRecord(raw).symbol)
    if (!sym) return { ok: false, error: 'Enter a ticker.' }
    // capture the add-time price FIRST (the "% since added" anchor) — state is
    // read after the await so a concurrent write isn't clobbered
    let addedPrice: number | null = null
    const k = key()
    if (k) {
      const snap = await getSnapshot(k, sym).catch(() => null)
      const q = snap ? resolveQuote(snap, snap.prevDay ?? null) : null
      addedPrice = q?.price ?? null
    }
    const s = readState()
    if (!s.watch.some((w) => w.symbol === sym))
      s.watch = [...s.watch, { symbol: sym, addedAt: Date.now(), addedPrice }].slice(0, MAX_WATCH)
    if (!s.selected) s.selected = sym
    return { ok: true, state: writeState(s) }
  })

  ctx.ipcMain.handle(`${ID}:watch-remove`, (_e, raw: unknown) => {
    const sym = cleanSym(asRecord(raw).symbol)
    const s = readState()
    s.watch = s.watch.filter((w) => w.symbol !== sym)
    if (s.selected === sym) s.selected = s.watch[0]?.symbol ?? ''
    return { ok: true, state: writeState(s) }
  })

  /**
   * Backfill a missing "% since added" anchor with the first price seen —
   * covers entries added while market data was down and layouts migrated from
   * the pre-anchor version. Never overwrites an existing anchor.
   */
  ctx.ipcMain.handle(`${ID}:watch-anchor`, (_e, raw: unknown) => {
    const r = asRecord(raw)
    const sym = cleanSym(r.symbol)
    const price = Number(r.price)
    const s = readState()
    const w = s.watch.find((x) => x.symbol === sym)
    if (!w || w.addedPrice != null || !(Number.isFinite(price) && price > 0)) return { ok: true, state: s }
    w.addedPrice = price
    if (!w.addedAt) w.addedAt = Date.now()
    return { ok: true, state: writeState(s) }
  })

  /* ------------------------------ market data ----------------------------- */

  ctx.ipcMain.handle(`${ID}:bars`, async (_e, raw: unknown) => {
    const r = asRecord(raw)
    const symbol = cleanSym(r.symbol)
    const tf = cleanTf(r.tf, '5m')
    if (!symbol) return { ok: false, error: 'Enter a ticker.', bars: [] }
    const k = key()
    if (!k) return { ok: false, error: NO_KEY, bars: [] }
    const def = TF[tf]
    const to = Date.now()
    try {
      const bars = await getAggregates(k, symbol, def.mult, def.timespan, to - def.days * 86_400_000, to)
      return { ok: true, bars }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), bars: [] }
    }
  })

  ctx.ipcMain.handle(`${ID}:quotes`, async (_e, raw: unknown) => {
    const syms = cleanSyms(asRecord(raw).symbols, 60)
    const k = key()
    if (!k) return { ok: false, error: NO_KEY, quotes: {} }
    const entries = await Promise.all(
      syms.map(async (sym): Promise<[string, DashQuote] | null> => {
        const snap = await getSnapshot(k, sym)
        if (!snap) return null
        const q = resolveQuote(snap, snap.prevDay ?? null)
        return q.price == null ? null : [sym, { price: q.price, changePct: q.changePct }]
      })
    )
    const quotes: Record<string, DashQuote> = {}
    for (const e of entries) if (e) quotes[e[0]] = e[1]
    return { ok: true, quotes }
  })

  /** Day's top gainers/losers from the whole-market snapshot (20s-cached in
   *  the shared client, with an EOD fallback off-hours). Penny/illiquid noise
   *  is filtered so the cards show tradeable movers. */
  ctx.ipcMain.handle(`${ID}:movers`, async () => {
    const k = key()
    if (!k) return { ok: false, error: NO_KEY, gainers: [], losers: [] }
    try {
      const rows = await getFullSnapshot(k)
      const rated: { symbol: string; price: number; changePct: number }[] = []
      for (const r of rows) {
        if (!/^[A-Z]{1,5}$/.test(r.ticker)) continue // skip warrants/units/odd classes
        const q = resolveQuote(r, r.prevDay ?? null)
        if (q.price == null || q.price < 1 || q.changePct == null) continue
        if ((q.volume ?? 0) < 100_000) continue
        rated.push({ symbol: r.ticker, price: q.price, changePct: q.changePct })
      }
      rated.sort((a, b) => b.changePct - a.changePct)
      return { ok: true, gainers: rated.slice(0, 12), losers: rated.slice(-12).reverse() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), gainers: [], losers: [] }
    }
  })

  /** Ticker/company-name autocomplete for the chart and watchlist inputs. */
  ctx.ipcMain.handle(`${ID}:search`, async (_e, raw: unknown) => {
    const q = String(asRecord(raw).q ?? '').trim().slice(0, 40)
    if (!q) return { ok: true, hits: [] }
    const k = key()
    if (!k) return { ok: false, error: NO_KEY, hits: [] }
    try {
      return { ok: true, hits: (await searchTickers(k, q)).slice(0, 8) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), hits: [] }
    }
  })

  ctx.ipcMain.handle(`${ID}:news`, async (_e, raw: unknown) => {
    const limit = Math.min(Math.max(Number(asRecord(raw).limit) || 30, 5), 50)
    const k = key()
    if (!k) return { ok: false, error: NO_KEY, items: [] }
    try {
      const items = await getMarketNews(k, limit)
      return { ok: true, items, at: Date.now() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), items: [] }
    }
  })

  /** ET session clock for the header pill (+ countdown to the next bell). */
  ctx.ipcMain.handle(`${ID}:session`, (): { ok: true; info: SessionInfo } => {
    const now = new Date()
    const p = etParts(now)
    const session = marketSession(now)
    const m = p.hour * 60 + p.minute
    const weekend = p.weekday === 0 || p.weekday === 6
    let minutesToNext: number | null = null
    let nextLabel = ''
    if (!weekend) {
      if (m < 240) {
        minutesToNext = 240 - m
        nextLabel = 'pre-market starts'
      } else if (m < 570) {
        minutesToNext = 570 - m
        nextLabel = 'market opens'
      } else if (m < 960) {
        minutesToNext = 960 - m
        nextLabel = 'market closes'
      } else if (m < 1200) {
        minutesToNext = 1200 - m
        nextLabel = 'after-hours ends'
      }
    }
    return {
      ok: true,
      info: {
        session,
        etClock: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
        minutesToNext,
        nextLabel
      }
    }
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
        label: 'Dashboard layout',
        path: base ? join(base, 'wicked-modules.json') : null,
        note: 'Chart tickers/timeframes, watchlist, tape symbols and TV url under the "day-trade-dash.state" key. Included in Backup & Cloud Sync.'
      }
    ]
  })
}

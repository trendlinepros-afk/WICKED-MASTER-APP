import { createHmac, randomUUID } from 'crypto'

/**
 * Minimal signed HTTP client for the Webull OpenAPI (developer.webull.com).
 *
 * The signature scheme is a faithful port of the official Python SDK
 * (webull-inc/webull-openapi-python-sdk → webull/core/auth/composer/
 * default_signature_composer.py, HMAC-SHA256 variant):
 *
 *   1. sign params = { host, x-app-key, x-signature-algorithm, x-signature-nonce,
 *      x-signature-version, x-timestamp } (lower-cased keys) merged with the
 *      raw query params.
 *   2. string-to-sign = uri + "&" + sorted "k=v" pairs joined by "&"
 *      (+ "&" + UPPERCASE sha256-hex of the compact JSON body, if any).
 *   3. percent-encode the ENTIRE string (every char except [A-Za-z0-9-._~]).
 *   4. signature = base64( HMAC-SHA256( encoded, app_secret + "&" ) ).
 *
 * All endpoints this module needs are GETs on the "api" host. Region US.
 */

const HOST = 'api.webull.com'
const TIMEOUT_MS = 20_000

export interface WebullKeys {
  appKey: string
  appSecret: string
}

export type WebullResult = { ok: true; data: unknown } | { ok: false; error: string; status?: number }

/** Python urllib quote(s, safe='') equivalent — also encodes !'()* which JS leaves bare. */
function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** UTC timestamp in the SDK's FORMAT_ISO_8601 ("%Y-%m-%dT%H:%M:%SZ"). */
function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function signedHeaders(keys: WebullKeys, path: string, query: Record<string, string>): Record<string, string> {
  const signHeaders: Record<string, string> = {
    'x-app-key': keys.appKey,
    'x-timestamp': isoTimestamp(),
    'x-signature-version': '1.0',
    'x-signature-algorithm': 'HMAC-SHA256',
    'x-signature-nonce': randomUUID()
  }
  // sign params: lower-cased sign headers + Host + raw query params
  const signParams: Record<string, string> = { host: HOST }
  for (const [k, v] of Object.entries(signHeaders)) signParams[k.toLowerCase()] = v
  for (const [k, v] of Object.entries(query)) {
    signParams[k] = signParams[k] != null ? `${signParams[k]}&${v}` : v
  }
  const sorted = Object.keys(signParams)
    .sort()
    .map((k) => `${k}=${signParams[k]}`)
  const stringToSign = pctEncode(`${path}&${sorted.join('&')}`)
  const signature = createHmac('sha256', keys.appSecret + '&').update(stringToSign).digest('base64')
  return {
    ...signHeaders,
    'x-signature': signature,
    'x-version': 'v2',
    'x-webull-client-source': 'sdk'
  }
}

/** One signed GET. 429s get a single 1.2s-backoff retry. */
export async function webullGet(
  keys: WebullKeys,
  path: string,
  query: Record<string, string>,
  retried = false
): Promise<WebullResult> {
  const qs = new URLSearchParams(query).toString()
  const url = `https://${HOST}${path}${qs ? `?${qs}` : ''}`
  let resp: Response
  try {
    resp = await fetch(url, { headers: signedHeaders(keys, path, query), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    return { ok: false, error: `Webull request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (resp.status === 429 && !retried) {
    await new Promise((r) => setTimeout(r, 1200))
    return webullGet(keys, path, query, true)
  }
  const text = await resp.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body — handled below */
  }
  if (!resp.ok) {
    const o = rec(body)
    const code = String(o.error_code ?? o.code ?? resp.status)
    const msg = String(o.message ?? o.msg ?? text.slice(0, 200) ?? '')
    let hint = ''
    if (/MARKET_DATA_NOT_SUBSCRIBED|NOT_SUBSCRIBED/i.test(`${code} ${msg}`)) {
      hint =
        ' — the "Market Data" checkbox on your app is only the PERMISSION; the quotes themselves need a (separate) OpenAPI subscription. On webull.com: avatar → Advanced Quotes → OpenAPI Advanced Quotes → subscribe to the package named in this error (app/desktop quote subscriptions do not carry over).'
    } else if (resp.status === 401 || resp.status === 403 || /INVALID.*(KEY|SIGN)|AUTH/i.test(code)) {
      hint = ' — check your Webull App Key/Secret in Settings → API Keys, and that your OpenAPI subscription covers this endpoint.'
    } else if (resp.status === 429) {
      hint = ' — Webull rate limit; wait a moment and retry.'
    }
    return { ok: false, status: resp.status, error: `Webull ${resp.status} (${code}) ${msg}${hint}` }
  }
  return { ok: true, data: body }
}

/* --------------------------------- helpers -------------------------------- */

export function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Pull the row array out of a response no matter which envelope key it uses. */
export function rowsOf(j: unknown): Record<string, unknown>[] {
  if (Array.isArray(j)) return j.map(rec)
  const o = rec(j)
  for (const k of ['data', 'result', 'results', 'list', 'items', 'rows', 'snapshots', 'contracts', 'instruments']) {
    if (Array.isArray(o[k])) return (o[k] as unknown[]).map(rec)
  }
  // single-row object (e.g. a one-symbol snapshot returned bare)
  if (o.symbol != null || o.instrument_id != null || o.instrumentId != null) return [o]
  return []
}

/** First finite number among several field-name spellings ("120.5" strings count). */
export function fnum(o: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const v = o[n]
    if (v == null || v === '') continue
    const num = Number(v)
    if (Number.isFinite(num)) return num
  }
  return null
}

export function fstr(o: Record<string, unknown>, ...names: string[]): string {
  for (const n of names) {
    const v = o[n]
    if (typeof v === 'string' && v) return v
    if (typeof v === 'number') return String(v)
  }
  return ''
}

/** Keep only compact scalar fields of a raw row (for AI dossiers). */
export function trimRow(o: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string' && v.length <= 80) out[k] = v
  }
  return out
}

/* ------------------------------- OCC symbols ------------------------------ */

export interface OccParts {
  underlying: string
  /** YYYY-MM-DD */
  expiry: string
  type: 'CALL' | 'PUT'
  strike: number
}

/** Parse an OCC-style option symbol, e.g. AAPL260522C00300000. */
export function parseOcc(sym: string): OccParts | null {
  const m = sym.trim().toUpperCase().match(/^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/)
  if (!m) return null
  const [, underlying, ymd, cp, strikeRaw] = m
  const yy = ymd.slice(0, 2)
  const mm = ymd.slice(2, 4)
  const dd = ymd.slice(4, 6)
  return {
    underlying,
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === 'C' ? 'CALL' : 'PUT',
    strike: Number(strikeRaw) / 1000
  }
}

/* ------------------------------- API wrappers ----------------------------- */

export interface SnapshotBatch {
  snaps: Map<string, Record<string, unknown>>
  /** symbols Webull rejected as unknown (typos, unsupported instruments) */
  invalid: string[]
}

const isBadSymbolError = (res: { status?: number; error: string }): boolean =>
  res.status === 417 || /INVALID_SYMBOL|does not exist/i.test(res.error)

/**
 * Latest stock snapshots (max 20 symbols per call — chunked). One unknown
 * ticker must NOT sink the batch: Webull 417s the whole chunk, so on
 * INVALID_SYMBOL the chunk is binary-split until the bad symbol(s) are
 * isolated into `invalid` and every good symbol still gets its quote. Real
 * errors (auth, subscription, rate limit) still throw.
 */
export async function stockSnapshots(keys: WebullKeys, symbols: string[]): Promise<SnapshotBatch> {
  const out: SnapshotBatch = { snaps: new Map(), invalid: [] }

  const fetchChunk = async (chunk: string[]): Promise<void> => {
    const res = await webullGet(keys, '/openapi/market-data/stock/snapshot', {
      symbols: chunk.join(','),
      category: 'US_STOCK'
    })
    if (res.ok) {
      for (const row of rowsOf(res.data)) {
        const sym = fstr(row, 'symbol', 'ticker').toUpperCase()
        if (sym) out.snaps.set(sym, row)
      }
      return
    }
    if (!isBadSymbolError(res)) throw new Error(res.error)
    if (chunk.length === 1) {
      out.invalid.push(chunk[0])
      return
    }
    const mid = Math.ceil(chunk.length / 2)
    await fetchChunk(chunk.slice(0, mid))
    await fetchChunk(chunk.slice(mid))
  }

  for (let i = 0; i < symbols.length; i += 20) await fetchChunk(symbols.slice(i, i + 20))
  return out
}

/** Listed option contracts for one underlying expiring on exactly `ymd`. */
export async function optionContracts(
  keys: WebullKeys,
  underlying: string,
  ymd: string,
  optionType: 'CALL' | 'PUT',
  strikeGte: number | null,
  strikeLte: number | null
): Promise<Record<string, unknown>[]> {
  const query: Record<string, string> = {
    category: 'US_OPTION',
    underlying_symbols: underlying,
    status: 'LISTING',
    start_date: ymd,
    option_type: optionType,
    page_size: '1000'
  }
  if (strikeGte != null) query.strike_price_gte = String(strikeGte)
  if (strikeLte != null) query.strike_price_lte = String(strikeLte)
  const res = await webullGet(keys, '/openapi/instrument/option/contracts', query)
  if (!res.ok) throw new Error(res.error)
  return rowsOf(res.data)
}

/** Live option snapshots for OCC symbols (max 20 per call — chunked). */
export async function optionSnapshots(keys: WebullKeys, occSymbols: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < occSymbols.length; i += 20) {
    const chunk = occSymbols.slice(i, i + 20)
    const res = await webullGet(keys, '/openapi/market-data/option/snapshot', {
      symbols: chunk.join(','),
      category: 'US_OPTION'
    })
    // fail-soft per chunk: a bad symbol shouldn't sink the whole scan
    if (!res.ok) continue
    for (const row of rowsOf(res.data)) {
      const sym = fstr(row, 'symbol', 'option_symbol', 'optionSymbol').toUpperCase()
      if (sym) out.set(sym, row)
    }
  }
  return out
}

export interface MinuteBar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

/**
 * Last `count` 1-minute bars for a stock (oldest → newest), INCLUDING the
 * still-forming bar (real_time_required). Field names and numeric types vary
 * across Webull deployments, so parse tolerantly; timestamps normalize to ms.
 */
export async function getMinuteBars(keys: WebullKeys, symbol: string, count = 420): Promise<MinuteBar[]> {
  const res = await webullGet(keys, '/openapi/market-data/stock/bars', {
    symbol,
    category: 'US_STOCK',
    timespan: 'M1',
    count: String(Math.max(1, Math.min(1200, count))),
    real_time_required: 'true'
  })
  if (!res.ok) throw new Error(res.error)
  const bars: MinuteBar[] = []
  for (const row of rowsOf(res.data)) {
    // some shapes nest the array under a per-symbol object
    const nested = Array.isArray(row.bars) ? (row.bars as unknown[]).map(rec) : [row]
    for (const b of nested) {
      let t = fnum(b, 'timestamp', 'trade_time', 'time', 't')
      if (t == null) {
        const parsed = Date.parse(fstr(b, 'timestamp', 'trade_time', 'time'))
        t = Number.isFinite(parsed) ? parsed : null
      }
      const c = fnum(b, 'close', 'c')
      if (t == null || c == null) continue
      if (t < 1e12) t *= 1000 // seconds → ms
      bars.push({
        t,
        o: fnum(b, 'open', 'o') ?? c,
        h: fnum(b, 'high', 'h') ?? c,
        l: fnum(b, 'low', 'l') ?? c,
        c,
        v: fnum(b, 'volume', 'v') ?? 0
      })
    }
  }
  bars.sort((a, b) => a.t - b.t)
  return bars
}

export interface Nbbo {
  bid: number | null
  ask: number | null
  bidSize: number | null
  askSize: number | null
}

/** Live top-of-book bid/ask for a stock (depth 1). */
export async function getNbbo(keys: WebullKeys, symbol: string): Promise<Nbbo> {
  const res = await webullGet(keys, '/openapi/market-data/stock/quotes', {
    symbol,
    category: 'US_STOCK',
    depth: '1'
  })
  if (!res.ok) throw new Error(res.error)
  const out: Nbbo = { bid: null, ask: null, bidSize: null, askSize: null }
  for (const row of rowsOf(res.data)) {
    const bids = Array.isArray(row.bids) ? (row.bids as unknown[]).map(rec) : []
    const asks = Array.isArray(row.asks) ? (row.asks as unknown[]).map(rec) : []
    out.bid = bids.length ? (fnum(bids[0], 'price', 'p', 'bid') ?? out.bid) : (fnum(row, 'bid', 'bid_price', 'bidPrice') ?? out.bid)
    out.ask = asks.length ? (fnum(asks[0], 'price', 'p', 'ask') ?? out.ask) : (fnum(row, 'ask', 'ask_price', 'askPrice') ?? out.ask)
    out.bidSize = bids.length ? fnum(bids[0], 'size', 'volume') : fnum(row, 'bid_size', 'bidSize')
    out.askSize = asks.length ? fnum(asks[0], 'size', 'volume') : fnum(row, 'ask_size', 'askSize')
    if (out.bid != null || out.ask != null) break
  }
  return out
}

export interface WebullWatchlist {
  id: string
  name: string
}

/** The user's Webull watchlists (shared with their retail account). */
export async function getWatchlists(keys: WebullKeys): Promise<WebullWatchlist[]> {
  const res = await webullGet(keys, '/openapi/market-data/watchlist/list', {})
  if (!res.ok) throw new Error(res.error)
  return rowsOf(res.data)
    .map((r) => ({ id: fstr(r, 'watchlist_id', 'watchlistId', 'id'), name: fstr(r, 'name', 'watchlist_name') }))
    .filter((w) => w.id)
}

/** Symbols inside one Webull watchlist. */
export async function getWatchlistSymbols(keys: WebullKeys, watchlistId: string): Promise<string[]> {
  const res = await webullGet(keys, '/openapi/market-data/watchlist/instruments/list', { watchlist_id: watchlistId })
  if (!res.ok) throw new Error(res.error)
  const syms = rowsOf(res.data)
    .map((r) => fstr(r, 'symbol', 'ticker').toUpperCase())
    .filter(Boolean)
  return [...new Set(syms)]
}

/**
 * Broker order/trade-history CSV parser (pure — no Node/Electron), so it can be
 * unit-tested directly against real exports.
 *
 * Columns are matched by HEADER NAME (never position), with aliases covering the
 * common broker exports — Webull "Orders Records", Robinhood account activity,
 * Schwab/TD transactions, Fidelity activity, Interactive Brokers trade reports,
 * E*TRADE transactions, tastytrade history — plus any generic CSV that has a
 * symbol, a side/action, a quantity, a price and a date. The header row is
 * FOUND, not assumed: the first ~40 lines are scanned and the line that matches
 * the most known columns wins, so exports with preamble/disclaimer lines parse
 * fine. Comma, semicolon and tab delimiters are auto-detected.
 *
 * Quirks handled:
 *  - Prices may carry "@", "$", commas or parentheses-negatives — normalized.
 *  - Signed quantities (IBKR: negative = sell) derive the side when no
 *    side/action column exists.
 *  - Activity exports mix in non-trade rows (dividends, transfers, interest,
 *    totals) — recognized and counted as `ignored`, never imported as trades.
 *  - Cancelled orders with a PARTIAL fill still count the filled shares (the
 *    shares really executed); fully-unfilled rows are kept but excluded from
 *    P&L.
 *  - Times: "07/15/2026 12:41:25 EDT", "2026-07-15, 12:41:25", ISO, 12-hour
 *    AM/PM, and date-only rows all parse. A named zone uses its fixed offset;
 *    NO zone (or a bare "ET") is treated as an Eastern wall clock and converted
 *    DST-correctly via Intl — never the host machine's timezone.
 *  - Names may contain commas → a real quoted-CSV splitter.
 *
 * DE-DUP IDENTITY (`execHash`): brokers rarely export an order id, so each row
 * gets a fingerprint from its STABLE fields only — symbol, side, placed/trade
 * time, total order quantity and limit price. Mutable fields (status, filled
 * quantity, average price) are deliberately EXCLUDED: an order exported while
 * "Working" and re-exported after it filled must hash the same so the re-import
 * UPDATES the row instead of duplicating it. Genuinely distinct orders that tie
 * on every stable field (e.g. two identical same-second hotkey orders) are kept
 * apart with an occurrence suffix (`#2`, `#3`, …) assigned in file order.
 */

import { etInputToEpoch } from './et'

export type Side = 'buy' | 'sell' | 'short'

export interface Execution {
  /** stable de-dup key (see header comment; `manual:<uuid>` for hand-entered) */
  hash: string
  /** account this execution belongs to (assigned at import; '' before) */
  account?: string
  name: string
  symbol: string
  side: Side
  /** raw side text from the file (Buy / Sell Short / BTO / "YOU BOUGHT …") */
  sideRaw: string
  status: string
  /** true when shares really executed (filled qty > 0 with a usable price) */
  filled: boolean
  /** filled quantity (shares actually executed) */
  qty: number
  /** total order quantity */
  totalQty: number
  /** effective execution price (Avg Price when present, else Price) */
  price: number
  avgPrice: number
  limitPrice: number
  /** TOTAL cost that reduces P&L for this row: commission + exchange/reg fees */
  fees: number
  /** the commission-only portion of `fees` (≤ fees), for reporting; 0 if unknown */
  commission: number
  /**
   * Dollars per 1.0 price move per contract/share (1 for equities). Set from
   * the contract root for futures instruments ("ES 09-26" → $50/pt), so P&L
   * math is right for NinjaTrader-style futures fills.
   */
  multiplier: number
  timeInForce: string
  placedText: string
  filledText: string
  /** epoch ms of the fill (or placed time if no fill), null if unparseable */
  filledAt: number | null
  placedAt: number | null
  /** row order within the source file — FIFO tie-breaker for equal timestamps */
  seq: number | null
}

export interface ParseResult {
  executions: Execution[]
  /** trade-looking rows that couldn't be used (bad numbers etc.), with a reason */
  errors: { line: number; reason: string }[]
  /** header columns actually seen */
  columns: string[]
  /** best-guess source ("Webull", "Robinhood", …, or "CSV") */
  broker: string
  /** non-trade rows skipped (dividends, transfers, totals, unknown actions) */
  ignored: number
}

/* --------------------------------- times ---------------------------------- */

/** Fixed-offset zone tokens (unambiguous abbreviations). */
const TZ_OFFSET: Record<string, string> = {
  EDT: '-04:00',
  EST: '-05:00',
  CDT: '-05:00',
  CST: '-06:00',
  MDT: '-06:00',
  MST: '-07:00',
  PDT: '-07:00',
  PST: '-08:00',
  UTC: '+00:00',
  GMT: '+00:00',
  Z: '+00:00'
}

/**
 * Bare US zone tokens ("ET") are wall clocks whose DST tracks Eastern's: the
 * same wall reading in Central happens exactly 1h later in absolute time, so
 * converting as an ET wall clock and adding the hour gap stays DST-correct.
 */
const WALL_CLOCK_GAP_HOURS: Record<string, number> = { ET: 0, CT: 1, MT: 2, PT: 3 }

const p2 = (n: string | number): string => String(n).padStart(2, '0')

/** Wall-clock parts + optional zone token → epoch ms (host-TZ independent). */
function wallToEpoch(y: string, mo: string, d: string, hh: number, mm: string, ss: string, tz: string): number | null {
  const zone = tz.toUpperCase()
  if (TZ_OFFSET[zone]) {
    const t = Date.parse(`${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${mm}:${ss}${TZ_OFFSET[zone]}`)
    return Number.isNaN(t) ? null : t
  }
  // No/unknown zone (or bare ET/CT/MT/PT): Eastern wall clock via Intl (DST-correct).
  const et = etInputToEpoch(`${y}-${p2(mo)}-${p2(d)}T${p2(hh)}:${mm}:${ss}`)
  if (et == null) return null
  const gap = WALL_CLOCK_GAP_HOURS[zone] ?? 0
  return et + gap * 3_600_000
}

/**
 * Broker date/time text → epoch ms, or null. Handles "MM/DD/YYYY HH:MM:SS TZ",
 * "YYYY-MM-DD, HH:MM:SS" (IBKR), ISO "T" forms, 12-hour AM/PM, and date-only
 * rows (taken as 00:00 Eastern so the trading DAY is always right).
 */
export function parseBrokerTime(text: string): number | null {
  const s = (text || '').trim()
  if (!s) return null
  const mdy = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?:\s*([AaPp][Mm]))?(?:\s+([A-Za-z]{1,4}))?)?$/
  )
  const ymd = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(?:\s*([AaPp][Mm]))?(?:\s+([A-Za-z]{1,4}))?)?$/
  )
  const m = mdy ?? ymd
  if (m) {
    const [, a, b, c, hh, mm, ss, ampm, tz] = m
    const [y, mo, d] = mdy ? [c, a, b] : [a, b, c]
    let hour = hh ? Number(hh) : 0
    if (ampm) {
      const pm = ampm.toLowerCase() === 'pm'
      if (pm && hour < 12) hour += 12
      if (!pm && hour === 12) hour = 0
    }
    return wallToEpoch(y, mo, d, hour, mm ?? '00', ss ?? '00', tz ?? '')
  }
  const t = Date.parse(s) // last resort (host-TZ dependent, e.g. RFC dates)
  return Number.isNaN(t) ? null : t
}

/** Back-compat alias (older callers/tests). */
export const parseWebullTime = parseBrokerTime

/* ------------------------------- primitives -------------------------------- */

/** Split one CSV line honoring double-quoted fields (with "" escapes). */
export function splitCsvLine(line: string, delim = ','): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQuotes = false
      } else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === delim) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** "@217.00", "$1,234.56", "(45.10)", "-45.10" → number (signed); junk → 0. */
function num(v: string): number {
  let s = (v || '').trim()
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[@$,\s]/g, '')
  if (!s || s === '-' || s === '--') return 0
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return neg ? -n : n
}

/**
 * Side/action text → side, or null when the value is clearly not a trade
 * (Dividend, ACH, Interest, Journal, …). Covers plain words, broker codes
 * (BTO/STC/STO/BTC, BOT/SLD, B/S/SS) and sentence actions ("YOU BOUGHT …").
 */
export function parseSideToken(raw: string): Side | null {
  const s = (raw || '').trim().toLowerCase().replace(/[_-]+/g, ' ')
  if (!s) return null
  const compact = s.replace(/[^a-z]/g, '')
  const exact: Record<string, Side> = {
    b: 'buy',
    buy: 'buy',
    bot: 'buy',
    bto: 'buy', // buy to open
    btc: 'buy', // buy to close/cover
    cvr: 'buy',
    cover: 'buy',
    s: 'sell',
    sell: 'sell',
    sld: 'sell',
    stc: 'sell', // sell to close
    ss: 'short',
    sto: 'short', // sell to open
    short: 'short'
  }
  if (exact[compact]) return exact[compact]
  // Short forms first ("Sell Short", "Sold Short", "Short Sale", "Sell to
  // Open") — but only ADJACENT words, so a security NAME containing "Short"
  // ("YOU BOUGHT PROSHARES ULTRAPRO SHORT QQQ") can't hijack the side.
  if (/(?:^|\s)(?:sell|sold)\s+short(?:\s|$)/.test(s)) return 'short'
  if (/(?:^|\s)short\s+(?:sell|sale|sold)(?:\s|$)/.test(s)) return 'short'
  if (/s(?:ell|old)\s*to\s*open/.test(s)) return 'short'
  if (/buy|bought|cover/.test(s)) return 'buy'
  if (/sell|sold/.test(s)) return 'sell'
  if (/^short\b/.test(s)) return 'short'
  return null
}

/** Old lenient normalizer (unknown → buy) — for text KNOWN to be a side. */
export function normSide(raw: string): Side {
  return parseSideToken(raw) ?? 'buy'
}

/* ------------------------------ futures roots ------------------------------ */

/**
 * Dollars per 1.0 price move for common futures roots (CME/CBOT/NYMEX/COMEX/
 * ICE/CFE). Without these, a 2-point ES scalp would book as $2 instead of $100.
 */
const FUTURES_POINT_VALUE: Record<string, number> = {
  // equity index
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, EMD: 100, NKD: 5,
  // energy
  CL: 1000, MCL: 100, QM: 500, HO: 42000, RB: 42000, NG: 10000, QG: 2500, BZ: 1000,
  // metals
  GC: 100, MGC: 10, SI: 5000, SIL: 1000, QI: 2500, HG: 25000, MHG: 2500, QC: 12500, PL: 50, PA: 100,
  // rates
  ZB: 1000, ZN: 1000, ZF: 1000, ZT: 2000, UB: 1000, TN: 1000,
  // grains / softs / livestock
  ZC: 50, ZS: 50, ZW: 50, ZM: 100, ZL: 600, ZO: 50, KE: 50, ZR: 2000, HE: 400, LE: 400, GF: 500,
  // FX
  '6E': 125000, '6B': 62500, '6J': 12500000, '6A': 100000, '6C': 100000, '6S': 125000, '6N': 100000, '6M': 500000,
  M6E: 12500, M6A: 10000, M6B: 6250, DX: 1000,
  // crypto / vol
  BTC: 5, MBT: 0.1, ETH: 50, MET: 0.1, VX: 1000, VXM: 100
}

/**
 * Contract root for a symbol — but ONLY when it is unambiguously a futures
 * contract: NinjaTrader's "ROOT MM-YY" ("MES 09-26") or "ROOT MMMYY"
 * ("MES SEP26" / "MES SEP 26") forms, or the compact exchange code
 * ("MESU6" / "ESZ25") when the root is a KNOWN futures root. A bare stock
 * ticker never matches (CL the stock is Colgate; CL the future is crude oil).
 */
const FUT_SPACED = /^([A-Z0-9]{1,4})\s+(?:\d{2}-\d{2}|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s?\d{2,4})$/
const FUT_CODE = /^([A-Z0-9]{1,4})[FGHJKMNQUVXZ]\d{1,2}$/

function futuresRoot(symbol: string): string | null {
  const spaced = symbol.match(FUT_SPACED)
  if (spaced) return spaced[1]
  const code = symbol.match(FUT_CODE)
  if (code && FUTURES_POINT_VALUE[code[1]] !== undefined) return code[1]
  return null
}

/** True when the symbol is a recognizable futures contract (any root). */
export function isFuturesInstrument(symbol: string): boolean {
  return futuresRoot(symbol) != null
}

/** Point value for a futures contract symbol; 1 for everything else. */
export function futuresMultiplier(symbol: string): number {
  const root = futuresRoot(symbol)
  return root ? FUTURES_POINT_VALUE[root] ?? 1 : 1
}

/* -------------------------------- headers ---------------------------------- */

/** Aliases are in PRIORITY order — the first alias found in the header wins. */
const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'security description', 'description', 'company'],
  symbol: ['symbol', 'ticker', 'instrument'],
  side: ['side', 'action', 'trans code', 'transaction code', 'buy/sell', 'b/s', 'order action', 'transaction type', 'transactiontype'],
  status: ['status', 'order status', 'state'],
  filled: ['filled', 'filled qty', 'filledqty', 'filled quantity', 'executed qty', 'exec qty'],
  totalQty: ['total qty', 'totalqty', 'quantity', 'qty', 'shares', 'number of shares', 'no. of shares'],
  price: ['price', 't. price', 'trade price', 'price ($)', 'execution price', 'fill price', 'price per share', 'limit price', 'limit'],
  avgPrice: ['avg price', 'avg. price', 'avgprice', 'average price', 'avg fill price', 'avg. fill price', 'average fill price'],
  commission: ['commission', 'commissions', 'commission ($)', 'comm/fee', 'fees & comm', 'commissions & fees', 'comm'],
  fees: ['fees', 'fee', 'fees ($)', 'reg fee', 'regulatory fees', 'other fees'],
  tif: ['time-in-force', 'time in force', 'tif'],
  placed: ['placed time', 'placed', 'placed time(edt)', 'order time', 'order date'],
  filledTime: [
    'filled time',
    'filled time(edt)',
    'executed time',
    'execution time',
    'date/time',
    'datetime',
    'trade time',
    'transaction time',
    'time', // NinjaTrader executions/orders grids
    'trade date',
    'activity date',
    'run date',
    'transaction date',
    'date'
  ],
  discriminator: ['datadiscriminator', 'data discriminator'],
  // A REAL per-row id (NinjaTrader executions/orders "ID", tastytrade
  // "Order #") — when present and non-empty it becomes the de-dup identity.
  // Deliberately excludes sequential counters like "Trade number".
  orderId: ['id', 'order id', 'orderid', 'exec id', 'execution id', 'order #', 'order number'],
  // Round-trip "trade list" layouts (NinjaTrader Trade Performance grid):
  // one row = entry + exit, split into two executions.
  entryPrice: ['entry price'],
  exitPrice: ['exit price'],
  entryTime: ['entry time'],
  exitTime: ['exit time'],
  marketPos: ['market pos.', 'market pos', 'market position'],
  // Authoritative net P&L per trade (NinjaTrader Trade Performance): "Cum. net
  // profit" is the running NET total — differencing consecutive rows gives each
  // trade's exact net, which we honor verbatim so WICKED matches the platform.
  profit: ['profit', 'net profit', 'realized pnl', 'realized p/l', 'pnl'],
  cumNetProfit: ['cum. net profit', 'cum net profit', 'cumulative net profit', 'cum. profit', 'cum profit'],
  tradeNumber: ['trade number', 'trade #', 'trade no.', 'trade no']
}

function buildColMap(header: string[]): Record<string, number> {
  const lower = header.map((h) => h.toLowerCase().trim())
  const map: Record<string, number> = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) {
      const idx = lower.indexOf(a)
      if (idx >= 0) {
        map[key] = idx
        break
      }
    }
  }
  return map
}

function guessBroker(headerLower: string[]): string {
  const has = (...names: string[]): boolean => names.every((n) => headerLower.includes(n))
  if (has('placed time') || (has('filled') && has('side') && has('avg price'))) return 'Webull'
  if (has('entry price', 'exit price')) return has('instrument') || has('market pos.') ? 'NinjaTrader (trades)' : 'Trade list'
  if (has('instrument') && (has('e/x') || has('order id') || has('oco') || has('state'))) return 'NinjaTrader'
  if (has('trans code') || has('instrument', 'activity date')) return 'Robinhood'
  if (headerLower.some((h) => h === 'datadiscriminator' || h === 't. price')) return 'Interactive Brokers'
  if (has('run date')) return 'Fidelity'
  if (has('fees & comm')) return 'Schwab'
  if (headerLower.some((h) => h === 'transactiontype' || h === 'transaction type') && has('symbol')) return 'E*TRADE'
  if (has('instrument type') || has('root symbol')) return 'tastytrade'
  return 'CSV'
}

/* --------------------------------- hashing --------------------------------- */

/**
 * Stable de-dup fingerprint from IMMUTABLE order fields only (see header
 * comment). `side` is the normalized side so capitalization/wording changes
 * between exports can't split an order into two.
 */
export function execHash(e: {
  symbol: string
  side: Side
  placedText: string
  filledText: string
  totalQty: number
  limitPrice: number
}): string {
  const timeKey = (e.placedText || e.filledText || '').trim()
  return ['v2', e.symbol, e.side, timeKey, e.totalQty, e.limitPrice].join('|')
}

/**
 * Distinct orders that tie on every stable field get `#2`, `#3`, … suffixes in
 * source order, so identical same-second orders survive de-dup as separate rows
 * (and re-imports map back onto the same suffixes).
 */
export function assignOccurrenceHashes(execs: { hash: string }[]): void {
  const seen = new Map<string, number>()
  for (const e of execs) {
    const n = (seen.get(e.hash) ?? 0) + 1
    seen.set(e.hash, n)
    if (n > 1) e.hash = `${e.hash}#${n}`
  }
}

/* --------------------------------- parser ---------------------------------- */

const NON_EXECUTED_STATUS = /cancel|reject|fail|expir|pending|working|queued|submitt|placed|open|accept|initial|trigger/i

interface HeaderPick {
  idx: number
  delim: string
  header: string[]
  col: Record<string, number>
  score: number
}

/** Scan the first lines for the row that matches the most known columns. */
function findHeader(lines: string[]): HeaderPick | null {
  let best: HeaderPick | null = null
  const limit = Math.min(lines.length, 40)
  for (let i = 0; i < limit; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    for (const delim of [',', ';', '\t']) {
      if (!line.includes(delim)) continue
      const header = splitCsvLine(line, delim)
      if (header.length < 3) continue
      const col = buildColMap(header)
      const essentials =
        col.symbol !== undefined && (col.side !== undefined || col.totalQty !== undefined || col.filled !== undefined)
      if (!essentials) continue
      const score = Object.keys(col).length
      if (!best || score > best.score) best = { idx: i, delim, header, col, score }
    }
  }
  return best
}

export function parseBrokerCsv(text: string): ParseResult {
  const errors: ParseResult['errors'] = []
  const rawLines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const picked = findHeader(rawLines)
  if (!picked) {
    return {
      executions: [],
      errors: [{ line: 1, reason: 'No recognizable header row (need at least Symbol plus a Side/Action or Quantity column).' }],
      columns: [],
      broker: 'CSV',
      ignored: 0
    }
  }
  const { idx: headerIdx, delim, header, col } = picked
  const broker = guessBroker(header.map((h) => h.toLowerCase().trim()))
  let ignored = 0
  const addError = (line: number, reason: string): void => {
    if (errors.length < 50) errors.push({ line, reason })
  }

  // First pass: raw rows (so DataDiscriminator-style exports can be filtered
  // as a set — IBKR statements list the same trades at both "Order" and
  // "Trade" level; importing both would double-count).
  interface PreRow {
    line: number
    f: string[]
    disc: string
  }
  const pre: PreRow[] = []
  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (!line.trim()) continue
    const f = splitCsvLine(line, delim)
    const disc = col.discriminator !== undefined ? (f[col.discriminator] ?? '').trim().toLowerCase() : ''
    pre.push({ line: i + 1, f, disc })
  }
  let acceptDisc: ((d: string) => boolean) | null = null
  if (col.discriminator !== undefined) {
    const values = new Set(pre.map((r) => r.disc))
    const level = values.has('order') ? 'order' : values.has('trade') ? 'trade' : values.has('execution') ? 'execution' : null
    acceptDisc = (d) => d === '' || d === level
    if (level == null) acceptDisc = (d) => d === ''
  }

  const executions: Execution[] = []
  const cleanSymbol = (raw: string): string => raw.toUpperCase().replace(/^-/, '').replace(/\*+$/, '').trim()

  /* ---- round-trip "trade list" layout (NinjaTrader Trade Performance) ----
   * One row = a whole trade with entry AND exit — split into two executions
   * so the FIFO engine, stats and editing all work exactly like fill imports.
   *
   * When the export carries NinjaTrader's own P&L — "Cum. net profit" (running
   * NET total, differenced per row) or a per-trade "Profit" — we HONOR IT: the
   * trade's cost is set to (our gross price P&L − that net) so WICKED's realized
   * P&L equals the platform's to the cent, and any "Commission" column is kept
   * as the commission-only portion so the split matches too. This is the report
   * that reconciles 1:1 with NinjaTrader. */
  if (col.entryPrice !== undefined && col.exitPrice !== undefined) {
    let prevCum: number | null = null
    for (const row of pre) {
      const { line, f } = row
      const get = (k: string): string => (col[k] !== undefined ? (f[col[k]] ?? '') : '')
      if (f.every((v) => !v)) continue
      const symbol = cleanSymbol(get('symbol'))
      if (!symbol || symbol === 'SYMBOL' || symbol === 'INSTRUMENT') {
        ignored++
        continue
      }
      const posRaw = get('marketPos') || get('side')
      const dir: 'long' | 'short' = /short|sell/i.test(posRaw) ? 'short' : 'long'
      const qty = Math.abs(num(get('totalQty')))
      const entryPrice = Math.abs(num(get('entryPrice')))
      const exitPrice = Math.abs(num(get('exitPrice')))
      const entryTime = get('entryTime')
      const exitTime = get('exitTime')
      if (qty <= 0 || entryPrice <= 0) {
        addError(line, `${symbol}: trade row without a usable quantity/entry price — skipped.`)
        continue
      }
      const multiplier = futuresMultiplier(symbol)
      const hasExit = exitPrice > 0 && !!exitTime.trim()

      // Authoritative net P&L for this trade, if the report provides it.
      let net: number | null = null
      if (col.cumNetProfit !== undefined && get('cumNetProfit').trim() !== '') {
        const cum = num(get('cumNetProfit'))
        net = prevCum == null ? cum : cum - prevCum
        prevCum = cum
      } else if (col.profit !== undefined && get('profit').trim() !== '') {
        net = num(get('profit'))
      }
      const grossPnl = (dir === 'long' ? exitPrice - entryPrice : entryPrice - exitPrice) * qty * multiplier

      // Total cost (commission + fees) = gross − net when net is known; else fall
      // back to any explicit Commission/Fees columns.
      const commissionCol = Math.abs(num(get('commission')))
      const feesCol = Math.abs(num(get('fees')))
      let totalCost: number
      if (net != null && hasExit) {
        totalCost = grossPnl - net
        if (Math.abs(totalCost) < 0.005) totalCost = 0 // float dust
        totalCost = Math.max(0, totalCost)
      } else {
        totalCost = commissionCol + feesCol
      }
      const commission = Math.min(commissionCol, totalCost)

      const costEach = hasExit ? totalCost / 2 : totalCost
      const commEach = hasExit ? commission / 2 : commission
      const mk = (side: Side, price: number, when: string): Execution => {
        const e: Execution = {
          hash: '',
          name: get('name'),
          symbol,
          side,
          sideRaw: posRaw || dir,
          status: 'Filled',
          filled: true,
          qty,
          totalQty: qty,
          price,
          avgPrice: price,
          limitPrice: price,
          fees: costEach,
          commission: commEach,
          multiplier,
          timeInForce: '',
          placedText: when,
          filledText: when,
          filledAt: parseBrokerTime(when),
          placedAt: parseBrokerTime(when),
          seq: executions.length
        }
        e.hash = execHash(e)
        return e
      }
      executions.push(mk(dir === 'long' ? 'buy' : 'short', entryPrice, entryTime))
      if (hasExit) executions.push(mk(dir === 'long' ? 'sell' : 'buy', exitPrice, exitTime))
    }
    assignOccurrenceHashes(executions)
    return { executions, errors, columns: header, broker, ignored }
  }

  // A per-row id column becomes the de-dup identity when it's a REAL id: any
  // explicitly-named id header, or the bare "ID" of NinjaTrader's grids. A
  // bare "id" in an unknown format could be a row counter — not trusted.
  const idHeaderName = col.orderId !== undefined ? header[col.orderId].toLowerCase().trim() : ''
  const idTrusted = col.orderId !== undefined && (idHeaderName !== 'id' || broker === 'NinjaTrader')

  for (const row of pre) {
    const { line, f } = row
    if (acceptDisc && !acceptDisc(row.disc)) {
      ignored++
      continue
    }
    const get = (k: string): string => (col[k] !== undefined ? (f[col[k]] ?? '') : '')
    if (f.every((v) => !v)) continue

    const symbol = cleanSymbol(get('symbol'))
    if (!symbol || symbol === 'SYMBOL') {
      ignored++ // fee/interest/total rows have no symbol; repeated headers too
      continue
    }

    // Side: explicit column, else derive from a signed quantity (IBKR-style).
    const sideRaw = get('side')
    const qtySigned = num(get('totalQty'))
    let side: Side | null
    if (col.side !== undefined) {
      side = parseSideToken(sideRaw)
      if (!side) {
        ignored++ // "Dividend", "ACH", "Journal", "Interest", …
        continue
      }
    } else {
      side = qtySigned < 0 ? 'sell' : 'buy'
    }

    const status = get('status') || 'Filled'
    const statusExecuted = !NON_EXECUTED_STATUS.test(status)
    const filledColQty = col.filled !== undefined ? Math.abs(num(get('filled'))) : null
    const rawTotal = Math.abs(qtySigned)
    // With a Filled column, trust it (a cancelled order's partial fill is real
    // executed shares). Without one, only executed statuses count.
    const qty = filledColQty ?? (statusExecuted ? rawTotal : 0)
    const totalQty = rawTotal > 0 ? rawTotal : qty
    if (totalQty <= 0 && qty <= 0) {
      ignored++
      continue
    }

    const avgPrice = Math.abs(num(get('avgPrice')))
    const limitPrice = Math.abs(num(get('price')))
    const price = avgPrice > 0 ? avgPrice : limitPrice
    if (qty > 0 && price <= 0) {
      addError(line, `${symbol}: filled ${qty} shares but no usable price — row skipped.`)
      continue
    }

    const commission = Math.abs(num(get('commission')))
    const fees = commission + Math.abs(num(get('fees')))
    const placedText = get('placed')
    const filledText = get('filledTime')
    const e: Execution = {
      hash: '',
      name: get('name'),
      symbol,
      side,
      sideRaw: sideRaw || side,
      status,
      filled: qty > 0 && price > 0,
      qty,
      totalQty,
      price,
      avgPrice,
      limitPrice,
      fees,
      commission,
      multiplier: futuresMultiplier(symbol),
      timeInForce: get('tif'),
      placedText,
      filledText,
      filledAt: parseBrokerTime(filledText) ?? parseBrokerTime(placedText),
      placedAt: parseBrokerTime(placedText),
      seq: executions.length
    }
    const idVal = idTrusted ? get('orderId').trim() : ''
    e.hash = idVal ? `v2|${symbol}|${side}|id:${idVal}` : execHash(e)
    executions.push(e)
  }
  assignOccurrenceHashes(executions)
  return { executions, errors, columns: header, broker, ignored }
}

/** Back-compat alias (the parser now accepts any broker's export). */
export const parseWebullCsv = parseBrokerCsv

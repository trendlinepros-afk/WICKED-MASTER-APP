/**
 * Webull "Orders Records" CSV parser (pure — no Node/Electron), so it can be
 * unit-tested directly against real exports.
 *
 * Columns (matched by HEADER NAME, so column reordering is tolerated):
 *   Name, Symbol, Side, Status, Filled, Total Qty, Price, Avg Price,
 *   Time-in-Force, Placed Time, Filled Time
 *
 * Quirks handled:
 *  - Prices sometimes carry a leading "@" (e.g. "@217.00") — stripped.
 *  - Cancelled orders have Filled=0 and empty Avg Price / Filled Time.
 *  - Times look like "07/15/2026 12:41:25 EDT"; parsed with an explicit ET
 *    offset (EDT=-04:00, EST=-05:00) so results don't depend on the host TZ.
 *  - Names may (in other exports) contain commas → a real quoted-CSV splitter.
 */

export type Side = 'buy' | 'sell' | 'short'

export interface Execution {
  /** stable de-dup key (Webull exports carry no order id) */
  hash: string
  name: string
  symbol: string
  side: Side
  /** raw side text from the file (Buy / Sell / Short / Sell Short / Buy to Cover) */
  sideRaw: string
  status: string
  filled: boolean
  /** filled quantity (shares) */
  qty: number
  /** total order quantity */
  totalQty: number
  /** effective execution price (Avg Price when present, else Price) */
  price: number
  avgPrice: number
  limitPrice: number
  timeInForce: string
  placedText: string
  filledText: string
  /** epoch ms of the fill (or placed time if no fill), null if unparseable */
  filledAt: number | null
  placedAt: number | null
}

export interface ParseResult {
  executions: Execution[]
  /** rows that couldn't be parsed (bad/blank lines), with a reason */
  errors: { line: number; reason: string }[]
  /** header columns actually seen */
  columns: string[]
}

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
  GMT: '+00:00'
}

/** Split one CSV line honoring double-quoted fields (with "" escapes). */
export function splitCsvLine(line: string): string[] {
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
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/** "07/15/2026 12:41:25 EDT" → epoch ms (host-TZ-independent), or null. */
export function parseWebullTime(text: string): number | null {
  const s = (text || '').trim()
  if (!s) return null
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s+([A-Z]{2,4}))?$/)
  if (m) {
    const [, mo, d, y, hh, mm, ss, tz] = m
    const off = tz && TZ_OFFSET[tz] ? TZ_OFFSET[tz] : '-04:00' // default to ET summer
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}${off}`
    const t = Date.parse(iso)
    return Number.isNaN(t) ? null : t
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function num(v: string): number {
  const cleaned = (v || '').replace(/[@$,\s]/g, '')
  if (!cleaned) return 0
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : 0
}

function normSide(raw: string): Side {
  const s = (raw || '').trim().toLowerCase()
  if (s === 'short' || s === 'sell short' || s === 'sellshort') return 'short'
  if (s === 'buy to cover' || s === 'buy-to-cover' || s.startsWith('cover')) return 'buy'
  if (s.startsWith('sell')) return 'sell'
  return 'buy'
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name'],
  symbol: ['symbol', 'ticker'],
  side: ['side'],
  status: ['status'],
  filled: ['filled', 'filled qty', 'filledqty'],
  totalQty: ['total qty', 'totalqty', 'quantity', 'qty'],
  price: ['price'],
  avgPrice: ['avg price', 'avgprice', 'average price'],
  tif: ['time-in-force', 'time in force', 'tif'],
  placed: ['placed time', 'placed', 'placed time(edt)'],
  filledTime: ['filled time', 'filled time(edt)', 'executed time']
}

function buildColMap(header: string[]): Record<string, number> {
  const lower = header.map((h) => h.toLowerCase().trim())
  const map: Record<string, number> = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = lower.findIndex((h) => aliases.includes(h))
    if (idx >= 0) map[key] = idx
  }
  return map
}

/** Stable de-dup hash for a row. Webull has no order id, so we compose one. */
export function execHash(e: {
  symbol: string
  sideRaw: string
  status: string
  placedText: string
  filledText: string
  qty: number
  totalQty: number
  price: number
  avgPrice: number
}): string {
  return [
    e.symbol,
    e.sideRaw.toLowerCase(),
    e.status.toLowerCase(),
    e.placedText,
    e.filledText,
    e.qty,
    e.totalQty,
    e.price,
    e.avgPrice
  ].join('|')
}

export function parseWebullCsv(text: string): ParseResult {
  const errors: ParseResult['errors'] = []
  const executions: Execution[] = []
  const rawLines = text.split(/\r?\n/)
  // find header line (first non-empty)
  let headerIdx = rawLines.findIndex((l) => l.trim().length > 0)
  if (headerIdx < 0) return { executions, errors, columns: [] }
  const header = splitCsvLine(rawLines[headerIdx])
  const col = buildColMap(header)
  if (col.symbol === undefined || col.side === undefined) {
    return {
      executions,
      errors: [{ line: headerIdx + 1, reason: 'Not a Webull orders CSV (no Symbol/Side columns).' }],
      columns: header
    }
  }

  for (let i = headerIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (!line.trim()) continue
    const f = splitCsvLine(line)
    const get = (k: string): string => (col[k] !== undefined ? (f[col[k]] ?? '') : '')
    const symbol = get('symbol').toUpperCase()
    if (!symbol) {
      errors.push({ line: i + 1, reason: 'Missing symbol.' })
      continue
    }
    const sideRaw = get('side')
    const status = get('status') || 'Filled'
    const avgPrice = num(get('avgPrice'))
    const limitPrice = num(get('price'))
    const qty = num(get('filled'))
    const totalQty = num(get('totalQty')) || qty
    const placedText = get('placed')
    const filledText = get('filledTime')
    const price = avgPrice > 0 ? avgPrice : limitPrice
    const e: Execution = {
      hash: '',
      name: get('name'),
      symbol,
      side: normSide(sideRaw),
      sideRaw,
      status,
      filled: status.toLowerCase() === 'filled' && qty > 0,
      qty,
      totalQty,
      price,
      avgPrice,
      limitPrice,
      timeInForce: get('tif'),
      placedText,
      filledText,
      filledAt: parseWebullTime(filledText) ?? parseWebullTime(placedText),
      placedAt: parseWebullTime(placedText)
    }
    e.hash = execHash(e)
    executions.push(e)
  }
  return { executions, errors, columns: header }
}

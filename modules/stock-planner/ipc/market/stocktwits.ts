/**
 * StockTwits client (free, finance-specific) — recent per-symbol message stream
 * with the community's Bullish/Bearish sentiment tags, used as a SECOND social
 * source alongside X. Fail-soft (returns null on any error / rate-limit); the
 * classify function is pure/unit-tested.
 */

const TIMEOUT_MS = 10_000

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export interface StockTwitsRead {
  /** recent messages returned (a buzz proxy — StockTwits caps the stream ~30) */
  messages: number
  bullish: number
  bearish: number
  /** (bull − bear) / tagged, [-1, 1]; 0 when nothing is tagged */
  sentiment: number
}

/** Tally Bullish/Bearish tags from a StockTwits symbol stream (pure). */
export function classifyStream(json: unknown): StockTwitsRead {
  const msgs = arr(rec(json).messages)
  let bullish = 0
  let bearish = 0
  for (const m of msgs) {
    const basic = String(rec(rec(rec(m).entities).sentiment).basic ?? '')
    if (basic === 'Bullish') bullish++
    else if (basic === 'Bearish') bearish++
  }
  const tagged = bullish + bearish
  return { messages: msgs.length, bullish, bearish, sentiment: tagged > 0 ? (bullish - bearish) / tagged : 0 }
}

const cache = new Map<string, { at: number; read: StockTwitsRead }>()
const TTL_MS = 30 * 60 * 1000

export async function getStockTwits(symbol: string): Promise<StockTwitsRead | null> {
  const sym = symbol.toUpperCase()
  const hit = cache.get(sym)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.read
  try {
    const resp = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!resp.ok) return null
    const read = classifyStream(await resp.json())
    cache.set(sym, { at: Date.now(), read })
    return read
  } catch {
    return null
  }
}

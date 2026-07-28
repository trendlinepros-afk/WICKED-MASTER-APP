/**
 * FINRA daily short-sale volume (free, no key) — what fraction of today's tape
 * was sold short, per symbol. High short-volume % (~60%+) = heavy shorting
 * pressure and squeeze fuel; fills the gap when Finnhub's short-interest field
 * is premium. One ~pipe-delimited file per trading day; parsed once and cached.
 *
 * File: https://cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt
 * Format: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
 */

const TIMEOUT_MS = 20_000

export interface ShortVol {
  shortVolume: number
  totalVolume: number
  /** short volume as % of total, rounded */
  ratioPct: number
}

/** Parse one CNMSshvol file (pure). Skips the header and junk lines. */
export function parseShortFile(text: string): Map<string, ShortVol> {
  const map = new Map<string, ShortVol>()
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 5) continue
    const sym = parts[1]?.trim().toUpperCase()
    const shortVolume = Number(parts[2])
    const totalVolume = Number(parts[4])
    if (!sym || sym === 'SYMBOL' || !Number.isFinite(shortVolume) || !Number.isFinite(totalVolume) || totalVolume <= 0) continue
    map.set(sym, { shortVolume, totalVolume, ratioPct: Math.round((shortVolume / totalVolume) * 100) })
  }
  return map
}

let cache: { key: string; map: Map<string, ShortVol> } | null = null

/** The latest available day's short-volume map (walks back ≤6 days; null = unavailable). */
export async function getFinraShortMap(): Promise<Map<string, ShortVol> | null> {
  for (let back = 0; back <= 6; back++) {
    const d = new Date(Date.now() - back * 86_400_000)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) continue
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, '')
    if (cache && cache.key === ymd) return cache.map
    try {
      const resp = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${ymd}.txt`, {
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!resp.ok) continue
      const map = parseShortFile(await resp.text())
      if (map.size > 100) {
        cache = { key: ymd, map }
        return map
      }
    } catch {
      /* try the previous day */
    }
  }
  return null
}

export async function getShortVolRatio(sym: string): Promise<number | null> {
  const map = await getFinraShortMap()
  return map?.get(sym.toUpperCase())?.ratioPct ?? null
}

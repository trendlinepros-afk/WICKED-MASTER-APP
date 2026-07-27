/**
 * "Stock Trading/{TICKER — Company}" folder matching (pure, ported rule):
 * word-boundary prefix match so RPD never matches RPDX. A folder matches when
 * it IS the ticker, or starts with the ticker followed by a non-alphanumeric
 * boundary (space, dash, em-dash…).
 */
export function matchStockFolder(existingDirs: string[], ticker: string): string | null {
  const t = ticker.toUpperCase()
  for (const dir of existingDirs) {
    const name = dir.toUpperCase()
    if (name === t) return dir
    if (name.startsWith(t)) {
      const next = name[t.length]
      if (next !== undefined && !/[A-Z0-9]/.test(next)) return dir
    }
  }
  return null
}

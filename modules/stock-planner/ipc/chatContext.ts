/**
 * Chat context injection (the "secret sauce", ported):
 *  - cashtags ($JBLU) always count; bare ALL-CAPS words are filtered through a
 *    stopword list so "IT" / "ALL" / "EPS" never resolve as tickers; max 3.
 *  - if the message names none, the conversation title + recent messages are
 *    scanned so "what's its P/E?" still resolves.
 */

const STOPWORDS = new Set(
  (
    'A AI ALL AM AN AND ANY ARE AS AT ATH BE BIG BUY BY CAN CEO CFO COO CPI CPU DAY DD DID DO DOES DONT EOD EPS ETF ETFS FAQ FED FOR FROM FYI GDP GET GO GOOD HAS HAVE HELP HIGH HOLD HOW I IF IMO IN IPO IPOS IRA IS IT ITS JUST LOL LOW MACD ME MY NEW NEXT NO NOT NOW NYSE OF OK ON ONE OR OTC OUT OVER P PDF PE PM PRE PLAN PUT Q1 Q2 Q3 Q4 RSI SEC SELL SET SMA SO STOP THE THIS TLDR TO TOP UP US USA USD VWAP WAS WE WHAT WHEN WHO WHY WILL WITH YES YOU YOY YTD EMA EBITDA CAGR ROI API APP CSV JSON URL'
  ).split(/\s+/)
)

/** Extract up to `max` candidate tickers from a message. Cashtags first. */
export function extractTickers(text: string, max = 3): string[] {
  const out: string[] = []
  const push = (sym: string): void => {
    const s = sym.toUpperCase()
    if (s.length >= 1 && s.length <= 5 && !out.includes(s) && out.length < max) out.push(s)
  }
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) push(m[1])
  // Bare symbols must be 2–5 chars: single letters ("P/E" -> E) are noise, and
  // real one-letter tickers (F, T, S) are still reachable via their cashtag.
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    if (!STOPWORDS.has(m[1])) push(m[1])
  }
  return out
}

/** Fallback scan: title + recent messages, for "what's its P/E?" turns. */
export function extractTickersWithFallback(
  message: string,
  title: string,
  recentMessages: string[],
  max = 3
): string[] {
  const direct = extractTickers(message, max)
  if (direct.length > 0) return direct
  const scan = [title, ...recentMessages.slice(-6)].join(' \n ')
  return extractTickers(scan, max)
}

export function mentionsIpos(text: string): boolean {
  return /\bIPOs?\b/i.test(text)
}

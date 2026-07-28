/**
 * Catalyst classification from news headlines (pure, unit-tested). Turns "it has
 * news" into "WHY it's moving" — and, critically, flags the news retail traders
 * get trapped by: a stock **offering / dilution**. Order matters: the dangerous
 * types are checked first so a dilution headline is never mislabeled as
 * "earnings" just because it also says "priced".
 */

export interface Catalyst {
  type: string
  /** true = a headline to be cautious of (dilution / downgrade / going concern) */
  avoid: boolean
  label: string
}

const RULES: { type: string; avoid: boolean; label: string; kw: string[] }[] = [
  {
    type: 'Offering',
    avoid: true,
    label: 'Dilution / Offering',
    kw: [
      'offering', 'dilution', 'registered direct', 'at-the-market', 'atm program', 'shelf registration',
      'public offering', 'private placement', 'priced at', 'prices $', 'pricing of', 'warrants', 'convertible notes',
      'proposed offering', 'reverse split', 'going concern', 'nasdaq deficiency', 'delisting'
    ]
  },
  { type: 'Downgrade', avoid: true, label: 'Downgrade', kw: ['downgrade', 'cut to', 'lowered to', 'underperform rating', 'sell rating', 'reduces price target', 'lowers price target'] },
  { type: 'M&A', avoid: false, label: 'M&A / Buyout', kw: ['to acquire', 'acquisition of', 'to be acquired', 'merger', 'buyout', 'takeover', 'agrees to buy', 'deal to buy', 'tender offer'] },
  { type: 'FDA', avoid: false, label: 'FDA / Trial', kw: ['fda', 'approval', 'approved', 'phase 1', 'phase 2', 'phase 3', 'clinical trial', 'breakthrough', 'pdufa', 'topline', 'trial results'] },
  { type: 'Upgrade', avoid: false, label: 'Analyst Upgrade', kw: ['upgrade', 'initiated at buy', 'initiates coverage', 'raises price target', 'raised to', 'outperform rating', 'buy rating', 'overweight'] },
  { type: 'Guidance', avoid: false, label: 'Guidance', kw: ['raises guidance', 'raises outlook', 'boosts forecast', 'cuts guidance', 'lowers guidance', 'preliminary results'] },
  { type: 'Earnings', avoid: false, label: 'Earnings', kw: ['earnings', 'beats', 'misses estimates', 'quarterly results', 'q1 ', 'q2 ', 'q3 ', 'q4 ', 'reports revenue', ' eps '] },
  { type: 'Partnership', avoid: false, label: 'Deal / Contract', kw: ['partnership', 'collaboration', 'contract award', 'awarded', 'signs deal', 'agreement with', 'wins order'] }
]

export function classifyCatalyst(titles: string[]): Catalyst | null {
  const clean = titles.filter((t) => typeof t === 'string' && t.trim())
  if (clean.length === 0) return null
  const hay = ' ' + clean.join(' || ').toLowerCase() + ' '
  for (const r of RULES) {
    if (r.kw.some((k) => hay.includes(k))) return { type: r.type, avoid: r.avoid, label: r.label }
  }
  return { type: 'News', avoid: false, label: 'News' }
}

/**
 * News VELOCITY — how many headlines landed in the last 24h / 72h (catalyst
 * intensity). `hot` = a heavy recent news flow. Pure; publishedAt is an ISO
 * string (a tiny future skew is tolerated for feed clock drift).
 */
export function newsVelocity(news: { publishedAt: string }[], nowMs: number): { count24h: number; count72h: number; hot: boolean } {
  let count24h = 0
  let count72h = 0
  for (const n of news) {
    const t = Date.parse(n?.publishedAt || '')
    if (Number.isNaN(t)) continue
    const age = nowMs - t
    if (age < -3_600_000) continue // more than 1h in the future = bad timestamp
    if (age <= 24 * 3_600_000) count24h++
    if (age <= 72 * 3_600_000) count72h++
  }
  return { count24h, count72h, hot: count24h >= 3 }
}

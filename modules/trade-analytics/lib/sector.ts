/**
 * Map a granular SIC industry string (Massive/Polygon's `sic_description`, e.g.
 * "AIR TRANSPORTATION, SCHEDULED") to a broad market sector so the Market Sector
 * P&L card groups into ~11 buckets instead of hundreds of SIC codes. Pure +
 * unit-tested; first keyword hit in list order wins.
 */

const RULES: { sector: string; keywords: string[] }[] = [
  { sector: 'Financials', keywords: ['bank', 'financ', 'insurance', 'credit', 'investment', 'securit', 'brokers', 'savings', 'loan', 'mortgage cred'] },
  { sector: 'Healthcare', keywords: ['pharmaceutical', 'medic', 'health', 'biolog', 'surgical', 'drug', 'diagnostic', 'dental', 'hospital', 'in vitro', 'laboratories'] },
  { sector: 'Technology', keywords: ['software', 'semiconductor', 'computer', 'electronic', 'data processing', 'internet', 'prepackaged', 'communications equipment', 'instruments', 'technolog'] },
  { sector: 'Energy', keywords: ['petroleum', 'oil', 'natural gas', ' gas ', 'coal', 'drilling', 'energy', 'refining', 'pipeline'] },
  { sector: 'Utilities', keywords: ['electric services', 'utilit', 'water supply', 'gas distribution', 'power', 'sanitary'] },
  { sector: 'Real Estate', keywords: ['real estate', 'reit', 'land subdivid', 'operators of'] },
  { sector: 'Communication Services', keywords: ['telephone', 'telecommunic', 'broadcast', 'motion picture', 'advertising', 'publishing', 'cable', 'newspaper', 'radio', 'television'] },
  { sector: 'Consumer Staples', keywords: ['food', 'beverage', 'grocer', 'household', 'tobacco', 'soap', 'dairy', 'bakery', 'agricultur'] },
  { sector: 'Consumer Discretionary', keywords: ['retail', 'apparel', 'restaurant', 'eating', 'auto', 'motor vehicle', 'hotel', 'leisure', 'furniture', 'jewelry', 'footwear', 'toys', 'catalog', 'home'] },
  { sector: 'Materials', keywords: ['mining', 'metal', 'chemical', 'steel', 'gold', 'paper', 'forest', 'lumber', 'plastic', 'cement', 'glass', 'copper'] },
  { sector: 'Industrials', keywords: ['air transportation', 'aircraft', 'machinery', 'construction', 'industrial', 'transportation', 'freight', 'aerospace', 'defense', 'railroad', 'trucking', 'engineering', 'equipment rental', 'manufactur', 'shipbuilding'] }
]

export function classifySector(sicDescription: string): string {
  const s = ` ${(sicDescription || '').toLowerCase()} `
  if (!s.trim()) return 'Unclassified'
  for (const rule of RULES) {
    if (rule.keywords.some((k) => s.includes(k))) return rule.sector
  }
  return 'Other'
}

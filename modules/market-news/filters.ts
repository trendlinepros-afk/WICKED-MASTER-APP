/**
 * Pure headline filtering/sorting (unit-testable, no React). Finnhub general
 * news has no sector metadata, so the sector dropdown is a keyword classifier
 * over title+summary — same approach the ported dashboard used.
 */

export interface NewsRow {
  title: string
  url: string
  source: string
  publishedAt: string
  summary?: string
}

export interface SectorDef {
  id: string
  label: string
  keywords: string[]
}

export const SECTORS: SectorDef[] = [
  { id: 'all', label: 'All sectors', keywords: [] },
  {
    id: 'tech',
    label: 'Technology',
    keywords: ['tech', ' ai ', 'artificial intelligence', 'chip', 'semiconductor', 'software', 'cloud', 'cyber', 'apple', 'microsoft', 'google', 'alphabet', 'nvidia', 'meta ', 'amazon web', 'data center', 'iphone', 'android']
  },
  {
    id: 'energy',
    label: 'Energy',
    keywords: ['oil', 'crude', 'gas ', 'natural gas', 'opec', 'shale', 'drilling', 'refinery', 'energy', 'solar', 'wind power', 'barrel', 'petroleum', 'exxon', 'chevron']
  },
  {
    id: 'financials',
    label: 'Financials',
    keywords: ['bank', 'fed ', 'federal reserve', 'rate cut', 'rate hike', 'interest rate', 'treasury', 'bond', 'financ', 'insurance', 'credit', 'lending', 'goldman', 'jpmorgan', 'inflation', 'dollar', 'currency', 'rupee', 'yen ', 'euro ']
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    keywords: ['pharma', 'drug', 'fda', 'health', 'biotech', 'vaccine', 'medical', 'clinical trial', 'pfizer', 'moderna', 'medicare']
  },
  {
    id: 'consumer',
    label: 'Consumer & Retail',
    keywords: ['retail', 'consumer', 'restaurant', 'apparel', 'walmart', 'target ', 'costco', 'starbucks', 'nike', 'e-commerce', 'holiday sales', 'shopper']
  },
  {
    id: 'industrials',
    label: 'Industrials & Transport',
    keywords: ['airline', 'aviation', 'boeing', 'airbus', 'shipping', 'freight', 'rail', 'manufactur', 'factory', 'auto ', 'automaker', 'aerospace', 'defense', 'tesla', 'ford', 'gm ', 'red sea', 'supply chain']
  },
  {
    id: 'materials',
    label: 'Materials & Mining',
    keywords: ['mining', 'steel', 'copper', 'gold', 'silver', 'lithium', 'commodit', 'chemical', 'aluminum', 'iron ore']
  },
  {
    id: 'utilities',
    label: 'Utilities & Power',
    keywords: ['utility', 'utilities', 'power grid', 'electricity', 'nuclear', 'hydro', 'renewable']
  },
  {
    id: 'realestate',
    label: 'Real Estate',
    keywords: ['real estate', 'housing', 'mortgage', 'reit', 'homebuilder', 'home sales', 'rent ', 'property']
  },
  {
    id: 'communication',
    label: 'Media & Telecom',
    keywords: ['media', 'streaming', 'telecom', 'advertising', 'netflix', 'disney', 'broadband', '5g ']
  },
  {
    id: 'crypto',
    label: 'Crypto',
    keywords: ['bitcoin', 'crypto', 'ethereum', 'blockchain', 'stablecoin', 'btc ', 'coinbase']
  }
]

export type SortId = 'newest' | 'oldest' | 'source' | 'title'

export const SORTS: { id: SortId; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'source', label: 'Source A–Z' },
  { id: 'title', label: 'Title A–Z' }
]

/** Case-insensitive keyword match over title+summary; 'all' passes everything. */
export function filterBySector(rows: NewsRow[], sectorId: string): NewsRow[] {
  const sector = SECTORS.find((s) => s.id === sectorId)
  if (!sector || sector.keywords.length === 0) return rows
  return rows.filter((r) => {
    // pad so word-edge keywords like ' ai ' / 'gas ' can match at ends too
    const hay = ` ${r.title} ${r.summary ?? ''} `.toLowerCase()
    return sector.keywords.some((k) => hay.includes(k))
  })
}

export function sortRows(rows: NewsRow[], sort: SortId): NewsRow[] {
  const t = (r: NewsRow): number => {
    const ms = new Date(r.publishedAt).getTime()
    return Number.isNaN(ms) ? 0 : ms
  }
  const out = [...rows]
  switch (sort) {
    case 'oldest':
      return out.sort((a, b) => t(a) - t(b))
    case 'source':
      return out.sort((a, b) => a.source.localeCompare(b.source) || t(b) - t(a))
    case 'title':
      return out.sort((a, b) => a.title.localeCompare(b.title))
    case 'newest':
    default:
      return out.sort((a, b) => t(b) - t(a))
  }
}

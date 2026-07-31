/**
 * Categorization + merchant normalization (pure — shared by main import logic
 * and the renderer's pickers). Keyword matching runs on the RAW uppercase
 * description; the normalized merchant key is what rules and grouping key on.
 */

export const PAYMENTS_CATEGORY = 'Payments & Credits'

export const CATEGORIES = [
  'Groceries',
  'Dining & Drinks',
  'Gas & Auto',
  'Transport',
  'Travel',
  'Shopping',
  'Entertainment',
  'Streaming & Software',
  'Health & Fitness',
  'Bills & Utilities',
  'Home & Garden',
  'Fees & Interest',
  PAYMENTS_CATEGORY,
  'Other'
] as const

const PAYMENT_KW = [
  'PAYMENT', 'AUTOPAY', 'AUTO PAY', 'THANK YOU', 'ONLINE PMT', 'MOBILE PMT',
  'E-PAYMENT', 'EPAYMENT', 'DIRECTPAY', 'BILL PAY', 'ACH DEPOSIT', 'ACH PMT'
]

/** Digital services that are near-certainly subscriptions. */
const DIGITAL_SUBS = [
  'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'HBO', 'PARAMOUNT+', 'PARAMOUNT PLUS', 'PEACOCK',
  'CRUNCHYROLL', 'YOUTUBE PREMIUM', 'YOUTUBE TV', 'YOUTUBETV', 'APPLE.COM/BILL', 'APPLE.COM BILL',
  'ITUNES', 'ICLOUD', 'AUDIBLE', 'KINDLE UNLIMITED', 'PRIME VIDEO', 'AMAZON PRIME', 'AMZN PRIME',
  'OPENAI', 'CHATGPT', 'ANTHROPIC', 'CLAUDE.AI', 'MIDJOURNEY', 'GITHUB', 'ADOBE', 'CANVA',
  'DROPBOX', 'GOOGLE ONE', 'GOOGLE STORAGE', 'MICROSOFT 365', 'OFFICE 365', 'XBOX GAME PASS',
  'GAMEPASS', 'PLAYSTATION NETWORK', 'NINTENDO SWITCH ONLINE', 'DISCORD NITRO', 'TWITCH',
  'PATREON', 'SUBSTACK', 'MEDIUM.COM', 'NYTIMES', 'NY TIMES', 'WSJ', 'THE ECONOMIST',
  'DUOLINGO', 'HEADSPACE', 'EXPRESSVPN', 'NORDVPN', 'SURFSHARK', '1PASSWORD', 'LASTPASS',
  'GRAMMARLY', 'NOTION', 'ZOOM.US', 'RING.COM', 'PELOTON', 'STRAVA'
]

/** Memberships that are subscriptions but belong in Health & Fitness. */
const GYM_SUBS = [
  'PLANET FIT', 'LA FITNESS', 'ANYTIME FIT', '24 HOUR FIT', 'EQUINOX', 'CRUNCH FIT',
  'GOLDS GYM', "GOLD'S GYM", 'ORANGETHEORY', 'YMCA'
]

/** Every keyword that should flag "subscription" on import. */
const SUB_KEYWORDS = [...DIGITAL_SUBS, ...GYM_SUBS, 'COSTCO MEMBERSHIP', 'SAMS CLUB MEMBERSHIP']

/** First-hit-wins category keyword rules (checked against the raw UPPERCASE description). */
const RULES: { category: (typeof CATEGORIES)[number]; kw: string[] }[] = [
  {
    category: 'Fees & Interest',
    kw: ['INTEREST CHARGE', 'PURCHASE INTEREST', 'ANNUAL FEE', 'LATE FEE', 'RETURNED PAYMENT', 'FOREIGN TRANSACTION', 'CASH ADVANCE', ' FEE']
  },
  { category: 'Streaming & Software', kw: DIGITAL_SUBS },
  {
    category: 'Groceries',
    kw: ['KROGER', 'SAFEWAY', 'ALBERTSONS', 'WALMART', 'WAL-MART', 'COSTCO', 'SAMS CLUB', "SAM'S CLUB", 'WHOLE FOODS', 'WHOLEFDS', 'TRADER JOE', 'ALDI', 'PUBLIX', 'WEGMANS', 'H-E-B', 'HEB ', 'MEIJER', 'WINCO', 'SPROUTS', 'FOOD LION', 'STOP & SHOP', 'GIANT EAGLE', 'INSTACART', 'GROCERY']
  },
  {
    category: 'Dining & Drinks',
    kw: ['MCDONALD', 'STARBUCKS', 'CHIPOTLE', 'CHICK-FIL-A', 'CHICKFILA', 'TACO BELL', 'WENDY', 'BURGER KING', 'SUBWAY', 'DOMINO', 'PIZZA', 'DUNKIN', 'PANERA', 'KFC', 'POPEYE', 'SONIC DRIVE', 'ARBY', 'CHILIS', 'OLIVE GARDEN', 'IHOP', 'DENNY', 'RESTAURANT', 'GRILL', 'CAFE', 'COFFEE', 'DOORDASH', 'UBER EATS', 'UBEREATS', 'GRUBHUB', 'POSTMATES', 'TST*', 'TST *']
  },
  {
    category: 'Gas & Auto',
    kw: ['SHELL', 'CHEVRON', 'EXXON', 'MOBIL', 'BP ', 'CIRCLE K', '7-ELEVEN', 'MARATHON', 'SUNOCO', 'VALERO', 'PHILLIPS 66', 'SPEEDWAY', 'WAWA', 'QUIKTRIP', 'RACETRAC', 'PILOT ', "LOVE'S", 'AUTOZONE', "O'REILLY", 'OREILLY', 'ADVANCE AUTO', 'JIFFY LUBE', 'VALVOLINE', 'CAR WASH', 'CARWASH', 'TESLA SUPERCHARGER', 'CHARGEPOINT', 'EVGO', 'ELECTRIFY AMERICA']
  },
  {
    category: 'Transport',
    kw: ['UBER', 'LYFT', 'TRANSIT', 'METRO ', 'MTA ', 'PARKING', 'PARKMOBILE', 'SPOTHERO', 'TOLL', 'E-ZPASS', 'EZPASS', 'EZ PASS', 'AMTRAK']
  },
  {
    category: 'Travel',
    kw: ['DELTA AIR', 'UNITED AIR', 'AMERICAN AIR', 'SOUTHWEST', 'ALASKA AIR', 'JETBLUE', 'SPIRIT AIR', 'FRONTIER AIR', 'HOTEL', 'MARRIOTT', 'HILTON', 'HYATT', 'AIRBNB', 'VRBO', 'EXPEDIA', 'BOOKING.COM', 'PRICELINE', 'HERTZ', 'AVIS ', 'ENTERPRISE RENT', 'BUDGET RENT', 'CRUISE', 'AIRLINE', 'AIRWAYS']
  },
  { category: 'Health & Fitness', kw: [...GYM_SUBS, 'CVS', 'WALGREENS', 'RITE AID', 'PHARMACY', 'DENTAL', 'MEDICAL', 'CLINIC', 'HOSPITAL', 'OPTOMETR', 'VISION', 'GNC ', 'VITAMIN'] },
  {
    category: 'Bills & Utilities',
    kw: ['AT&T', 'ATT ', 'VERIZON', 'T-MOBILE', 'TMOBILE', 'COMCAST', 'XFINITY', 'SPECTRUM', 'COX COMM', 'CENTURYLINK', 'ELECTRIC', 'POWER CO', 'ENERGY', 'WATER DEPT', 'UTILIT', 'GEICO', 'PROGRESSIVE', 'STATE FARM', 'ALLSTATE', 'INSURANCE', 'INTERNET', 'WIRELESS']
  },
  {
    category: 'Entertainment',
    kw: ['CINEMA', 'AMC ', 'REGAL', 'MOVIE', 'TICKETMASTER', 'STUBHUB', 'EVENTBRITE', 'STEAM', 'STEAMGAMES', 'EPIC GAMES', 'PLAYSTATION', 'NINTENDO', 'XBOX', 'TOPGOLF', 'DAVE & BUSTER', 'BOWLING', 'MUSEUM', 'THEME PARK', 'SIX FLAGS']
  },
  { category: 'Home & Garden', kw: ['HOME DEPOT', "LOWE'S", 'LOWES', 'IKEA', 'WAYFAIR', 'ACE HARDWARE', 'MENARDS', 'POTTERY BARN'] },
  {
    category: 'Shopping',
    kw: ['AMAZON', 'AMZN', 'TARGET', 'BEST BUY', 'EBAY', 'ETSY', 'MACY', 'NORDSTROM', 'TJ MAXX', 'TJMAXX', 'MARSHALLS', 'ROSS ', 'KOHL', 'NIKE', 'ADIDAS', 'LULULEMON', 'SHEIN', 'TEMU', 'ALIEXPRESS', 'APPLE STORE', 'OLD NAVY', 'H&M', 'ZARA', 'SEPHORA', 'ULTA', 'DICKS SPORTING', "DICK'S SPORTING", 'REI ', 'BARNES']
  }
]

export function isPayment(descUpper: string): boolean {
  return PAYMENT_KW.some((k) => descUpper.includes(k))
}

export function isKnownSub(descUpper: string): boolean {
  return SUB_KEYWORDS.some((k) => descUpper.includes(k))
}

/** Auto category for a raw description (payments handled by the caller first). */
export function autoCategory(descUpper: string): string {
  if (isPayment(descUpper)) return PAYMENTS_CATEGORY
  for (const r of RULES) if (r.kw.some((k) => descUpper.includes(k))) return r.category
  return 'Other'
}

/**
 * Normalize a statement description into a stable merchant KEY: uppercase,
 * processor prefixes kept as words (SQ *, TST*, PAYPAL *…), digits/punctuation
 * dropped, whitespace collapsed. Rules and subscription grouping key on this.
 */
export function normalizeMerchant(desc: string): string {
  let s = desc.toUpperCase()
  s = s.replace(/^(SQ|TST|PAYPAL|PYPL|PP|SP|CKE)\s*\*\s*/, '$1 ')
  s = s.replace(/[*#]/g, ' ')
  s = s.replace(/\d+/g, ' ')
  s = s.replace(/[^A-Z& ]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return (s || desc.toUpperCase().trim()).slice(0, 48)
}

/** Friendly default display name from a raw description. */
export function autoName(desc: string): string {
  const n = normalizeMerchant(desc)
    .replace(/\b(COM|WWW|INC|LLC|CORP|CO|USA|US)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const base = n || normalizeMerchant(desc) || desc.trim()
  return (
    base
      .toLowerCase()
      .replace(/(^|[\s&])[a-z]/g, (c) => c.toUpperCase())
      .slice(0, 48) || desc.slice(0, 48)
  )
}

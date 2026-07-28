/**
 * X (Twitter) API v2 client — social ticker trends for Find Trades.
 *
 * Uses app-only OAuth2 (a single Bearer Token from the vault, id 'x'). We search
 * finance tweets, pull the `$CASHTAG` entities, and tally which tickers are
 * mentioned most over a time window, with a lightweight bull/bear sentiment read
 * and a deterministic "heat" rating (buzz + price momentum + sentiment).
 *
 * Endpoint reality: recent-search covers the LAST 7 DAYS on Basic access;
 * windows longer than 7 days use the full-archive endpoint, which needs X API
 * Pro. Everything except the two fetch helpers is pure and unit-tested.
 */

const API_BASE = 'https://api.twitter.com/2'
const TIMEOUT_MS = 30_000
/** recent-search only reaches back 7 days; longer windows need full archive. */
export const RECENT_MAX_HOURS = 24 * 7

export interface XWindow {
  id: string
  label: string
  hours: number
}

export const X_WINDOWS: XWindow[] = [
  { id: '24h', label: '24 hours', hours: 24 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
  { id: '14d', label: '2 weeks', hours: 24 * 14 },
  { id: '30d', label: '1 month', hours: 24 * 30 },
  { id: '90d', label: '90 days', hours: 24 * 90 },
  { id: '180d', label: '6 months', hours: 24 * 180 }
]

export function windowById(id: string): XWindow {
  return X_WINDOWS.find((w) => w.id === id) ?? X_WINDOWS[0]
}

/* ------------------------------- sentiment ------------------------------- */

// Small finance lexicon — cheap, deterministic, no AI tokens spent per scan.
// Three tones: POSITIVE = confirmed good news / bullish; HOPEFUL = forward-
// looking optimism (a catalyst that HASN'T happened yet); NEGATIVE = bad news /
// bearish. Multi-word phrases are matched as substrings.
const POSITIVE = [
  'bullish', 'beat', 'upgrade', 'rally', 'all time high', 'ath', 'record high', 'strong', 'surge', 'soaring',
  'ripping', 'green', ' buy', 'buying', 'higher', 'outperform', 'accumulate', 'up big', 'jumps', 'jumped',
  'pops', 'popped', 'gains', 'crushed', 'blowout', 'raised guidance', 'partnership', 'approval', 'up ', 'winner'
]
const HOPEFUL = [
  'could', 'potential', 'catalyst', 'upcoming', 'soon', 'watch', 'watchlist', 'expecting', 'expect',
  'target', 'price target', ' pt ', 'breakout', 'setup', 'eyeing', 'poised', 'loading', 'accumulating',
  'next leg', 'coming', 'about to', 'gonna', 'building', ' base ', 'ready', 'run up', 'moon', 'rocket',
  'squeeze', 'undervalued', 'opportunity', 'keep an eye', 'if it', 'looking for', 'should', 'gap up'
]
const NEGATIVE = [
  'bearish', 'crash', 'dump', 'tank', 'plunge', 'miss', 'downgrade', 'bankruptcy', 'dilution', 'weak',
  'overvalued', 'avoid', 'bagholder', 'falling', ' sell', 'selling', 'sell off', 'selloff', ' short ',
  'puts', 'red ', 'drops', 'dropped', 'plummet', 'warning', 'fraud', 'halt', 'lawsuit', 'rug', 'loss',
  'down big', 'scam', 'cut guidance', 'delisting'
]

const countHits = (t: string, words: string[]): number => {
  let n = 0
  for (const w of words) if (t.includes(w)) n++
  return n
}

export type Tone = 'positive' | 'hopeful' | 'negative' | 'neutral'

/**
 * Classify one post's tone and derive two numbers:
 *  - sentiment [-1, 1]: positive/hopeful vs negative (feeds the heat rating)
 *  - growth {-1, +0.5, +1, 0}: the directional "proposed growth" contribution —
 *    confirmed good news counts full, hopeful/forward-looking counts half.
 */
export function analyzePost(text: string): { sentiment: number; growth: number; tone: Tone } {
  const t = ' ' + text.toLowerCase().replace(/[\n\r]+/g, ' ') + ' '
  const pos = countHits(t, POSITIVE)
  const hope = countHits(t, HOPEFUL)
  const neg = countHits(t, NEGATIVE)
  const posLike = pos + hope
  let tone: Tone = 'neutral'
  let growth = 0
  if (neg > posLike) {
    tone = 'negative'
    growth = -1
  } else if (posLike > neg) {
    if (pos >= hope && pos > 0) {
      tone = 'positive'
      growth = 1
    } else {
      tone = 'hopeful'
      growth = 0.5
    }
  }
  const sentiment = posLike + neg === 0 ? 0 : (posLike - neg) / (posLike + neg)
  return { sentiment, growth, tone }
}

/** Back-compat: just the [-1, 1] sentiment. */
export function scoreSentiment(text: string): number {
  return analyzePost(text).sentiment
}

/** Sentiment + growth values for an (AI- or lexicon-) assigned tone. */
export function toneScores(tone: Tone): { sentiment: number; growth: number } {
  return tone === 'positive'
    ? { sentiment: 1, growth: 1 }
    : tone === 'hopeful'
      ? { sentiment: 0.5, growth: 0.5 }
      : tone === 'negative'
        ? { sentiment: -1, growth: -1 }
        : { sentiment: 0, growth: 0 }
}

/* ------------------------------ AI tone read ----------------------------- */

/** One batched prompt to tone-classify every post (cheap: a single AI call). */
export function buildTonePrompt(texts: string[]): string {
  const lines = texts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')
  return (
    'You classify social posts about stocks. For EACH numbered post, output its overall tone toward the stock(s) it ' +
    'mentions: "positive" (confirmed good news / bullish), "hopeful" (forward-looking optimism that has NOT happened yet), ' +
    '"negative" (bad news / bearish), or "neutral". ' +
    `Return ONLY a JSON array of ${texts.length} lowercase strings in the same order — nothing else.\n\nPosts:\n${lines}`
  )
}

/** Parse the AI's tone array back to exactly n valid tones (default neutral). */
export function parseTones(raw: string, n: number): Tone[] {
  const valid = new Set(['positive', 'hopeful', 'negative', 'neutral'])
  let parsed: unknown = []
  try {
    let s = raw.trim()
    const f = s.match(/\[[\s\S]*\]/)
    if (f) s = f[0]
    parsed = JSON.parse(s)
  } catch {
    parsed = []
  }
  const list = Array.isArray(parsed) ? parsed : []
  const out: Tone[] = []
  for (let i = 0; i < n; i++) {
    const v = String(list[i] ?? '').toLowerCase().trim()
    out.push((valid.has(v) ? v : 'neutral') as Tone)
  }
  return out
}

/**
 * PROPOSED GROWTH grade for a ticker from the average tone of its posts. This is
 * a crowd-sentiment LEAN, not a forecast — the implied % is intentionally
 * bounded to ±15% and confidence scales with how many posts we saw.
 */
export function gradeGrowth(growthScore: number, mentions: number): {
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  label: string
  pct: number
  confidence: 'low' | 'medium' | 'high'
} {
  const g = Math.max(-1, Math.min(1, growthScore))
  const pct = Math.round(g * 15)
  let grade: 'A' | 'B' | 'C' | 'D' | 'F'
  let label: string
  if (g >= 0.55) {
    grade = 'A'
    label = 'Strong upside lean'
  } else if (g >= 0.3) {
    grade = 'B'
    label = 'Bullish lean'
  } else if (g >= 0.1) {
    grade = 'C'
    label = 'Slight upside'
  } else if (g > -0.1) {
    grade = 'D'
    label = 'Mixed / flat'
  } else {
    grade = 'F'
    label = 'Bearish lean'
  }
  const confidence = mentions >= 8 ? 'high' : mentions >= 3 ? 'medium' : 'low'
  return { grade, label, pct, confidence }
}

/* ------------------------------- cashtags -------------------------------- */

export function validTicker(t: string): boolean {
  return /^[A-Z]{1,6}$/.test(t)
}

interface XEntities {
  cashtags?: { tag?: string }[]
}

/** Cashtags from a tweet — entities first, regex fallback; upper-cased, valid. */
export function extractCashtags(entities: XEntities | undefined, text: string): string[] {
  const set = new Set<string>()
  for (const c of entities?.cashtags ?? []) {
    const tag = String(c?.tag ?? '').toUpperCase()
    if (validTicker(tag)) set.add(tag)
  }
  if (set.size === 0) {
    for (const m of text.match(/\$[A-Za-z]{1,6}\b/g) ?? []) {
      const tag = m.slice(1).toUpperCase()
      if (validTicker(tag)) set.add(tag)
    }
  }
  return [...set]
}

export interface XTweet {
  id: string
  text: string
  cashtags: string[]
  engagement: number
  /** post time (epoch ms), 0 if unknown — used for velocity/acceleration */
  createdAt: number
}

interface RawTweet {
  id?: string | number
  text?: string
  entities?: XEntities
  created_at?: string
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number }
}

/** Parse one search response page into tweets + the pagination token. */
export function parseSearchPage(json: unknown): { tweets: XTweet[]; nextToken: string | null } {
  const j = (json ?? {}) as { data?: RawTweet[]; meta?: { next_token?: string } }
  const data = Array.isArray(j.data) ? j.data : []
  const tweets = data.map((d): XTweet => {
    const text = String(d.text ?? '')
    const pm = d.public_metrics ?? {}
    const t = d.created_at ? Date.parse(d.created_at) : NaN
    return {
      id: String(d.id ?? ''),
      text,
      cashtags: extractCashtags(d.entities, text),
      engagement: Number(pm.like_count ?? 0) + Number(pm.retweet_count ?? 0) + Number(pm.quote_count ?? 0),
      createdAt: Number.isNaN(t) ? 0 : t
    }
  })
  const nextToken = j.meta?.next_token ? String(j.meta.next_token) : null
  return { tweets, nextToken }
}

/* -------------------------------- tallying ------------------------------- */

export interface Tally {
  ticker: string
  mentions: number
  engagement: number
  /** average sentiment over mentioning tweets, [-1, 1] */
  sentiment: number
  /** average growth-tone over mentioning tweets, [-1, 1] */
  growthScore: number
  positive: number
  hopeful: number
  negative: number
  neutral: number
  /** mentions in the recent vs older half of the sampled window */
  recentMentions: number
  olderMentions: number
  /** recent/older ratio (~1 = steady) and a label */
  accel: number
  velocity: 'accelerating' | 'steady' | 'fading' | '—'
}

/** Acceleration label from a ticker's recent-vs-older mention split. */
export function classifyVelocity(recent: number, older: number, total: number, spanOk: boolean): { accel: number; velocity: Tally['velocity'] } {
  if (!spanOk || total < 4) return { accel: 1, velocity: '—' }
  const accel = recent / Math.max(1, older)
  const velocity = accel >= 1.8 ? 'accelerating' : accel <= 0.55 ? 'fading' : 'steady'
  return { accel: Math.round(accel * 100) / 100, velocity }
}

/**
 * Count mentions per ticker across tweets, with tone breakdown + growth lean.
 * When `tones` is supplied (AI tone read, aligned by index) it overrides the
 * lexicon classification; otherwise the lexicon `analyzePost` is used.
 */
export function tallyMentions(tweets: XTweet[], tones?: Tone[]): Tally[] {
  // Split the sampled window in half by time so we can measure per-ticker
  // acceleration (chatter growing = more mentions in the recent half). Only
  // meaningful when we have real timestamps spanning a decent range.
  const times = tweets.map((t) => t.createdAt).filter((t) => t > 0)
  const minT = times.length ? Math.min(...times) : 0
  const maxT = times.length ? Math.max(...times) : 0
  const midT = (minT + maxT) / 2
  const spanOk = times.length >= 4 && maxT - minT >= 20 * 60 * 1000

  const map = new Map<
    string,
    { mentions: number; engagement: number; sSum: number; gSum: number; positive: number; hopeful: number; negative: number; neutral: number; recent: number; older: number }
  >()
  for (let i = 0; i < tweets.length; i++) {
    const tw = tweets[i]
    const a = tones && tones[i] ? { tone: tones[i], ...toneScores(tones[i]) } : analyzePost(tw.text)
    const isRecent = tw.createdAt > 0 && tw.createdAt >= midT
    for (const tag of tw.cashtags) {
      const e = map.get(tag) ?? { mentions: 0, engagement: 0, sSum: 0, gSum: 0, positive: 0, hopeful: 0, negative: 0, neutral: 0, recent: 0, older: 0 }
      e.mentions++
      e.engagement += tw.engagement
      e.sSum += a.sentiment
      e.gSum += a.growth
      if (a.tone === 'positive') e.positive++
      else if (a.tone === 'hopeful') e.hopeful++
      else if (a.tone === 'negative') e.negative++
      else e.neutral++
      if (tw.createdAt > 0) {
        if (isRecent) e.recent++
        else e.older++
      }
      map.set(tag, e)
    }
  }
  return [...map.entries()]
    .map(([ticker, e]) => {
      const v = classifyVelocity(e.recent, e.older, e.mentions, spanOk)
      return {
        ticker,
        mentions: e.mentions,
        engagement: e.engagement,
        sentiment: e.mentions ? e.sSum / e.mentions : 0,
        growthScore: e.mentions ? e.gSum / e.mentions : 0,
        positive: e.positive,
        hopeful: e.hopeful,
        negative: e.negative,
        neutral: e.neutral,
        recentMentions: e.recent,
        olderMentions: e.older,
        accel: v.accel,
        velocity: v.velocity
      }
    })
    .sort((a, b) => b.mentions - a.mentions || b.engagement - a.engagement)
}

/* -------------------------------- rating --------------------------------- */

/**
 * A 0–100 "heat" score: buzz (mentions vs the hottest ticker) 50%, price
 * momentum (today's move, ±10% saturates) 25%, and tweet sentiment 25%.
 */
export function rateTicker(o: { mentions: number; maxMentions: number; changePct: number | null; sentiment: number }): {
  score: number
  label: 'Hot' | 'Warm' | 'Watch' | 'Cool'
} {
  const buzz = o.maxMentions > 0 ? o.mentions / o.maxMentions : 0
  const mom = o.changePct == null ? 0 : Math.max(-1, Math.min(1, o.changePct / 10))
  const sent = Math.max(-1, Math.min(1, o.sentiment))
  const raw = 0.5 * buzz + 0.25 * ((mom + 1) / 2) + 0.25 * ((sent + 1) / 2)
  const score = Math.max(0, Math.min(100, Math.round(raw * 100)))
  const label = score >= 75 ? 'Hot' : score >= 55 ? 'Warm' : score >= 35 ? 'Watch' : 'Cool'
  return { score, label }
}

/* ----------------------------- query + params ---------------------------- */

/** Primary: any tweet carrying a cashtag. */
export function buildQuery(): string {
  return 'has:cashtags lang:en -is:retweet'
}

/** Fallback if `has:cashtags` isn't permitted on the key's access tier. */
export function buildFallbackQuery(): string {
  return '(stocks OR "stock market" OR earnings OR $SPY OR $QQQ OR $AAPL OR $TSLA OR $NVDA) lang:en -is:retweet'
}

/** Search params for a page; start_time is clamped to the endpoint's horizon. */
export function searchParams(
  query: string,
  window: XWindow,
  nowMs: number,
  useArchive: boolean,
  nextToken: string | null,
  maxResults = 100
): Record<string, string> {
  let startMs = nowMs - window.hours * 3_600_000
  if (!useArchive) {
    // recent-search rejects start_time older than ~7 days; keep a 1-min margin.
    const floor = nowMs - RECENT_MAX_HOURS * 3_600_000 + 60_000
    if (startMs < floor) startMs = floor
  }
  const p: Record<string, string> = {
    query,
    max_results: String(maxResults),
    'tweet.fields': 'entities,public_metrics,created_at',
    start_time: new Date(startMs).toISOString()
  }
  if (nextToken) p.pagination_token = nextToken
  return p
}

/* -------------------------------- network -------------------------------- */

interface FetchOut {
  ok: boolean
  status: number
  json: unknown
  error?: string
}

async function xFetch(bearer: string, path: string, params: Record<string, string>): Promise<FetchOut> {
  const qs = new URLSearchParams(params).toString()
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err instanceof Error ? err.message : String(err) }
  }
  const json = (await resp.json().catch(() => null)) as { title?: string; detail?: string; errors?: { message?: string }[] } | null
  if (!resp.ok) {
    const detail = json?.detail || json?.title || json?.errors?.[0]?.message || `HTTP ${resp.status}`
    return { ok: false, status: resp.status, json, error: detail }
  }
  return { ok: true, status: resp.status, json }
}

export interface TrendingFetch {
  ok: boolean
  tweets: XTweet[]
  endpoint: 'recent' | 'all'
  error?: string
  archiveNeeded?: boolean
}

/**
 * Fetch and accumulate tweets for a window (paginated up to maxPages). Falls back
 * from `has:cashtags` to a broad finance query if the operator is rejected, and
 * returns partial results on a rate-limit rather than failing outright.
 */
export async function fetchTrending(bearer: string, windowId: string, nowMs: number, maxPages = 3): Promise<TrendingFetch> {
  const w = windowById(windowId)
  const useArchive = w.hours > RECENT_MAX_HOURS
  const path = useArchive ? '/tweets/search/all' : '/tweets/search/recent'
  const endpoint = useArchive ? 'all' : 'recent'
  let query = buildQuery()
  let triedFallback = false
  const tweets: XTweet[] = []
  let next: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const r = await xFetch(bearer, path, searchParams(query, w, nowMs, useArchive, next))
    if (!r.ok) {
      if (r.status === 400 && !triedFallback) {
        // operator/query not allowed on this tier — retry the same page broadly
        triedFallback = true
        query = buildFallbackQuery()
        page--
        continue
      }
      if (r.status === 403 && useArchive)
        return { ok: false, tweets, endpoint, archiveNeeded: true, error: 'Windows longer than 7 days need X API Pro (full-archive access). Try 24h or 7d.' }
      if (r.status === 401)
        return { ok: false, tweets: [], endpoint, error: 'X rejected the Bearer Token (401). Check it in Settings → API Keys.' }
      if (r.status === 429)
        return { ok: tweets.length > 0, tweets, endpoint, error: 'X rate limit hit — showing partial results. Try again shortly.' }
      return { ok: tweets.length > 0, tweets, endpoint, error: r.error }
    }
    const parsed = parseSearchPage(r.json)
    tweets.push(...parsed.tweets)
    next = parsed.nextToken
    if (!next) break
  }
  return { ok: true, tweets, endpoint }
}

/* --------------------------- mention COUNTS (precise) -------------------- *
 * The counts endpoints return an exact per-bucket mention tally for ONE query
 * — e.g. "$NVDA per day over 30 days" — and are a separate, cheaper resource
 * that does NOT draw down the monthly tweet-pull cap. Recent counts cover 7
 * days; longer needs the full-archive counts endpoint (X API Pro).
 * ------------------------------------------------------------------------ */

/** Exact-count query for one ticker (original posts, not retweets). */
export function countsQuery(ticker: string): string {
  return `$${ticker.toUpperCase()} -is:retweet`
}

/** Hourly buckets for short windows, daily for long ones. */
export function pickGranularity(window: XWindow): 'hour' | 'day' {
  return window.hours <= 48 ? 'hour' : 'day'
}

export interface CountBucket {
  start: string
  end: string
  count: number
}

interface RawCount {
  start?: string
  end?: string
  tweet_count?: number
}

export function parseCountsPage(json: unknown): { buckets: CountBucket[]; nextToken: string | null } {
  const j = (json ?? {}) as { data?: RawCount[]; meta?: { next_token?: string } }
  const data = Array.isArray(j.data) ? j.data : []
  const buckets = data.map((d): CountBucket => ({ start: String(d.start ?? ''), end: String(d.end ?? ''), count: Number(d.tweet_count ?? 0) }))
  const nextToken = j.meta?.next_token ? String(j.meta.next_token) : null
  return { buckets, nextToken }
}

export function countsParams(
  query: string,
  window: XWindow,
  nowMs: number,
  useArchive: boolean,
  granularity: 'hour' | 'day',
  nextToken: string | null
): Record<string, string> {
  let startMs = nowMs - window.hours * 3_600_000
  if (!useArchive) {
    const floor = nowMs - RECENT_MAX_HOURS * 3_600_000 + 60_000
    if (startMs < floor) startMs = floor
  }
  const p: Record<string, string> = { query, granularity, start_time: new Date(startMs).toISOString() }
  if (nextToken) p.next_token = nextToken
  return p
}

export interface MentionCountsFetch {
  ok: boolean
  ticker: string
  buckets: CountBucket[]
  total: number
  endpoint: 'recent' | 'all'
  granularity: 'hour' | 'day'
  error?: string
  archiveNeeded?: boolean
}

const sumCounts = (b: CountBucket[]): number => b.reduce((n, x) => n + x.count, 0)

/** Exact per-bucket mention counts for one ticker over a window. */
export async function fetchMentionCounts(bearer: string, ticker: string, windowId: string, nowMs: number, maxPages = 8): Promise<MentionCountsFetch> {
  const w = windowById(windowId)
  const useArchive = w.hours > RECENT_MAX_HOURS
  const path = useArchive ? '/tweets/counts/all' : '/tweets/counts/recent'
  const endpoint: 'recent' | 'all' = useArchive ? 'all' : 'recent'
  const granularity = pickGranularity(w)
  const query = countsQuery(ticker)
  const all: CountBucket[] = []
  let next: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const r = await xFetch(bearer, path, countsParams(query, w, nowMs, useArchive, granularity, next))
    if (!r.ok) {
      const base = { ok: all.length > 0, ticker, buckets: all, total: sumCounts(all), endpoint, granularity }
      if (r.status === 403 && useArchive)
        return { ...base, ok: false, archiveNeeded: true, error: 'Windows longer than 7 days need X API Pro (full-archive access). Try 24h or 7d.' }
      if (r.status === 401) return { ok: false, ticker, buckets: [], total: 0, endpoint, granularity, error: 'X rejected the Bearer Token (401). Check it in Settings → API Keys.' }
      if (r.status === 429) return { ...base, error: 'X rate limit hit — showing partial counts. Try again shortly.' }
      return { ...base, error: r.error }
    }
    const parsed = parseCountsPage(r.json)
    all.push(...parsed.buckets)
    next = parsed.nextToken
    if (!next) break
  }
  all.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return { ok: true, ticker, buckets: all, total: sumCounts(all), endpoint, granularity }
}

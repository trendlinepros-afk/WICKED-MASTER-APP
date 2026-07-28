/**
 * ADVERSARIAL DEBATE (pure prompt-builders + tolerant parsers, unit-tested).
 * One AI ranking candidates will talk itself into stories. For the top picks a
 * BEAR attacker (cheap tier) builds the strongest case AGAINST each, then a
 * JUDGE (strong tier) weighs thesis vs bear case in the current regime and
 * issues take / caution / pass with a confidence. Wrong-side picks die in
 * committee instead of in the P&L.
 */

export interface DebateVerdict {
  ticker: string
  verdict: 'take' | 'caution' | 'pass'
  confidence: 'high' | 'medium' | 'low'
  bearCase: string
  note: string
}

export function buildBearPrompt(lines: string[]): string {
  return (
    'You are a ruthless short-seller doing devil\'s-advocate review. For EACH candidate below, write the single ' +
    'strongest, most concrete case AGAINST taking the long trade (exhaustion risk, dilution, fade patterns, crowd ' +
    'chasing, liquidity traps, macro timing). Be specific to the data shown; no hedging, no disclaimers. ' +
    'Return ONLY JSON: {"cases":[{"ticker":"","bearCase":"one dense sentence"}]}.\n\n' +
    lines.join('\n')
  )
}

export function buildJudgePrompt(items: { ticker: string; data: string; bearCase: string }[], regimeLine: string): string {
  const blocks = items
    .map((i) => `TICKER ${i.ticker}\nDATA: ${i.data}\nBEAR CASE: ${i.bearCase || '(none provided)'}`)
    .join('\n\n')
  return (
    (regimeLine ? regimeLine : '') +
    'You are the risk-management judge on a trading desk. For EACH ticker, weigh the bull thesis in DATA against ' +
    'the BEAR CASE, in this market regime. Verdicts: "take" = the setup clearly survives the bear case; "caution" = ' +
    'tradable but the bear case has real teeth (size down / tighter stop); "pass" = the bear case wins or the reward ' +
    'does not pay for the risk. Be stingy with "take". Return ONLY JSON: ' +
    '{"verdicts":[{"ticker":"","verdict":"take|caution|pass","confidence":"high|medium|low","note":"one sentence of the deciding factor"}]}.\n\n' +
    blocks
  )
}

function extractJson(raw: string): unknown {
  try {
    let s = raw.trim()
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) s = fence[1]
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** Tolerant parse of the bear cases, keyed by ticker (unknown tickers dropped). */
export function parseBear(raw: string, tickers: string[]): Map<string, string> {
  const want = new Set(tickers.map((t) => t.toUpperCase()))
  const out = new Map<string, string>()
  const j = extractJson(raw) as { cases?: { ticker?: string; bearCase?: string }[] } | null
  for (const c of j?.cases ?? []) {
    const t = String(c?.ticker ?? '').toUpperCase()
    const txt = String(c?.bearCase ?? '').trim()
    if (want.has(t) && txt) out.set(t, txt.slice(0, 400))
  }
  return out
}

/** Tolerant parse of the judge verdicts; invalid enums degrade to caution/medium. */
export function parseVerdicts(raw: string, tickers: string[]): DebateVerdict[] {
  const want = new Set(tickers.map((t) => t.toUpperCase()))
  const vOk = new Set(['take', 'caution', 'pass'])
  const cOk = new Set(['high', 'medium', 'low'])
  const j = extractJson(raw) as { verdicts?: { ticker?: string; verdict?: string; confidence?: string; note?: string }[] } | null
  const out: DebateVerdict[] = []
  for (const v of j?.verdicts ?? []) {
    const t = String(v?.ticker ?? '').toUpperCase()
    if (!want.has(t) || out.some((x) => x.ticker === t)) continue
    const verdict = String(v?.verdict ?? '').toLowerCase()
    const confidence = String(v?.confidence ?? '').toLowerCase()
    out.push({
      ticker: t,
      verdict: (vOk.has(verdict) ? verdict : 'caution') as DebateVerdict['verdict'],
      confidence: (cOk.has(confidence) ? confidence : 'medium') as DebateVerdict['confidence'],
      bearCase: '',
      note: String(v?.note ?? '').slice(0, 300)
    })
  }
  return out
}

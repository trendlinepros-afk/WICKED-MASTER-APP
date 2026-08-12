import type { Action, PatternCall, Signal, Stats, Verdict } from './types'

/**
 * Pure helpers for the copilot's track record and its markdown "brain" —
 * stats over past signals, the prompt digest, and the vault documents
 * (session transcripts + Brain.md). No electron/fs imports: ipc.ts feeds in
 * data and writes files via the-brain's vault API.
 */

const r2 = (n: number): number => Math.round(n * 100) / 100
const pctStr = (n: number | null | undefined): string =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

const isPriced = (s: Signal): boolean => s.entryP != null && s.exitP != null && s.pct != null

function dirStat(list: Signal[]): { count: number; winRate: number; avgPct: number } {
  const priced = list.filter(isPriced)
  const wins = priced.filter((s) => (s.pct ?? 0) > 0).length
  const sum = priced.reduce((a, s) => a + (s.pct ?? 0), 0)
  return {
    count: priced.length,
    winRate: priced.length ? Math.round((wins / priced.length) * 100) : 0,
    avgPct: priced.length ? r2(sum / priced.length) : 0
  }
}

export function computeStats(signals: Signal[]): Stats {
  const closed = signals.filter((s) => s.reason != null)
  const priced = closed.filter(isPriced)
  const overall = dirStat(closed)
  const byPattern = new Map<string, Signal[]>()
  for (const s of priced) {
    for (const name of s.patterns) {
      const list = byPattern.get(name) ?? []
      list.push(s)
      byPattern.set(name, list)
    }
  }
  return {
    signals: priced.length,
    unpriced: closed.length - priced.length,
    winRate: overall.winRate,
    avgPct: overall.avgPct,
    netPct: r2(priced.reduce((a, s) => a + (s.pct ?? 0), 0)),
    long: dirStat(closed.filter((s) => s.dir === 'long')),
    short: dirStat(closed.filter((s) => s.dir === 'short')),
    patterns: [...byPattern.entries()]
      .map(([name, list]) => ({ name, ...dirStat(list) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
  }
}

/** Compact self-track-record block injected into the live prompt. */
export function trackRecordDigest(stats: Stats, lessons: string[]): string {
  if (stats.signals < 3 && lessons.length === 0) return ''
  const lines: string[] = []
  if (stats.signals >= 3) {
    lines.push('YOUR TRACK RECORD (hypothetical P/L of your own past signals, all sessions):')
    lines.push(
      `Overall: ${stats.winRate}% win rate over ${stats.signals} signals, avg ${pctStr(stats.avgPct)}/signal. ` +
        `Longs ${stats.long.winRate}% (${stats.long.count}) · Shorts ${stats.short.winRate}% (${stats.short.count}).`
    )
    const eligible = stats.patterns.filter((p) => p.count >= 3)
    if (eligible.length > 0) {
      const best = eligible.reduce((a, b) => (b.winRate > a.winRate ? b : a))
      const worst = eligible.reduce((a, b) => (b.winRate < a.winRate ? b : a))
      lines.push(
        `Best pattern: ${best.name} (${best.winRate}% over ${best.count}). Worst: ${worst.name} (${worst.winRate}% over ${worst.count}).`
      )
    }
  }
  if (lessons.length > 0) {
    lines.push('LATEST LESSONS from reviewing your own past sessions — apply them:')
    for (const l of lessons.slice(0, 3)) lines.push(`- ${l}`)
  }
  return lines.join('\n')
}

/** Bullet lines out of the lesson-review model reply. */
export function parseLessons(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^[-•*]\s*/, ''))
    .filter((l, i, arr) => l.length > 8 && arr.findIndex((x) => x === l) === i)
    .slice(0, 4)
    .map((l) => l.slice(0, 200))
}

/* ------------------------------ markdown docs ------------------------------ */

export interface SessionLogRow {
  t: number
  action: Action
  confidence: number
  oneLiner: string
  detail: string
  patterns: PatternCall[]
  levels: Verdict['levels']
  barsOk: boolean
  price: number | null
}

export interface SessionMeta {
  symbol: string
  startedAt: number
  endedAt: number
  model: string
  checks: number
}

const clock = (t: number): string =>
  new Date(t).toLocaleTimeString('en-US', { hour12: false })
const money = (p: number | null | undefined): string => (p == null ? '(no price)' : `@${p.toFixed(2)}`)

export function renderSessionMd(meta: SessionMeta, signals: Signal[], log: SessionLogRow[]): string {
  const start = new Date(meta.startedAt)
  const net = r2(signals.filter(isPriced).reduce((a, s) => a + (s.pct ?? 0), 0))
  const head = [
    '---',
    `title: ${meta.symbol || 'NO-TICKER'} — ${start.toLocaleString()}`,
    `symbol: ${meta.symbol || '(none)'}`,
    `start: ${start.toISOString()}`,
    `end: ${new Date(meta.endedAt).toISOString()}`,
    `model: ${meta.model}`,
    `checks: ${meta.checks}`,
    `signals: ${signals.length}`,
    `net: ${pctStr(net)}`,
    'type: copilot-session',
    '---',
    '',
    `# ${meta.symbol || 'No ticker'} session — ${start.toLocaleString()}`,
    ''
  ]
  const sig = ['## Signals', '']
  if (signals.length === 0) sig.push('_No BUY/SELL signals fired this session._')
  else {
    sig.push('| Dir | Entry | Exit | % | Close | Conf | Patterns |', '|---|---|---|---:|---|---:|---|')
    for (const s of signals) {
      sig.push(
        `| ${s.dir} | ${clock(s.entryT)} ${money(s.entryP)} | ${s.exitT ? `${clock(s.exitT)} ${money(s.exitP)}` : '—'} | ${pctStr(s.pct)} | ${s.reason ?? '—'} | ${s.confidence} | ${s.patterns.join(', ') || '—'} |`
      )
    }
  }
  const logLines = ['', '## Verdict log', '']
  for (const row of log) {
    logLines.push(
      `### ${clock(row.t)} — ${row.action} (conf ${row.confidence})${row.barsOk ? '' : ' · vision-only'}${row.price != null ? ` · $${row.price.toFixed(2)}` : ''}`
    )
    if (row.patterns.length > 0) logLines.push(`Patterns: ${row.patterns.map((p) => `${p.name} (${p.status})`).join(', ')}`)
    if (row.oneLiner) logLines.push(`**${row.oneLiner}**`)
    if (row.detail) logLines.push(row.detail)
    const lv: string[] = []
    if (row.levels.support.length > 0) lv.push(`S: ${row.levels.support.join(' / ')}`)
    if (row.levels.resistance.length > 0) lv.push(`R: ${row.levels.resistance.join(' / ')}`)
    if (lv.length > 0) logLines.push(lv.join(' · '))
    logLines.push('')
  }
  return [...head, ...sig, ...logLines].join('\n')
}

export function renderBrainMd(stats: Stats, lessons: string[]): string {
  const out = [
    '---',
    'title: Live Trade Copilot Brain',
    `updated: ${new Date().toISOString()}`,
    'type: copilot-brain',
    '---',
    '',
    '# Live Trade Copilot — Brain',
    '',
    '## STATS',
    '_Recomputed after every session from the last 500 closed signals. This section is overwritten — do not edit._',
    '',
    `- Signals: ${stats.signals} priced (${stats.unpriced} unpriced) · Win rate ${stats.winRate}% · Avg ${pctStr(stats.avgPct)}/signal · Net ${pctStr(stats.netPct)}`,
    `- Longs: ${stats.long.count} · ${stats.long.winRate}% win · avg ${pctStr(stats.long.avgPct)} — Shorts: ${stats.short.count} · ${stats.short.winRate}% win · avg ${pctStr(stats.short.avgPct)}`,
    ''
  ]
  if (stats.patterns.length > 0) {
    out.push('| Pattern | Count | Win % | Avg % |', '|---|---:|---:|---:|')
    for (const p of stats.patterns) out.push(`| ${p.name} | ${p.count} | ${p.winRate} | ${pctStr(p.avgPct)} |`)
    out.push('')
  }
  out.push('## LESSONS', '_Written by the copilot reviewing its own sessions (newest first)._', '')
  if (lessons.length === 0) out.push('_None yet — lessons appear after sessions that fire signals._')
  else for (const l of lessons) out.push(`- ${l}`)
  out.push('')
  return out.join('\n')
}

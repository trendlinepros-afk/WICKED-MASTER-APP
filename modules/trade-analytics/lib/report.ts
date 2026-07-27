import type { ReportSpec } from '../../stock-planner/ipc/report'
import type { Stats } from './analytics'
import { duration, money, num, signedMoney } from './format'

/**
 * Build the Trade Journal PDF spec (pure, unit-testable): KPI stat cards from
 * the computed Stats, the AI coach's markdown parsed into report sections, and
 * a per-symbol breakdown. Rendered by the shared buildReportPdf.
 */

export interface CoachSection {
  heading: string
  body: string
  bullets: string[]
}

const stripMd = (s: string): string =>
  s
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/, '')
    .trim()

/** Parse the coach's markdown-ish output (### headings, numbered bullets). */
export function coachSections(text: string): CoachSection[] {
  const out: CoachSection[] = []
  let cur: CoachSection | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      cur = { heading: stripMd(h[1]).replace(/:\s*$/, ''), body: '', bullets: [] }
      out.push(cur)
      continue
    }
    if (!cur) {
      cur = { heading: 'Coach notes', body: '', bullets: [] }
      out.push(cur)
    }
    const b = /^(?:\d+[.)]|[-*•])\s+(.*)$/.exec(line)
    if (b) cur.bullets.push(stripMd(b[1]))
    else cur.body = cur.body ? `${cur.body}\n${stripMd(line)}` : stripMd(line)
  }
  return out.filter((s) => s.body || s.bullets.length > 0)
}

export function buildJournalReport(
  stats: Stats,
  aiText: string,
  executions: number,
  stamp: string
): ReportSpec {
  const coach = aiText.trim() ? coachSections(aiText) : []

  const sections: ReportSpec['sections'] = [
    ...coach.map((c) => ({ heading: c.heading, body: c.body, bullets: c.bullets.slice(0, 6) })),
    {
      heading: 'Direction & risk',
      body: '',
      bullets: [
        `Long: ${signedMoney(stats.longPnl)} over ${num(stats.longTrades)} trade(s) · Short: ${signedMoney(stats.shortPnl)} over ${num(stats.shortTrades)} trade(s)`,
        `Gross profit ${money(stats.grossProfit)} vs gross loss ${money(-stats.grossLoss)}`,
        `Largest win ${money(stats.largestWin)} · largest loss ${money(stats.largestLoss)}`,
        `Streaks: ${num(stats.maxWinStreak)} wins / ${num(stats.maxLossStreak)} losses · avg hold ${duration(stats.avgHoldSeconds)}`,
        `Total volume traded ${money(stats.totalVolume, false)} (${num(stats.sharesTraded)} shares)`
      ]
    },
    {
      heading: 'By symbol',
      body: '',
      bullets: stats.bySymbol
        .slice(0, 6)
        .map(
          (sy) =>
            `${sy.symbol}: ${signedMoney(sy.realizedPnl)} over ${num(sy.trades)} trade(s) (${sy.wins}W/${sy.losses}L)` +
            (sy.openQty !== 0 ? ` · ${num(sy.openQty)} sh still open` : '')
        )
    }
  ]

  return {
    title: 'Trading Performance Report',
    subtitle: `${num(executions)} executions · ${num(stats.closedTrades)} closed trades · ${num(stats.openTrades)} open position(s)`,
    ticker: '',
    company: 'Trade Journal',
    asOf: stamp,
    stats: [
      { label: 'Realized P&L', value: signedMoney(stats.totalRealized) },
      { label: 'Win rate', value: `${stats.winRate.toFixed(1)}%` },
      { label: 'Profit factor', value: Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞' },
      { label: 'Closed trades', value: `${num(stats.closedTrades)} (${stats.wins}W/${stats.losses}L/${stats.breakeven}BE)` },
      { label: 'Open positions', value: num(stats.openTrades) },
      { label: 'Expectancy / trade', value: signedMoney(stats.expectancy) },
      { label: 'Average win', value: money(stats.avgWin) },
      { label: 'Average loss', value: money(stats.avgLoss) },
      { label: 'Best symbol', value: stats.bestSymbol ? `${stats.bestSymbol.symbol} ${signedMoney(stats.bestSymbol.realizedPnl)}` : '—' }
    ],
    sections,
    disclaimer:
      'Generated from your imported Webull executions by WICKED Trade Journal. For personal process review only — not financial advice.'
  }
}

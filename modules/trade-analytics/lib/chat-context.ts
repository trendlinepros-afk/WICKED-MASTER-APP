/**
 * The system prompt for the AI Coach chat (pure). Unlike the one-shot
 * analysis digest, the chat gets the trader's actual trade list — every
 * closed round-trip (most recent first if there are very many), open
 * positions, per-symbol / weekday / hour / day breakdowns, their strategy
 * notes and per-day journal notes — so it can answer specific questions
 * ("what went wrong on the 18th?", "how do my MNQ shorts do after 11?").
 *
 * Rebuilt on every message from what the journal is showing, so switching
 * accounts or the date range mid-conversation changes what the coach sees.
 */
import type { Stats, Trade } from './analytics'
import type { TradeMetrics } from './metrics'
import { etParts } from './et'
import { duration, money, pct } from './format'

/** cap on closed trades listed individually (≈100 chars each) */
export const CHAT_TRADE_LIMIT = 600
const NOTE_LIMIT = 120
const DAY_LIMIT = 250

export interface ChatContextInput {
  stats: Stats
  metrics: TradeMetrics | null
  trades: Trade[]
  /** accounts in view (id → name, plus their strategy notes) */
  accounts: { id: string; name: string; strategy: string; feePerContract: number }[]
  rangeLabel: string
  /** per-day journal notes for the accounts in view: YYYY-MM-DD → text */
  dayNotes: Record<string, string>
  /** the one-shot coach analysis currently on screen, if any */
  analysis: string
  now?: number
}

const p2 = (n: number): string => String(n).padStart(2, '0')
function etStamp(at: number | null): string {
  if (at == null) return '—'
  const p = etParts(at)
  return `${p.ymd} ${p2(p.hour)}:${p2(p.minute)}`
}
const px = (n: number): string => (Number.isFinite(n) && n !== 0 ? String(Number(n.toFixed(4))) : '—')
const signed = (n: number): string => `${n >= 0 ? '+' : '-'}${money(Math.abs(n))}`
/** favourable move: points for contracts with a multiplier (futures), % otherwise */
function move(t: Trade): string {
  if (t.multiplier === 1) return pct(t.realizedPct)
  const pts = (t.avgExit - t.avgEntry) * (t.direction === 'long' ? 1 : -1)
  return `${pts >= 0 ? '+' : ''}${Number(pts.toFixed(2))} pts`
}

export function buildChatContext(c: ChatContextInput): string {
  const { stats: s, metrics: m, trades } = c
  const multiAccount = c.accounts.length > 1
  const accName = new Map(c.accounts.map((a) => [a.id, a.name]))
  const out: string[] = []

  out.push(
    "You are an expert trading coach built into the trader's journal app (WICKED Trade Journal), chatting with the trader " +
      'about THEIR OWN executed trades. Everything you know about their trading is in the data below — answer from it. ' +
      'Cite specific trades (date/time, symbol, P&L, or the # from the trade list) and do quick math when it helps, ' +
      "showing it briefly. If the data can't answer a question (e.g. it has no chart/price context or the reason for a " +
      'trade), say so plainly instead of guessing. Be direct, specific and conversational: short paragraphs or bullets, ' +
      'no filler. Do not give financial advice or tell them what to buy or sell — coach their process, risk and ' +
      'discipline. All times are US Eastern (ET). P&L figures are NET of commissions/fees.'
  )
  out.push('')
  out.push(
    `VIEW: ${c.accounts.length ? c.accounts.map((a) => a.name).join(', ') : 'all accounts'} · date range: ${c.rangeLabel || 'lifetime'} · as of ${etStamp(c.now ?? Date.now())} ET`
  )

  const strategies = c.accounts.filter((a) => a.strategy.trim())
  if (strategies.length) {
    out.push('')
    out.push("TRADER'S OWN STRATEGY (ground truth about their intent — check whether the trades actually follow it):")
    for (const a of strategies) out.push(multiAccount ? `[${a.name}] ${a.strategy.trim()}` : a.strategy.trim())
  }
  const fees = c.accounts.filter((a) => a.feePerContract > 0)
  if (fees.length) out.push(`Commission setting: ${fees.map((a) => `${a.name} $${a.feePerContract}/contract per fill`).join('; ')}`)

  /* ------------------------------- summary ------------------------------- */
  out.push('')
  out.push('SUMMARY')
  out.push(`Net realized P&L ${signed(s.totalRealized)} over ${s.closedTrades} closed trades (fees paid ${money(s.totalFees)}; gross before fees ${signed(s.totalRealized + s.totalFees)})`)
  out.push(`Win rate ${s.winRate.toFixed(1)}% — ${s.wins}W / ${s.losses}L / ${s.breakeven} breakeven`)
  out.push(`Avg win ${money(s.avgWin)} · avg loss ${money(s.avgLoss)} · profit factor ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'} · expectancy ${signed(s.expectancy)}/trade`)
  out.push(`Largest win ${money(s.largestWin)} · largest loss ${money(s.largestLoss)} · gross profit ${money(s.grossProfit)} · gross loss ${money(s.grossLoss)}`)
  out.push(`Long ${signed(s.longPnl)} (${s.longTrades} trades) · short ${signed(s.shortPnl)} (${s.shortTrades} trades)`)
  out.push(`Avg hold ${duration(s.avgHoldSeconds)} · max win streak ${s.maxWinStreak} · max loss streak ${s.maxLossStreak}`)
  if (m) {
    out.push(`Best day ${signed(m.bestDay)} · worst day ${signed(m.worstDay)} · avg per trading day ${signed(m.avgPerDay.pnl)}`)
    out.push(`Rolling (ending at last close): last day ${signed(m.lastDay)} · last week ${signed(m.lastWeek)} · last month ${signed(m.lastMonth)}`)
  }

  /* ------------------------------ breakdowns ----------------------------- */
  if (s.bySymbol.length) {
    out.push('')
    out.push('BY SYMBOL (symbol | trades | W/L | net P&L | avg/trade)')
    for (const b of s.bySymbol)
      out.push(`${b.symbol} | ${b.trades} | ${b.wins}/${b.losses} | ${signed(b.realizedPnl)} | ${signed(b.trades ? b.realizedPnl / b.trades : 0)}`)
  }
  const bucketLine = (label: string, bs: Stats['byHour']): void => {
    const used = bs.filter((b) => b.trades > 0)
    if (!used.length) return
    out.push('')
    out.push(`${label} (bucket: net P&L, trades, wins)`)
    out.push(used.map((b) => `${b.label}: ${signed(b.pnl)}, ${b.trades}, ${b.wins}W`).join(' · '))
  }
  bucketLine('BY WEEKDAY (by close time)', s.byDayOfWeek)
  bucketLine('BY HOUR ET (by close time)', s.byHour)

  if (s.byDay.length) {
    const days = s.byDay.slice(-DAY_LIMIT)
    out.push('')
    out.push(`DAILY P&L (date: net, trades, wins)${s.byDay.length > days.length ? ` — most recent ${days.length} of ${s.byDay.length} days` : ''}`)
    out.push(days.map((b) => `${b.label}: ${signed(b.pnl)}, ${b.trades}, ${b.wins}W`).join(' · '))
  }

  const notes = Object.entries(c.dayNotes)
    .filter(([, t]) => t.trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-NOTE_LIMIT)
  if (notes.length) {
    out.push('')
    out.push("TRADER'S DAILY JOURNAL NOTES (their own words):")
    for (const [d, t] of notes) out.push(`${d}: ${t.trim().replace(/\s+/g, ' ').slice(0, 600)}`)
  }

  /* -------------------------------- trades ------------------------------- */
  const open = trades.filter((t) => t.isOpen)
  out.push('')
  if (open.length) {
    out.push('OPEN POSITIONS (still held — not in realized P&L; any partial closes are shown as banked)')
    for (const t of open)
      out.push(
        `${t.symbol} ${t.direction} ${t.openQty} open @ ${px(t.avgEntry)} since ${etStamp(t.openedAt)}${t.closedQty > 0 ? ` · ${t.closedQty} already closed, banked ${signed(t.realizedPnl)}` : ''}${multiAccount ? ` · ${accName.get(t.account) ?? t.account}` : ''}`
      )
  } else out.push('OPEN POSITIONS: none')

  const closed = trades
    .filter((t) => !t.isOpen && t.closedQty > 0)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const shown = closed.slice(-CHAT_TRADE_LIMIT)
  const offset = closed.length - shown.length
  out.push('')
  out.push(
    `CLOSED TRADES — ${closed.length} round-trips, oldest → newest${offset ? ` (only the most recent ${shown.length} are listed; the stats above cover all ${closed.length})` : ''}`
  )
  out.push(
    `# | opened ET | closed ET | symbol | side | qty | avg entry | avg exit | net P&L | move (points for futures, % for stocks) | fees | hold${multiAccount ? ' | account' : ''}`
  )
  shown.forEach((t, i) => {
    const mult = t.multiplier !== 1 ? ` ($${t.multiplier}/pt)` : ''
    out.push(
      [
        offset + i + 1,
        etStamp(t.openedAt),
        etStamp(t.closedAt),
        t.symbol + mult,
        t.direction === 'long' ? 'L' : 'S',
        t.closedQty,
        px(t.avgEntry),
        px(t.avgExit),
        signed(t.realizedPnl),
        move(t),
        t.fees ? money(t.fees) : '0',
        duration(t.holdSeconds),
        ...(multiAccount ? [accName.get(t.account) ?? t.account] : [])
      ].join(' | ')
    )
  })

  if (c.analysis.trim()) {
    out.push('')
    out.push('YOUR EARLIER WRITTEN ANALYSIS (already shown to the trader on this screen — they may ask about it):')
    out.push(c.analysis.trim())
  }
  return out.join('\n')
}

export const CHAT_SUGGESTIONS = [
  "What's my biggest leak right now?",
  'Which hours or days should I stop trading?',
  'Walk me through my worst day — what went wrong?',
  'Am I actually following my strategy?',
  'Compare my longs vs shorts',
  'What does a typical winning trade look like vs a losing one?'
]

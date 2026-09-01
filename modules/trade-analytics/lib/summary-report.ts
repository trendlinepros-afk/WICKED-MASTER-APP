import type { Stats } from './analytics'
import type { TradeMetrics } from './metrics'
import { duration, money, num, signedMoney } from './format'

/**
 * "Export Account Summary" PDF (pure, unit-testable): builds a self-contained
 * HTML document — inline CSS, inline SVG charts, no external resources — that
 * the shell's printHtmlToPdf renders with real Chromium layout. Designed for
 * AT MOST two A4 pages: every section is fixed-size (no unbounded lists), and
 * page 2 starts at an explicit break.
 *
 * Content area with the shell's print margins is ~717 px wide × ~1026 px per
 * page (96 dpi), which the layout below is sized against.
 */

export interface SummaryReportInput {
  accountName: string
  rangeLabel: string
  generatedAt: string
  stats: Stats
  metrics: TradeMetrics
  /** one-paragraph AI read ('' = unavailable; aiNote then says why) */
  aiSummary: string
  /** model that wrote the paragraph, e.g. "claude-sonnet-5" */
  aiModel: string
  aiNote?: string
}

/* --------------------------------- theme ---------------------------------- */

const INK = '#0f172a'
const MUTED = '#64748b'
const FAINT = '#e2e8f0'
const CARD_BG = '#f8fafc'
const GREEN = '#059669'
const RED = '#dc2626'
const ACCENT = '#e11d48'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const toneOf = (n: number): string => (n > 1e-9 ? GREEN : n < -1e-9 ? RED : INK)

/* ------------------------------- SVG charts -------------------------------- */

/** Equity curve: area + line over the range's cumulative realized P&L. */
function equityCurveSvg(points: { at: number; value: number }[], w = 663, h = 210): string {
  if (points.length === 0)
    return `<svg width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="${MUTED}" font-size="12">No closed trades in this range</text></svg>`
  const pad = { l: 8, r: 66, t: 12, b: 22 }
  const xs = points.map((p) => p.at)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const vals = points.map((p) => p.value)
  const minV = Math.min(0, ...vals)
  const maxV = Math.max(0, ...vals)
  const span = maxV - minV || 1
  const X = (at: number): number => pad.l + ((at - minX) / Math.max(1, maxX - minX)) * (w - pad.l - pad.r)
  const Y = (v: number): number => pad.t + (1 - (v - minV) / span) * (h - pad.t - pad.b)

  // start the curve at $0 just before the first close
  const pts: [number, number][] = [[pad.l, Y(0)], ...points.map((p): [number, number] => [X(p.at), Y(p.value)])]
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${Y(0).toFixed(1)} L${pad.l},${Y(0).toFixed(1)} Z`
  const last = points[points.length - 1].value
  const color = last >= 0 ? GREEN : RED
  const d0 = new Date(minX)
  const d1 = new Date(maxX)
  const dLabel = (d: Date): string => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const zeroY = Y(0)
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <line x1="${pad.l}" y1="${zeroY.toFixed(1)}" x2="${w - pad.r}" y2="${zeroY.toFixed(1)}" stroke="${FAINT}" stroke-dasharray="4 3"/>
    <path d="${area}" fill="${color}" opacity="0.10"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
    <text x="${w - pad.r + 6}" y="${(Y(last) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${color}">${esc(signedMoney(last))}</text>
    <text x="${pad.l}" y="${h - 6}" font-size="10" fill="${MUTED}">${esc(dLabel(d0))}</text>
    <text x="${w - pad.r}" y="${h - 6}" font-size="10" text-anchor="end" fill="${MUTED}">${esc(dLabel(d1))}</text>
  </svg>`
}

/** Vertical P&L "candles" for 8:00–17:00 ET — bar height = |P&L| for that hour. */
function hourlyCandlesSvg(metrics: TradeMetrics, w = 420, h = 220): string {
  const hours = Array.from({ length: 9 }, (_, i) => 8 + i) // 8:00 … 16:00 (through 5 pm)
  const rows = hours.map((hr) => {
    let pnl = 0
    let n = 0
    for (let dow = 0; dow < 7; dow++) {
      pnl += metrics.weekdayHourPnl[dow][hr]
      n += metrics.weekdayHourN[dow][hr]
    }
    return { hr, pnl, n }
  })
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)))
  const pad = { t: 18, b: 30 }
  const axisY = pad.t + (h - pad.t - pad.b) / 2
  const half = (h - pad.t - pad.b) / 2 - 2
  const bw = Math.floor((w - 16) / rows.length)
  const hourLabel = (hr: number): string => (hr === 12 ? '12p' : hr < 12 ? `${hr}a` : `${hr - 12}p`)
  const bars = rows
    .map((r, i) => {
      const x = 8 + i * bw
      const bh = Math.round((Math.abs(r.pnl) / maxAbs) * half)
      const active = r.n > 0
      const color = r.pnl >= 0 ? GREEN : RED
      const y = r.pnl >= 0 ? axisY - bh : axisY
      // clamp so a tall negative bar's value never collides with the hour labels
      const valY = r.pnl >= 0 ? y - 5 : Math.min(y + bh + 12, h - 27)
      return `
      <rect x="${x + 5}" y="${y}" width="${bw - 10}" height="${Math.max(active ? 2 : 0, bh)}" rx="2" fill="${color}" opacity="${active ? 0.9 : 0}"/>
      ${active ? `<text x="${x + bw / 2}" y="${valY}" text-anchor="middle" font-size="8.5" font-weight="600" fill="${color}">${esc(shortMoney(r.pnl))}</text>` : ''}
      <text x="${x + bw / 2}" y="${h - 14}" text-anchor="middle" font-size="9.5" fill="${MUTED}">${hourLabel(r.hr)}</text>
      <text x="${x + bw / 2}" y="${h - 3}" text-anchor="middle" font-size="8" fill="${MUTED}" opacity="0.8">${r.n ? `${r.n}t` : ''}</text>`
    })
    .join('')
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <line x1="4" y1="${axisY}" x2="${w - 4}" y2="${axisY}" stroke="${FAINT}"/>
    ${bars}
  </svg>`
}

/** Win/loss/breakeven donut with the win % in the middle. */
function winLossPieSvg(wins: number, losses: number, breakeven: number, size = 168): string {
  const total = wins + losses + breakeven
  const c = size / 2
  const r = size / 2 - 12
  if (total === 0)
    return `<svg width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${FAINT}" stroke-width="16"/></svg>`
  const arc = (startFrac: number, frac: number, color: string): string => {
    if (frac <= 0) return ''
    if (frac >= 0.999) return `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="18"/>`
    const a0 = startFrac * 2 * Math.PI - Math.PI / 2
    const a1 = (startFrac + frac) * 2 * Math.PI - Math.PI / 2
    const x0 = c + r * Math.cos(a0)
    const y0 = c + r * Math.sin(a0)
    const x1 = c + r * Math.cos(a1)
    const y1 = c + r * Math.sin(a1)
    return `<path d="M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="butt"/>`
  }
  const wf = wins / total
  const lf = losses / total
  const bf = breakeven / total
  const winPct = ((wins / total) * 100).toFixed(1)
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${arc(0, wf, GREEN)}${arc(wf, lf, RED)}${arc(wf + lf, bf, MUTED)}
    <text x="${c}" y="${c - 2}" text-anchor="middle" font-size="22" font-weight="800" fill="${INK}">${winPct}%</text>
    <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">win rate</text>
  </svg>`
}

/** Mon–Fri (plus weekend if traded) P&L bars for the weekday section. */
function weekdayBarsSvg(metrics: TradeMetrics, w = 663, h = 132): string {
  const days = metrics.byDayOfWeek.filter((b, i) => b.trades > 0 || (i >= 1 && i <= 5))
  if (days.length === 0) return ''
  const maxAbs = Math.max(1, ...days.map((d) => Math.abs(d.pnl)))
  const pad = { t: 16, b: 18 }
  const axisY = pad.t + (h - pad.t - pad.b) / 2
  const half = (h - pad.t - pad.b) / 2 - 2
  const bw = Math.floor((w - 16) / days.length)
  const bars = days
    .map((d, i) => {
      const x = 8 + i * bw
      const bh = Math.round((Math.abs(d.pnl) / maxAbs) * half)
      const color = d.pnl >= 0 ? GREEN : RED
      const y = d.pnl >= 0 ? axisY - bh : axisY
      const valY = d.pnl >= 0 ? y - 4 : Math.min(y + bh + 11, h - 16)
      return `
      <rect x="${x + Math.floor(bw * 0.2)}" y="${y}" width="${Math.floor(bw * 0.6)}" height="${Math.max(d.trades > 0 ? 2 : 0, bh)}" rx="2" fill="${color}" opacity="${d.trades > 0 ? 0.9 : 0.15}"/>
      ${d.trades > 0 ? `<text x="${x + bw / 2}" y="${valY}" text-anchor="middle" font-size="9" font-weight="600" fill="${color}">${esc(shortMoney(d.pnl))}</text>` : ''}
      <text x="${x + bw / 2}" y="${h - 4}" text-anchor="middle" font-size="9.5" fill="${MUTED}">${esc(d.label.slice(0, 3))}${d.trades ? ` · ${d.trades}t` : ''}</text>`
    })
    .join('')
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <line x1="4" y1="${axisY}" x2="${w - 4}" y2="${axisY}" stroke="${FAINT}"/>
    ${bars}
  </svg>`
}

function shortMoney(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 10000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}k`
  return `${sign}$${abs.toFixed(abs < 100 ? 2 : 0)}`
}

/* ------------------------------ HTML assembly ------------------------------ */

function statCell(label: string, value: string, color = INK, sub = ''): string {
  return `<div class="cell">
    <div class="cell-label">${esc(label)}</div>
    <div class="cell-value" style="color:${color}">${esc(value)}</div>
    ${sub ? `<div class="cell-sub">${esc(sub)}</div>` : ''}
  </div>`
}

export function buildSummaryHtml(input: SummaryReportInput): string {
  const { stats: s, metrics: m } = input

  // most / least profitable weekday (traded days only)
  const tradedDays = m.byDayOfWeek.filter((b) => b.trades > 0)
  const bestDow = tradedDays.length ? tradedDays.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null
  const worstDow = tradedDays.length ? tradedDays.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null

  // risk/reward: average winner vs average loser (avgLoss is stored negative)
  const absLoss = Math.abs(s.avgLoss)
  const rrText = absLoss > 1e-9 ? `${(s.avgWin / absLoss).toFixed(2)} : 1` : s.avgWin > 0 ? '∞' : '—'

  const feeSplit =
    s.totalFees > 0.005
      ? `commission ${money(s.totalCommission)} · exchange/reg ${money(Math.max(0, s.totalFees - s.totalCommission))}`
      : ''

  const pf = Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; color: ${INK}; font-size: 12px; }
  .page2 { page-break-before: always; padding-top: 6px; }
  .band { display: flex; align-items: baseline; gap: 10px; border-bottom: 3px solid ${ACCENT}; padding-bottom: 8px; }
  .brand { font-size: 10px; font-weight: 800; letter-spacing: 2px; color: ${ACCENT}; }
  h1 { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
  .meta { margin-left: auto; text-align: right; font-size: 10px; color: ${MUTED}; line-height: 1.5; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
  .kpi { border: 1px solid ${FAINT}; border-radius: 8px; padding: 8px 10px; background: ${CARD_BG}; }
  .kpi .l { font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; color: ${MUTED}; font-weight: 700; }
  .kpi .v { font-size: 19px; font-weight: 800; letter-spacing: -0.3px; margin-top: 2px; }
  .kpi .s { font-size: 9.5px; color: ${MUTED}; margin-top: 1px; }
  .card { border: 1px solid ${FAINT}; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; page-break-inside: avoid; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: ${MUTED}; font-weight: 800; margin-bottom: 6px; }
  .split { display: grid; grid-template-columns: 1fr 190px; gap: 10px; align-items: stretch; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .cell { border: 1px solid ${FAINT}; border-radius: 8px; padding: 7px 9px; background: ${CARD_BG}; }
  .cell-label { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.7px; color: ${MUTED}; font-weight: 700; }
  .cell-value { font-size: 14.5px; font-weight: 800; margin-top: 2px; letter-spacing: -0.2px; }
  .cell-sub { font-size: 9px; color: ${MUTED}; margin-top: 1px; }
  .fees { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .legend { display: flex; gap: 12px; justify-content: center; font-size: 9.5px; color: ${MUTED}; margin-top: 4px; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 99px; margin-right: 4px; }
  .ai { background: ${CARD_BG}; }
  .ai p { font-size: 11.5px; line-height: 1.65; color: ${INK}; }
  .ai .model { display: inline-block; font-size: 9px; font-weight: 700; color: ${ACCENT}; border: 1px solid ${ACCENT}; border-radius: 99px; padding: 1px 8px; margin-left: 6px; vertical-align: 1px; text-transform: none; letter-spacing: 0.2px; }
  .foot { font-size: 8.5px; color: ${MUTED}; margin-top: 8px; line-height: 1.5; }
  </style></head><body>

  <div class="band">
    <div>
      <div class="brand">WICKED · TRADE JOURNAL</div>
      <h1>Account Summary — ${esc(input.accountName)}</h1>
    </div>
    <div class="meta">${esc(input.rangeLabel)}<br>Generated ${esc(input.generatedAt)}</div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="l">Realized P&amp;L (net)</div><div class="v" style="color:${toneOf(s.totalRealized)}">${esc(signedMoney(s.totalRealized))}</div><div class="s">${num(s.closedTrades)} closed trades${s.totalFees > 0.005 ? ` · after ${esc(money(s.totalFees))} costs` : ''}</div></div>
    <div class="kpi"><div class="l">Win rate</div><div class="v">${s.winRate.toFixed(1)}%</div><div class="s">${s.wins}W · ${s.losses}L · ${s.breakeven}BE</div></div>
    <div class="kpi"><div class="l">Profit factor</div><div class="v" style="color:${s.profitFactor >= 1 ? GREEN : RED}">${esc(pf)}</div><div class="s">expectancy ${esc(signedMoney(s.expectancy))}/trade</div></div>
    <div class="kpi"><div class="l">Risk / reward</div><div class="v">${esc(rrText)}</div><div class="s">avg win vs avg loss</div></div>
  </div>

  <div class="card">
    <h2>Equity curve — cumulative realized P&amp;L</h2>
    ${equityCurveSvg(s.equityCurve.map((p) => ({ at: p.at, value: p.cumulative })))}
  </div>

  <div class="split">
    <div class="card" style="margin-bottom:0">
      <h2>P&amp;L by hour of day (ET) — 8 AM to 5 PM</h2>
      ${hourlyCandlesSvg(m)}
    </div>
    <div class="card" style="margin-bottom:0; display:flex; flex-direction:column; align-items:center; justify-content:center;">
      <h2 style="align-self:flex-start">Win / loss</h2>
      ${winLossPieSvg(s.wins, s.losses, s.breakeven)}
      <div class="legend">
        <span><span class="dot" style="background:${GREEN}"></span>${s.wins} wins</span>
        <span><span class="dot" style="background:${RED}"></span>${s.losses} losses</span>
        ${s.breakeven ? `<span><span class="dot" style="background:${MUTED}"></span>${s.breakeven} BE</span>` : ''}
      </div>
    </div>
  </div>

  <div class="card" style="margin-top:10px">
    <h2>Commissions &amp; fees paid</h2>
    <div class="fees">
      ${statCell('Last 7 days', money(m.feesLastWeek), INK)}
      ${statCell('Last 30 days', money(m.feesLastMonth), INK)}
      ${statCell('Last 365 days', money(m.feesLastYear), INK)}
      ${statCell('Total (this range)', money(s.totalFees), s.totalFees > 0 ? RED : INK, feeSplit)}
    </div>
  </div>

  <div class="page2">

  <div class="card">
    <h2>Performance detail</h2>
    <div class="grid">
      ${statCell('Average win', money(s.avgWin), GREEN)}
      ${statCell('Average loss', money(-s.avgLoss), RED)}
      ${statCell('Largest win', money(s.largestWin), GREEN)}
      ${statCell('Largest loss', money(s.largestLoss), RED)}
      ${statCell('Biggest green day', signedMoney(m.bestDay), toneOf(m.bestDay))}
      ${statCell('Biggest red day', signedMoney(m.worstDay), toneOf(m.worstDay))}
      ${statCell('Max win streak', `${num(s.maxWinStreak)} trades`, GREEN)}
      ${statCell('Max loss streak', `${num(s.maxLossStreak)} trades`, RED)}
      ${statCell('Average hold time', duration(s.avgHoldSeconds))}
      ${statCell('Long P&L', signedMoney(s.longPnl), toneOf(s.longPnl), `${num(s.longTrades)} trades`)}
      ${statCell('Short P&L', signedMoney(s.shortPnl), toneOf(s.shortPnl), `${num(s.shortTrades)} trades`)}
      ${statCell('Total volume', money(s.totalVolume, false), INK, `${num(s.sharesTraded)} shares/contracts traded`)}
    </div>
  </div>

  <div class="card">
    <h2>P&amp;L by day of week${
      bestDow && worstDow && bestDow !== worstDow
        ? ` — best ${esc(bestDow.label)} (${esc(signedMoney(bestDow.pnl))}), worst ${esc(worstDow.label)} (${esc(signedMoney(worstDow.pnl))})`
        : ''
    }</h2>
    ${weekdayBarsSvg(m)}
  </div>

  <div class="card ai">
    <h2>AI summary${input.aiModel ? `<span class="model">${esc(input.aiModel)}</span>` : ''}</h2>
    ${
      input.aiSummary
        ? `<p>${esc(input.aiSummary)}</p>`
        : `<p style="color:${MUTED}">${esc(input.aiNote || 'AI summary unavailable — add an Anthropic, OpenAI, Gemini or DeepSeek key in Settings → API Keys.')}</p>`
    }
  </div>

  <div class="foot">Generated by WICKED Trade Journal from your imported executions. P&amp;L figures are net of imported commissions &amp; fees${
    feeSplit ? ` (${esc(feeSplit)})` : ''
  }. Hour-of-day and weekday grouping use Eastern Time. For personal process review only — not financial advice.</div>

  </div>

  </body></html>`
}

/* ------------------------------ AI paragraph ------------------------------- */

/**
 * Prompt for the report's one-paragraph verdict. When the trader has written a
 * strategy description (per account), it is included so the read is grounded
 * in their actual intent instead of guessed from the numbers.
 */
export function buildSummaryAiPrompt(s: Stats, m: TradeMetrics, rangeLabel: string, strategy: string): string {
  const dow = m.byDayOfWeek.filter((b) => b.trades > 0).map((b) => `${b.label} ${money(b.pnl)} (${b.trades}t)`).join(', ')
  const hours: string[] = []
  for (let hr = 8; hr <= 16; hr++) {
    let pnl = 0
    let n = 0
    for (let d = 0; d < 7; d++) {
      pnl += m.weekdayHourPnl[d][hr]
      n += m.weekdayHourN[d][hr]
    }
    if (n > 0) hours.push(`${hr}:00 ${money(pnl)} (${n}t)`)
  }
  return [
    'You are a professional trading coach. Write EXACTLY ONE PARAGRAPH — 5 to 7 sentences of plain text, ',
    'no headings, no bullet points, no markdown, no line breaks — summarizing how this trader is doing over ',
    `the period "${rangeLabel}". Be direct and specific, cite the numbers, and make clear what is working that `,
    'they should do MORE of, and what is hurting that they should do LESS of. Focus on process, not stock picks; ',
    'no financial advice.\n\n',
    strategy.trim()
      ? `THE TRADER'S OWN STRATEGY DESCRIPTION (treat as ground truth about intent):\n${strategy.trim()}\n\n`
      : '',
    `Realized P&L (net of costs): ${money(s.totalRealized)} over ${s.closedTrades} closed trades\n`,
    `Win rate ${s.winRate.toFixed(1)}% (${s.wins}W/${s.losses}L/${s.breakeven}BE) · profit factor ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf'} · expectancy ${money(s.expectancy)}/trade\n`,
    `Avg win ${money(s.avgWin)} vs avg loss ${money(s.avgLoss)} · largest win ${money(s.largestWin)} / largest loss ${money(s.largestLoss)}\n`,
    `Best day ${money(m.bestDay)}, worst day ${money(m.worstDay)} · streaks ${s.maxWinStreak}W/${s.maxLossStreak}L · avg hold ${duration(s.avgHoldSeconds)}\n`,
    `Long ${money(s.longPnl)} (${s.longTrades}t) vs short ${money(s.shortPnl)} (${s.shortTrades}t)\n`,
    `Commissions+fees paid: ${money(s.totalFees)}\n`,
    `P&L by weekday: ${dow || 'n/a'}\n`,
    `P&L by hour (ET): ${hours.join(', ') || 'n/a'}\n`
  ].join('')
}

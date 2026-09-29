/**
 * Coach-chat documents (pure): Markdown, or self-contained HTML that main
 * prints to PDF (shell printHtmlToPdf — sandboxed, JavaScript off, so every
 * chart is inline SVG). Used for "Export chat", a single reply's PDF, the
 * PDFs the coach makes on request ("@pdf" replies) and the AI Coach tab's
 * trading report.
 *
 * Every string from the model is HTML-escaped before our own tags are added.
 */
import { calloutTone, inlineTokens, parseRich, plainText, toneRuns, visibleText, type Block } from './rich-text'
import { chartFromBlock, chartSvg, fmtValue, PRINT_PALETTE, type ChartData, type ChartInputs } from './chat-charts'

export interface ExportMessage {
  role: 'user' | 'assistant'
  content: string
  /** what the chat showed instead of the raw prompt (e.g. "Analyze my trading") */
  display?: string
  error?: string
}

export interface ExportMeta {
  title: string
  /** accounts · date range the chat was started with */
  scope: string
  createdAt: number
}

const stamp = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* -------------------------------- markdown -------------------------------- */

function chartToMarkdown(d: ChartData): string {
  const out = [`**${d.title || 'Chart'}**${d.subtitle ? ` — ${d.subtitle}` : ''}`, '']
  if (d.type === 'stats') {
    out.push('| Metric | Value |', '| --- | ---: |', ...d.items.map((i) => `| ${i.label} | ${i.value}${i.sub ? ` (${i.sub})` : ''} |`))
    return out.join('\n')
  }
  out.push(`| | ${d.series.map((s) => s.name).join(' | ')} |`, `| --- | ${d.series.map(() => '---:').join(' | ')} |`)
  d.labels.forEach((l, i) => out.push(`| ${l} | ${d.series.map((s) => fmtValue(s.values[i] ?? 0, d.unit)).join(' | ')} |`))
  return out.join('\n')
}

/** Replace chart blocks with a data table (Markdown has no charts). */
export function richToMarkdown(md: string, inputs: ChartInputs | null): string {
  return visibleText(md).replace(/(```|~~~)[ \t]*chart[ \t]*\n?([\s\S]*?)\1/g, (_w, _f: string, body: string) => {
    const d = chartFromBlock(body, inputs)
    return 'error' in d ? '' : chartToMarkdown(d)
  })
}

export function chatToMarkdown(meta: ExportMeta, messages: ExportMessage[], inputs: ChartInputs | null = null): string {
  const out = [`# Coach chat — ${meta.title}`, '', `_${[meta.scope, `started ${stamp(meta.createdAt)}`].filter(Boolean).join(' · ')}_`, '']
  for (const m of messages) {
    if (!m.content.trim() && !m.error) continue
    const body = m.role === 'user' ? (m.display || m.content).trim() : richToMarkdown(m.content, inputs).trim()
    out.push(m.role === 'user' ? '### You' : '### Coach', '', body || '_(no reply)_')
    if (m.error) out.push('', `_${m.error}_`)
    out.push('')
  }
  out.push('---', '_Exported from WICKED Trade Journal. Process coaching only — not financial advice._', '')
  return out.join('\n')
}

/* ---------------------------------- HTML ---------------------------------- */

/** Inline markdown → HTML (escaped), with gains/losses coloured. */
export function inlineHtml(text: string): string {
  const runs = (s: string): string =>
    toneRuns(s)
      .map((r) => (r.tone ? `<span class="${r.tone}">${esc(r.s)}</span>` : esc(r.s)))
      .join('')
  return inlineTokens(text)
    .map((t) => (t.t === 'b' ? `<strong>${runs(t.s)}</strong>` : t.t === 'i' ? `<em>${runs(t.s)}</em>` : t.t === 'code' ? `<code>${esc(t.s)}</code>` : runs(t.s)))
    .join('')
}

function cellClass(text: string, align: string): string {
  const cls = [align === 'right' || /^[+\-−–]?\$?\s?[\d,.]+\s?[%kKmM]?$/.test(text.trim()) || /^[+\-−–]\$/.test(text.trim()) ? 'num' : '', align === 'center' ? 'ctr' : '']
  return cls.filter(Boolean).join(' ')
}

function chartHtml(d: ChartData | { error: string }): string {
  if ('error' in d) return `<div class="chart-err">Chart unavailable — ${esc(d.error)}</div>`
  const head = `${d.title ? `<div class="fig-title">${esc(d.title)}</div>` : ''}${d.subtitle ? `<div class="fig-sub">${esc(d.subtitle)}</div>` : ''}`
  if (d.type === 'stats')
    return `<div class="figure tiles-fig">${head}<div class="tiles">${d.items
      .map((i) => `<div class="tile ${i.tone}"><div class="t-label">${esc(i.label)}</div><div class="t-value">${esc(i.value)}</div>${i.sub ? `<div class="t-sub">${esc(i.sub)}</div>` : ''}</div>`)
      .join('')}</div></div>`
  return `<div class="figure">${head}${chartSvg(d, PRINT_PALETTE, 680)}</div>`
}

/** A coach reply (markdown + charts) → HTML body. */
export function richToHtml(md: string, inputs: ChartInputs | null): string {
  const blocks = parseRich(visibleText(md))
  return blocks.map((b: Block) => blockHtml(b, inputs)).join('\n')
}

function blockHtml(b: Block, inputs: ChartInputs | null): string {
  switch (b.kind) {
    case 'h':
      return `<h${Math.min(4, b.level + 1)}>${inlineHtml(b.text)}</h${Math.min(4, b.level + 1)}>`
    case 'p': {
      const tone = calloutTone(b.text)
      return tone ? `<p class="callout ${tone}">${inlineHtml(b.text)}</p>` : `<p>${inlineHtml(b.text)}</p>`
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul'
      return `<${tag}>${b.items
        .map((it) => {
          const tone = calloutTone(it)
          return `<li${tone ? ` class="callout ${tone}"` : ''}>${inlineHtml(it)}</li>`
        })
        .join('')}</${tag}>`
    }
    case 'table':
      return `<table><thead><tr>${b.header.map((h, i) => `<th class="${cellClass('', b.align[i])}">${inlineHtml(h)}</th>`).join('')}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c, i) => `<td class="${cellClass(plainText(c), b.align[i])}">${inlineHtml(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    case 'quote':
      return `<blockquote>${b.text
        .split('\n')
        .map((l) => inlineHtml(l))
        .join('<br>')}</blockquote>`
    case 'hr':
      return '<hr>'
    case 'gap':
      return ''
    case 'chart':
      return b.closed ? chartHtml(chartFromBlock(b.raw, inputs)) : ''
    case 'code':
      return `<pre>${esc(b.text)}</pre>`
  }
}

const CSS = `
  @page{margin:0}
  *{box-sizing:border-box}
  body{font-family:"Segoe UI",-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#1e293b;margin:0;font-size:12.5px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .band{background:linear-gradient(120deg,#0f172a 0%,#1e1b4b 60%,#4c0519 100%);color:#fff;padding:26px 36px 22px;border-bottom:4px solid #e11d48}
  .brand{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#fda4af;font-weight:700}
  .band h1{font-size:23px;margin:6px 0 4px;line-height:1.25;color:#fff}
  .band .meta{font-size:11px;color:#cbd5e1}
  .content{padding:20px 36px 10px}
  h2{font-size:17px;margin:20px 0 8px;color:#0f172a;border-left:4px solid #e11d48;padding-left:10px;line-height:1.3;page-break-after:avoid}
  h3{font-size:14.5px;margin:16px 0 6px;color:#0f172a;page-break-after:avoid}
  h4{font-size:13px;margin:12px 0 4px;color:#334155;page-break-after:avoid}
  p{margin:0 0 7px} ul,ol{margin:2px 0 10px;padding-left:22px} li{margin:3px 0}
  strong{color:#0f172a}
  .pos{color:#059669;font-weight:600} .neg{color:#dc2626;font-weight:600}
  code{background:#f1f5f9;border-radius:3px;padding:0 4px;font-size:11.5px}
  pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;white-space:pre-wrap;font-size:11px}
  hr{border:0;border-top:1px solid #e2e8f0;margin:14px 0}
  blockquote{margin:8px 0 12px;padding:10px 14px;background:#fff1f2;border-left:4px solid #e11d48;border-radius:0 8px 8px 0;color:#334155}
  .callout{list-style:none;margin:6px 0 6px -22px;padding:8px 12px;border-radius:8px;border-left:4px solid #94a3b8;background:#f8fafc}
  p.callout{margin-left:0}
  .callout.good{border-left-color:#059669;background:#ecfdf5} .callout.bad{border-left-color:#dc2626;background:#fef2f2} .callout.warn{border-left-color:#d97706;background:#fffbeb}
  table{border-collapse:separate;border-spacing:0;width:100%;margin:8px 0 14px;font-size:11.5px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;page-break-inside:avoid}
  th{background:#0f172a;color:#fff;text-align:left;font-weight:600;padding:7px 9px;font-size:11px}
  td{padding:6px 9px;border-top:1px solid #eef2f7}
  tbody tr:nth-child(even) td{background:#f8fafc}
  th.num,td.num{text-align:right;font-variant-numeric:tabular-nums} th.ctr,td.ctr{text-align:center}
  .figure{margin:10px 0 16px;padding:12px 14px 10px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;page-break-inside:avoid;box-shadow:0 1px 0 #eef2f7}
  .fig-title{font-weight:700;font-size:12.5px;color:#0f172a;margin-bottom:2px}
  .fig-sub{font-size:10.5px;color:#64748b;margin-bottom:6px}
  .figure svg{display:block;width:100%;height:auto;margin-top:4px}
  .tiles-fig{border:0;padding:0;box-shadow:none;background:transparent}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:4px}
  .tile{border-radius:10px;padding:9px 11px;background:#f8fafc;border:1px solid #e2e8f0;border-top:4px solid #94a3b8}
  .tile.good{border-top-color:#059669;background:#f0fdf4} .tile.bad{border-top-color:#dc2626;background:#fef2f2}
  .t-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;font-weight:700}
  .t-value{font-size:16px;font-weight:800;color:#0f172a;margin-top:2px;font-variant-numeric:tabular-nums}
  .tile.good .t-value{color:#047857} .tile.bad .t-value{color:#b91c1c}
  .t-sub{font-size:9.5px;color:#64748b;margin-top:1px}
  .chart-err{font-size:11px;color:#94a3b8;font-style:italic;margin:6px 0}
  .msg{margin:0 0 16px}
  .who{font-size:9.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin:0 0 4px}
  .you .who{color:#e11d48} .coach .who{color:#4f46e5}
  .you .bubble{background:#fff1f2;border:1px solid #fecdd3;border-radius:12px;padding:8px 12px;font-weight:500;page-break-inside:avoid}
  .coach .bubble{border-left:3px solid #c7d2fe;padding:2px 0 2px 14px}
  .err{color:#b91c1c;font-size:11px}
  .foot{margin:18px 36px 24px;color:#94a3b8;font-size:9.5px;border-top:1px solid #e2e8f0;padding-top:8px}
`

function page(title: string, meta: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="band"><div class="brand">WICKED · Trade Journal</div><h1>${esc(title)}</h1><div class="meta">${esc(meta)}</div></div>
<div class="content">${body}</div>
<div class="foot">Generated by the WICKED Trade Journal AI coach · figures are net of fees · times US Eastern · process coaching only — not financial advice.</div>
</body></html>`
}

/** The whole conversation as a colour PDF page. */
export function chatToHtml(meta: ExportMeta, messages: ExportMessage[], inputs: ChartInputs | null = null): string {
  const body = messages
    .filter((m) => m.content.trim() || m.error)
    .map((m) =>
      m.role === 'user'
        ? `<div class="msg you"><div class="who">You</div><div class="bubble">${esc((m.display || m.content).trim()).replace(/\n/g, '<br>')}</div></div>`
        : `<div class="msg coach"><div class="who">Coach</div><div class="bubble">${richToHtml(m.content.trim() || '_(no reply)_', inputs)}${m.error ? `<p class="err">${esc(m.error)}</p>` : ''}</div></div>`
    )
    .join('\n')
  return page(`Coach chat — ${meta.title}`, [meta.scope, `started ${stamp(meta.createdAt)}`].filter(Boolean).join(' · '), body)
}

/** One report (a coach reply, or the AI Coach tab's trading report) as a colour PDF page. */
export function reportToHtml(title: string, scope: string, md: string, inputs: ChartInputs | null = null, at = Date.now()): string {
  return page(title, [scope, stamp(at)].filter(Boolean).join(' · '), richToHtml(md, inputs))
}

/**
 * The AI Coach tab's "Export PDF": the journal's own numbers as tiles and
 * charts (source charts — exact data), then the latest coach analysis.
 */
export function tradingReportMarkdown(analysis: string): string {
  const chart = (spec: Record<string, unknown>): string => `\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\``
  const parts = [
    '## At a glance',
    chart({ type: 'stats', source: 'summary', title: '' }),
    chart({ type: 'area', source: 'equity' }),
    chart({ type: 'bar', source: 'daily_pnl', last: 30, title: 'Net P&L by day (last 30 trading days)' }),
    '## When you trade',
    chart({ type: 'bar', source: 'pnl_by_hour' }),
    chart({ type: 'bar', source: 'pnl_by_weekday' }),
    chart({ type: 'bar', source: 'pnl_by_hold_time' }),
    '## What you trade',
    chart({ type: 'hbar', source: 'pnl_by_symbol', top: 12 }),
    chart({ type: 'donut', source: 'win_loss' }),
    chart({ type: 'bar', source: 'long_short' }),
    chart({ type: 'bar', source: 'fees' })
  ]
  const body = visibleText(analysis)
    // the report already opens with the summary tiles
    .replace(/(```|~~~)[ \t]*chart[ \t]*\n?[^`~]*?"source"\s*:\s*"summary"[\s\S]*?\1/g, '')
    .trim()
  if (body) parts.push('---', '## Coach analysis', body)
  else parts.push('---', '> Run **Analyze my trading** on the AI Coach tab to add the coach’s written analysis to this report.')
  return parts.join('\n\n')
}

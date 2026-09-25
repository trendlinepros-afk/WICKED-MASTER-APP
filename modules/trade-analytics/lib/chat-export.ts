/**
 * Coach-chat export (pure): Markdown, or a self-contained HTML page that main
 * prints to PDF (shell printHtmlToPdf — sandboxed, JavaScript off). All chat
 * text is HTML-escaped before the small markdown subset is applied.
 */

export interface ExportMessage {
  role: 'user' | 'assistant'
  content: string
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

export function chatToMarkdown(meta: ExportMeta, messages: ExportMessage[]): string {
  const out = [`# Coach chat — ${meta.title}`, '', `_${[meta.scope, `started ${stamp(meta.createdAt)}`].filter(Boolean).join(' · ')}_`, '']
  for (const m of messages) {
    if (!m.content.trim() && !m.error) continue
    out.push(m.role === 'user' ? '### You' : '### Coach', '', m.content.trim() || '_(no reply)_')
    if (m.error) out.push('', `_${m.error}_`)
    out.push('')
  }
  out.push('---', '_Exported from WICKED Trade Journal. Process coaching only — not financial advice._', '')
  return out.join('\n')
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** **bold**, *italic*, `code` on already-escaped text */
function inlineHtml(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
}

export function markdownToHtml(md: string): string {
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  const close = (): void => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const raw of md.split('\n')) {
    const line = esc(raw.trimEnd())
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const want = numbered ? 'ol' : 'ul'
      if (list !== want) {
        close()
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${inlineHtml((bullet ?? numbered)![1])}</li>`)
      continue
    }
    close()
    if (!line.trim()) continue
    if (heading) out.push(`<h4>${inlineHtml(heading[1])}</h4>`)
    else if (/^-{3,}$/.test(line.trim())) out.push('<hr>')
    else out.push(`<p>${inlineHtml(line)}</p>`)
  }
  close()
  return out.join('\n')
}

export function chatToHtml(meta: ExportMeta, messages: ExportMessage[]): string {
  const body = messages
    .filter((m) => m.content.trim() || m.error)
    .map((m) =>
      m.role === 'user'
        ? `<div class="msg you"><div class="who">You</div><div class="bubble">${esc(m.content.trim()).replace(/\n/g, '<br>')}</div></div>`
        : `<div class="msg coach"><div class="who">Coach</div><div class="bubble">${markdownToHtml(m.content.trim() || '_(no reply)_')}${
            m.error ? `<p class="err">${esc(m.error)}</p>` : ''
          }</div></div>`
    )
    .join('\n')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>
  body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d2330;margin:0;padding:28px 34px;font-size:12.5px;line-height:1.55}
  h1{font-size:19px;margin:0 0 2px} .meta{color:#6b7385;font-size:11px;margin-bottom:18px;border-bottom:1px solid #e3e6ee;padding-bottom:12px}
  .msg{margin:0 0 14px;page-break-inside:avoid} .who{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b7385;margin-bottom:3px}
  .you .bubble{background:#eef1f8;border-radius:10px;padding:8px 12px;font-weight:500}
  .coach .bubble{border-left:3px solid #c9ced9;padding:2px 0 2px 12px}
  p{margin:0 0 6px} ul,ol{margin:2px 0 8px;padding-left:20px} li{margin:2px 0} h4{margin:8px 0 4px;font-size:13px}
  code{background:#f1f3f7;border-radius:3px;padding:0 3px;font-size:11.5px} hr{border:0;border-top:1px solid #e3e6ee;margin:10px 0}
  .err{color:#b42318;font-size:11px} .foot{margin-top:22px;color:#8a93a3;font-size:10px;border-top:1px solid #e3e6ee;padding-top:8px}
</style></head><body>
<h1>Coach chat — ${esc(meta.title)}</h1>
<div class="meta">${esc([meta.scope, `started ${stamp(meta.createdAt)}`].filter(Boolean).join(' · '))}</div>
${body}
<div class="foot">Exported from WICKED Trade Journal · process coaching only — not financial advice.</div>
</body></html>`
}

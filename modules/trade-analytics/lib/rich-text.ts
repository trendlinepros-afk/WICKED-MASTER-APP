/**
 * The coach's reply format (pure, shared by the chat bubble and the PDFs):
 * a small, safe markdown subset plus fenced ```chart blocks.
 *
 *   # / ## / ### headings · - / 1. lists · | tables | · > callouts · ---
 *   **bold** *italic* `code` · signed money / points / percents are coloured
 *   ```chart { …json… }```  → a chart (lib/chat-charts.ts)
 *   first line "@pdf <title>" → the reply is turned into a PDF report
 *
 * Renderers never inject raw HTML from the model: React renders elements and
 * the PDF renderer escapes every string before adding its own tags.
 */

export type Align = 'left' | 'right' | 'center'

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'gap' }
  | { kind: 'chart'; raw: string; closed: boolean }
  | { kind: 'code'; lang: string; text: string; closed: boolean }

const splitRow = (line: string): string[] => {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}
const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-')
const looksLikeRow = (line: string): boolean => {
  const t = line.trim()
  return t.includes('|') && (t.startsWith('|') || t.split('|').length >= 3)
}

/** The "@pdf <title>" directive on the reply's first non-blank line, if any. */
export function pdfDirective(md: string): { title: string; body: string } | null {
  const m = /^\s*@pdf\b[ \t]*(.*)(?:\r?\n|$)/i.exec(md)
  if (!m) return null
  const title = m[1].replace(/[*_#`]/g, '').trim().slice(0, 120) || 'Coach report'
  return { title, body: md.slice(m[0].length).replace(/^\s*\n/, '') }
}

/** What the chat shows / exports: the reply without its @pdf directive line. */
export function visibleText(md: string): string {
  const d = pdfDirective(md)
  return d ? d.body : md
}

export function parseRich(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flushList = (): void => {
    if (list) out.push({ kind: 'list', ...list })
    list = null
  }
  const pushGap = (): void => {
    const last = out[out.length - 1]
    if (last && last.kind !== 'gap') out.push({ kind: 'gap' })
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trimEnd()

    // fenced block (``` or ~~~)
    const fence = /^\s*(```|~~~)\s*([\w-]*)\s*(.*)$/.exec(line)
    if (fence) {
      flushList()
      const lang = fence[2].toLowerCase()
      const body: string[] = []
      // allow "```chart {json}```" on a single line
      const inlineRest = fence[3]
      if (inlineRest && inlineRest.endsWith(fence[1])) {
        const inner = inlineRest.slice(0, -fence[1].length)
        if (lang === 'chart') out.push({ kind: 'chart', raw: inner.trim(), closed: true })
        else out.push({ kind: 'code', lang, text: inner, closed: true })
        continue
      }
      if (inlineRest) body.push(inlineRest)
      let closed = false
      for (i = i + 1; i < lines.length; i++) {
        if (new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) {
          closed = true
          break
        }
        body.push(lines[i])
      }
      if (lang === 'chart') out.push({ kind: 'chart', raw: body.join('\n').trim(), closed })
      else out.push({ kind: 'code', lang, text: body.join('\n'), closed })
      continue
    }

    // table: header row + separator row
    if (looksLikeRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flushList()
      const header = splitRow(line)
      const align: Align[] = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'))
      const rows: string[][] = []
      for (i = i + 2; i < lines.length && looksLikeRow(lines[i]) && lines[i].trim(); i++) rows.push(splitRow(lines[i]))
      i--
      const width = header.length
      out.push({
        kind: 'table',
        header,
        align: Array.from({ length: width }, (_, k) => align[k] ?? 'left'),
        rows: rows.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? ''))
      })
      continue
    }

    const bullet = /^\s*[-*•+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if ((bullet && !/^\s*[-*_]{3,}\s*$/.test(line)) || numbered) {
      const ordered = !!numbered
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((numbered ?? bullet)![1])
      continue
    }
    flushList()
    if (!line.trim()) {
      pushGap()
      continue
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ kind: 'h', level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, '') })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'hr' })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      const last = out[out.length - 1]
      if (last && last.kind === 'quote') last.text += `\n${quote[1]}`
      else out.push({ kind: 'quote', text: quote[1] })
      continue
    }
    out.push({ kind: 'p', text: line.trim() })
  }
  flushList()
  while (out.length && out[out.length - 1].kind === 'gap') out.pop()
  while (out.length && out[0].kind === 'gap') out.shift()
  return out
}

/* ------------------------------ inline tokens ----------------------------- */

export type Tone = 'pos' | 'neg' | null
export interface InlineTok {
  t: 'text' | 'b' | 'i' | 'code'
  s: string
}

/** **bold**, *italic* / _italic_, `code` — flat (no nesting beyond bold/italic text). */
export function inlineTokens(text: string): InlineTok[] {
  const out: InlineTok[] = []
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<![\w_])_[^_\s][^_]*_(?![\w_]))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', s: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**') || tok.startsWith('__')) out.push({ t: 'b', s: tok.slice(2, -2) })
    else if (tok.startsWith('`')) out.push({ t: 'code', s: tok.slice(1, -1) })
    else out.push({ t: 'i', s: tok.slice(1, -1) })
    last = m.index + tok.length
  }
  if (last < text.length) out.push({ t: 'text', s: text.slice(last) })
  return out
}

/**
 * Split text into runs, marking signed money (+$1,234.56 / -$416.28 / −$5k),
 * signed points (+12.5 pts) and signed percents (-4.2%) as gains or losses.
 * A hyphen inside a range ("10-20%", "9:30-10:30") is not a sign.
 */
export function toneRuns(text: string): { s: string; tone: Tone }[] {
  const out: { s: string; tone: Tone }[] = []
  const re = /(?<![\w$.,:])([+\-−–])\s?(\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?|\d[\d,]*(?:\.\d+)?\s?(?:%|pts?\b|points\b|R\b))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ s: text.slice(last, m.index), tone: null })
    out.push({ s: m[0], tone: m[1] === '+' ? 'pos' : 'neg' })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ s: text.slice(last), tone: null })
  return out
}

/**
 * Coaching callouts: a list item or paragraph that starts with a bold label
 * like **Do:**, **Don't:**, **Watch for:** gets a coloured accent.
 */
export function calloutTone(text: string): 'good' | 'bad' | 'warn' | null {
  const m = /^\s*\*\*([^*]{1,40})\*\*/.exec(text)
  if (!m) return null
  const label = m[1].toLowerCase().replace(/[’']/g, "'").trim()
  if (/^(don't|do not|avoid|stop|never|leak|problem|cut|drop|quit)\b/.test(label)) return 'bad'
  if (/^(do|keep|continue|strength|working|win|more of|lean into|trade)\b/.test(label)) return 'good'
  if (/^(watch|risk|warning|caution|fix|next|try|focus|rule|note)\b/.test(label)) return 'warn'
  return null
}

/** Plain text of a markdown line (for titles, alt text). */
export function plainText(md: string): string {
  return md
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/^#+\s*/, '')
    .trim()
}

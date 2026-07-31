import { isPayment } from './categories'

/**
 * Generic credit-card statement CSV parser (pure). Handles the common bank
 * exports (Chase, Amex, Capital One, Discover, Citi, BofA…) by detecting the
 * header row and its date / description / amount (or debit+credit) columns,
 * then normalizing the sign convention so CHARGES ARE POSITIVE and credits,
 * refunds and card payments are negative.
 */

export interface ParsedTxn {
  ymd: string
  ms: number
  desc: string
  /** positive = money spent, negative = credit/refund/payment */
  amount: number
}

export interface ParsedStatement {
  txns: ParsedTxn[]
  errors: number
  note?: string
}

/** RFC-ish CSV → rows of cells (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

function parseDateStr(sRaw: string): { ymd: string; ms: number } | null {
  const s = sRaw.trim()
  let y = 0
  let m = 0
  let d = 0
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (match) {
    y = +match[1]
    m = +match[2]
    d = +match[3]
  } else {
    match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(s)
    if (!match) return null
    m = +match[1]
    d = +match[2]
    y = +match[3]
    if (y < 100) y += 2000
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null
  return {
    ymd: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    ms: Date.UTC(y, m - 1, d, 12)
  }
}

function parseAmount(sRaw: string): number | null {
  let s = sRaw.trim()
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  const n = Number(s.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return neg ? -Math.abs(n) : n
}

const DESC_NAMES = ['description', 'payee', 'merchant', 'details', 'name', 'memo']

export function parseStatement(text: string): ParsedStatement {
  const rows = parseCsv(text)
  if (rows.length === 0) return { txns: [], errors: 0, note: 'Empty file.' }

  // find the header row within the first 10 lines
  let headerIdx = -1
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase())
    const hasDate = cells.some((c) => c.includes('date'))
    const hasDesc = cells.some((c) => DESC_NAMES.some((n) => c.includes(n)))
    const hasAmt = cells.some((c) => c.includes('amount') || c.includes('debit') || c.includes('credit'))
    if (hasDate && hasDesc && hasAmt) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) return { txns: [], errors: rows.length, note: 'Could not find a header row with date / description / amount columns.' }

  const header = rows[headerIdx].map((c) => c.trim().toLowerCase())
  const dateIdx = (() => {
    const trans = header.findIndex((c) => c.includes('date') && c.includes('trans'))
    return trans !== -1 ? trans : header.findIndex((c) => c.includes('date'))
  })()
  const descIdx = (() => {
    for (const n of DESC_NAMES) {
      const i = header.findIndex((c) => c.includes(n))
      if (i !== -1) return i
    }
    return -1
  })()
  const debitIdx = header.findIndex((c) => c.includes('debit'))
  const creditIdx = header.findIndex((c) => c.includes('credit') && !c.includes('card'))
  const amountIdx = header.findIndex((c) => c.includes('amount') && !c.includes('debit') && !c.includes('credit'))
  const typeIdx = header.findIndex((c) => c === 'type' || c.includes('transaction type'))

  interface RawRow {
    ymd: string
    ms: number
    desc: string
    raw: number
    typed: 'spend' | 'credit' | null
  }
  const parsed: RawRow[] = []
  let errors = 0

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i]
    const date = dateIdx >= 0 ? parseDateStr(cells[dateIdx] ?? '') : null
    const desc = (descIdx >= 0 ? cells[descIdx] : '')?.trim() ?? ''
    if (!date || !desc) {
      errors++
      continue
    }
    let raw: number | null = null
    let typed: 'spend' | 'credit' | null = null
    if (debitIdx >= 0 || creditIdx >= 0) {
      const deb = debitIdx >= 0 ? parseAmount(cells[debitIdx] ?? '') : null
      const cred = creditIdx >= 0 ? parseAmount(cells[creditIdx] ?? '') : null
      if (deb != null && deb !== 0) {
        raw = Math.abs(deb)
        typed = 'spend'
      } else if (cred != null && cred !== 0) {
        raw = Math.abs(cred)
        typed = 'credit'
      }
    }
    if (raw == null && amountIdx >= 0) raw = parseAmount(cells[amountIdx] ?? '')
    if (raw == null) {
      errors++
      continue
    }
    if (typed == null && typeIdx >= 0) {
      const t = (cells[typeIdx] ?? '').trim().toLowerCase()
      if (/sale|purchase|debit|fee/.test(t)) typed = 'spend'
      else if (/payment|credit|return|refund|adjust|deposit/.test(t)) typed = 'credit'
    }
    parsed.push({ ymd: date.ymd, ms: date.ms, desc, raw, typed })
  }

  // Sign orientation for single-amount files: use a typed "spend" row when we
  // have one; otherwise the majority sign among non-payment rows = charges.
  let flip = 1
  const untypedNeeded = parsed.some((r) => r.typed == null)
  if (untypedNeeded) {
    const typedSpend = parsed.find((r) => r.typed === 'spend' && r.raw !== 0)
    if (typedSpend) flip = typedSpend.raw >= 0 ? 1 : -1
    else {
      const spendRows = parsed.filter((r) => !isPayment(r.desc.toUpperCase()))
      const neg = spendRows.filter((r) => r.raw < 0).length
      flip = neg > spendRows.length / 2 ? -1 : 1
    }
  }

  const txns: ParsedTxn[] = parsed.map((r) => {
    let amount: number
    if (r.typed === 'spend') amount = Math.abs(r.raw)
    else if (r.typed === 'credit') amount = -Math.abs(r.raw)
    else amount = r.raw * flip
    // card payments always reduce the balance — force negative
    if (isPayment(r.desc.toUpperCase())) amount = -Math.abs(amount)
    return { ymd: r.ymd, ms: r.ms, desc: r.desc, amount }
  })

  return { txns, errors }
}

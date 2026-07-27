import { z } from 'zod'

/**
 * ReportSpec — the structured JSON every AI report route returns, and the
 * shape the renderer + PDF builder consume. parseReportSpec is defensively
 * staged (ported behavior): strip code fences -> strict parse -> coercing
 * parse (truncate/clamp instead of reject) -> closeTruncatedJson (repairs
 * JSON cut off mid-stream by token caps). Also unwraps {report:{…}}/{data:{…}}.
 */

export const ReportSpecSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional().default(''),
  ticker: z.string().max(12).optional().default(''),
  company: z.string().max(200).optional().default(''),
  asOf: z.string().max(60).optional().default(''),
  stats: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(80) }))
    .max(12)
    .optional()
    .default([]),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(160),
        body: z.string().max(4000).optional().default(''),
        bullets: z.array(z.string().max(500)).max(6).optional().default([])
      })
    )
    .min(1)
    .max(20),
  disclaimer: z.string().max(600).optional().default('')
})

export type ReportSpec = z.infer<typeof ReportSpecSchema>

/** Strip ``` fences and any prose before the first { / after the last }. */
function extractJsonText(raw: string): string {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  if (start > 0) s = s.slice(start)
  return s
}

/**
 * Repair JSON cut off mid-stream by a token cap: close an open string, drop a
 * dangling key/trailing comma, then close every open bracket.
 */
export function closeTruncatedJson(s: string): string {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop()
  }
  let out = s
  if (inStr) out += '"'
  // dangling `"key":` or `"key"` or a trailing comma at the cut point
  out = out
    .replace(/,\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '')
    .replace(/,\s*"(?:[^"\\]|\\.)*"?\s*$/, '')
    .replace(/:\s*$/, ': null')
    .replace(/,\s*$/, '')
  while (stack.length > 0) out += stack.pop()
  return out
}

const str = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max)

/** Coercing pass: clamp/truncate a roughly-right object instead of rejecting. */
function coerceReport(v: unknown): ReportSpec | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .slice(0, 20)
    .map((s) => ({
      heading: str(s.heading, 160) || 'Section',
      body: str(s.body, 4000),
      bullets: (Array.isArray(s.bullets) ? s.bullets : [])
        .map((b) => str(b, 500))
        .filter(Boolean)
        .slice(0, 6)
    }))
    .filter((s) => s.body || s.bullets.length > 0 || s.heading !== 'Section')
  if (sections.length === 0) return null
  return {
    title: str(r.title, 200) || 'Report',
    subtitle: str(r.subtitle, 300),
    ticker: str(r.ticker, 12),
    company: str(r.company, 200),
    asOf: str(r.asOf, 60),
    stats: (Array.isArray(r.stats) ? r.stats : [])
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .slice(0, 12)
      .map((x) => ({ label: str(x.label, 80), value: str(x.value, 80) }))
      .filter((x) => x.label && x.value),
    sections,
    disclaimer: str(r.disclaimer, 600)
  }
}

/** Unwrap {report:{…}} / {data:{…}} envelopes some models add. */
function unwrap(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v
  const r = v as Record<string, unknown>
  if (r.sections) return r
  if (typeof r.report === 'object' && r.report !== null) return r.report
  if (typeof r.data === 'object' && r.data !== null) return r.data
  return r
}

export function parseReportSpec(raw: string): ReportSpec | null {
  const text = extractJsonText(raw)
  const attempts = [text, closeTruncatedJson(text)]
  for (const attempt of attempts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(attempt)
    } catch {
      continue
    }
    parsed = unwrap(parsed)
    const strict = ReportSpecSchema.safeParse(parsed)
    if (strict.success) return strict.data
    const coerced = coerceReport(parsed)
    if (coerced) return coerced
  }
  return null
}

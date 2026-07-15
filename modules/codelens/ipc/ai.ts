import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { AI_PROVIDER_LABELS } from '../shared/providers'
import type { AiProvider, ExplainResult, FileInfo, VulnIssue } from '../shared/types'

const MAX_CODE_CHARS = 28_000
const MAX_CONTEXT_LINES = 12

interface ActiveAi {
  provider: AiProvider
  model: string
  anthropic?: Anthropic
  /** OpenAI SDK client — also drives DeepSeek and Gemini via their OpenAI-compatible endpoints. */
  compat?: OpenAI
}

let active: ActiveAi | null = null

const COMPAT_BASE_URLS: Record<AiProvider, string | undefined> = {
  claude: undefined,
  openai: undefined, // SDK default
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/'
}

export function configureAi(provider: AiProvider, model: string, apiKey: string | null): void {
  if (!apiKey) {
    active = null
    return
  }
  if (provider === 'claude') {
    active = { provider, model, anthropic: new Anthropic({ apiKey, maxRetries: 2 }) }
  } else {
    active = {
      provider,
      model,
      compat: new OpenAI({ apiKey, baseURL: COMPAT_BASE_URLS[provider], maxRetries: 2 })
    }
  }
}

export function aiAvailable(): boolean {
  return active !== null
}

export function activeAiLabel(): string | null {
  return active ? `${AI_PROVIDER_LABELS[active.provider]} · ${active.model}` : null
}

export const NO_KEY_MESSAGE =
  'No API key set for the selected AI provider. Add one in WICKED Settings → API Keys.'

/** Map SDK errors (both Anthropic and OpenAI-compatible) to messages a user can act on. */
export function friendlyAiError(err: unknown): string {
  const name = active ? AI_PROVIDER_LABELS[active.provider] : 'AI provider'
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return `Your ${name} API key was rejected (invalid or revoked). Update it in Settings.`
  }
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof OpenAI.PermissionDeniedError) {
    return `Your ${name} API key does not have access to model "${active?.model}". Check the model name or your plan.`
  }
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) {
    return `Model "${active?.model}" was not found on ${name}. Check the model name in Settings.`
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return `Rate limited by the ${name} API. Wait a moment and try again.`
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return `Could not reach the ${name} API. Check your internet connection — the rest of CodeLens keeps working offline.`
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const status = (err as { status?: number }).status ?? 0
    if (status >= 500) return `The ${name} API is having a temporary issue. Try again shortly.`
    return `${name} API error (${status}): ${(err as Error).message}`
  }
  return err instanceof Error ? err.message : String(err)
}

interface CompleteOpts {
  system: string
  user: string
  maxTokens: number
  /** When set, ask the provider to return JSON matching this schema (best supported mechanism per provider). */
  jsonSchema?: Record<string, unknown>
}

async function complete(opts: CompleteOpts): Promise<string> {
  if (!active) throw new Error(NO_KEY_MESSAGE)

  if (active.provider === 'claude') {
    const msg = await active.anthropic!.messages.create({
      model: active.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: 'user', content: opts.user }],
      ...(opts.jsonSchema
        ? { output_config: { format: { type: 'json_schema' as const, schema: opts.jsonSchema } } }
        : {})
    })
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: active.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user }
    ]
  }
  if (active.provider === 'openai') {
    // Reasoning models spend completion tokens on hidden reasoning — give headroom.
    params.max_completion_tokens = Math.max(4000, opts.maxTokens * 2)
  } else {
    params.max_tokens = opts.maxTokens
  }
  if (opts.jsonSchema) {
    if (active.provider === 'openai') {
      params.response_format = {
        type: 'json_schema',
        json_schema: { name: 'codelens_result', strict: true, schema: opts.jsonSchema }
      }
    } else if (!active.model.includes('reasoner')) {
      // Gemini compat + deepseek-chat support json_object; deepseek-reasoner rejects response_format.
      params.response_format = { type: 'json_object' }
    }
  }

  const res = await active.compat!.chat.completions.create(params)
  return (res.choices[0]?.message?.content ?? '').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[... truncated, ${text.length - max} more characters ...]`
}

export async function testApiKey(): Promise<string> {
  await complete({
    system: 'You are a connectivity test.',
    user: 'Reply with exactly: ok',
    maxTokens: 200
  })
  return 'ok'
}

// --- single-file explanation (JSON-shaped) -----------------------------------

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One plain-English sentence (max ~30 words) saying what this file does.'
    },
    detail: {
      type: 'string',
      description:
        'One detailed paragraph (5–9 sentences) covering purpose, key functions/classes, inputs and outputs, side effects (network, disk, database), and anything surprising or risky.'
    }
  },
  required: ['summary', 'detail'],
  additionalProperties: false
}

const EXPLAIN_SYSTEM = `You are CodeLens, a code-intelligence assistant embedded in a desktop app.
Your reader is a developer who just inherited this codebase and is seeing the file for the first time.
Explain in plain English. Prefer everyday words over jargon, but name the concrete functions, classes, and data flows that matter.
Describe only behavior visible in the code — never invent endpoints, schemas, or features that are not there.`

export async function explainFile(file: FileInfo, content: string): Promise<ExplainResult> {
  const user = `File: ${file.relPath} (${file.language}, ${file.lines} lines)

<code>
${truncate(content, MAX_CODE_CHARS)}
</code>

Explain this file at two levels: a one-sentence summary and a detailed paragraph.
Respond with only a single JSON object {"summary": "...", "detail": "..."} — no markdown fences, no extra keys.`

  const raw = await complete({
    system: EXPLAIN_SYSTEM,
    user,
    maxTokens: 2000,
    jsonSchema: EXPLAIN_SCHEMA
  })

  try {
    // Tolerate accidental code fences from weaker JSON modes.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned) as { summary?: unknown; detail?: unknown }
    if (typeof parsed.summary === 'string' && typeof parsed.detail === 'string') {
      return { summary: parsed.summary, detail: parsed.detail }
    }
  } catch {
    // fall through to the fallback below
  }
  const firstSentence = raw.split(/(?<=[.!?])\s/)[0] ?? raw
  return { summary: firstSentence.slice(0, 240), detail: raw }
}

// --- connection explanation --------------------------------------------------

export async function explainConnections(
  file: FileInfo,
  inbound: string[],
  outbound: string[]
): Promise<string> {
  const user = `File: ${file.relPath} (${file.language})

Files inside this project that THIS FILE imports/uses (outbound):
${outbound.length ? outbound.map((f) => `- ${f}`).join('\n') : '- (none)'}

Files inside this project that IMPORT/USE THIS FILE (inbound):
${inbound.length ? inbound.map((f) => `- ${f}`).join('\n') : '- (none)'}

External packages it imports:
${file.externalImports.length ? file.externalImports.map((p) => `- ${p}`).join('\n') : '- (none)'}

In plain English, explain what this file connects to. Respond in markdown with exactly two short sections:
**What it uses** — what this file depends on and (judging by names) why.
**What uses it** — what relies on this file and what likely breaks if it changes.
Keep it under 180 words. If a direction has no connections, say what that implies (entry point, leaf utility, dead code…).`

  return complete({ system: EXPLAIN_SYSTEM, user, maxTokens: 1200 })
}

// --- vulnerability explanation ----------------------------------------------

const ISSUE_SYSTEM = `You are CodeLens's security mentor. You explain static-analysis findings to working developers in plain English.
Be concrete: reference the actual code shown, not generic theory. If the finding looks like a false positive, say so honestly and explain why.`

export async function explainIssue(issue: VulnIssue, fileContent: string | null): Promise<string> {
  let context = issue.snippet
  if (fileContent) {
    const lines = fileContent.split('\n')
    const start = Math.max(0, issue.line - 1 - MAX_CONTEXT_LINES)
    const end = Math.min(lines.length, issue.line + MAX_CONTEXT_LINES)
    context = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}${start + i + 1 === issue.line ? ' >' : '  '} ${l}`)
      .join('\n')
  }

  const user = `Static analysis flagged this issue:
Rule: ${issue.title} (${issue.ruleId}, severity: ${issue.severity})
File: ${issue.file}, line ${issue.line}
Rule description: ${issue.description}

Code around the flagged line (the "> " marks it):
<code>
${truncate(context, 6000)}
</code>

Respond in markdown with exactly two sections:
**Why this is risky** — 2–4 sentences grounded in this specific code.
**How to fix it** — a short corrected code snippet for this exact case, plus 1–3 sentences. Under 250 words total.`

  return complete({ system: ISSUE_SYSTEM, user, maxTokens: 1500 })
}

// --- whole-project summary ----------------------------------------------------

const SUMMARY_SYSTEM = `You are CodeLens, producing a plain-English project report for a developer who just inherited a codebase.
Write 600–1000 words of well-structured markdown with exactly these sections:
# Project Report: <project name>
## What This App Does
## Architecture
## Data Flow
## Key Modules
## Risks & Code Health
## Where To Start Reading
Be specific and cite real file names from the provided material. Use plain English. Do not pad, do not invent files or behavior that were not provided.`

export interface SummaryContext {
  projectName: string
  stats: string
  treeText: string
  hotspots: string
  issuesText: string
  keyFiles: { relPath: string; content: string }[]
}

export async function summarizeProject(ctx: SummaryContext): Promise<string> {
  const filesBlock = ctx.keyFiles
    .map((f) => `--- FILE: ${f.relPath} ---\n${truncate(f.content, 8000)}`)
    .join('\n\n')

  const user = `Project: ${ctx.projectName}
${ctx.stats}

File tree (trimmed):
${ctx.treeText}

Dependency hotspots (most connected files):
${ctx.hotspots}

Static-analysis findings:
${ctx.issuesText}

Key file contents:
${filesBlock}

Write the project report now.`

  return complete({ system: SUMMARY_SYSTEM, user, maxTokens: 5000 })
}

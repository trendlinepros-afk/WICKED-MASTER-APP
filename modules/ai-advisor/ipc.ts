import { randomUUID } from 'crypto'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { AI_ADVISOR_EVENT, type AdvisorEvent, type ChatMessage, type Conversation, type ToolTrace } from './types'
import { stocksTools, runTool, type AdvisorTool } from './tools'
import { deleteChat as brainDeleteChat, saveChat as brainSaveChat, type SimpleMsg } from '../the-brain/lib/brainStore'

/**
 * AI Advisor — an agentic Claude chat that can read every stocks-folder tool.
 * The loop streams text, calls tools (find-trades/stock-planner/market-news/…),
 * and gates the paid X/Twitter tools behind a per-call user confirmation.
 */

const ID = 'ai-advisor'
const KEY = `${ID}.conversations`
const MAX_TOKENS = 4096
const MAX_ROUNDS = 8
const MODEL_KEY = `${ID}.model`

/**
 * Selectable engines. Cheaper options let the advisor run sustainably.
 * inPer/outPer are approximate USD prices per 1M tokens (for the cost estimate).
 */
export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet', provider: 'anthropic', hint: 'Best reasoning · highest cost', inPer: 3, outPer: 15 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku', provider: 'anthropic', hint: 'Fast · ~5× cheaper than Sonnet', inPer: 1, outPer: 5 },
  { id: 'gemini-2.5-flash', label: 'Gemini Flash', provider: 'gemini', hint: 'Cheapest · great for daily use', inPer: 0.3, outPer: 2.5 },
  { id: 'gemini-2.5-pro', label: 'Gemini Pro', provider: 'gemini', hint: 'Strong · mid cost', inPer: 1.25, outPer: 10 }
] as const

type ModelDef = (typeof MODELS)[number]
const DEFAULT_MODEL: ModelDef = MODELS[0]

function getModel(ctx: ModuleIpcContext): ModelDef {
  const stored = ctx.storeGet<string>(MODEL_KEY, DEFAULT_MODEL.id)
  return MODELS.find((m) => m.id === stored) ?? DEFAULT_MODEL
}
function providerKey(ctx: ModuleIpcContext, provider: string): string | null {
  return ctx.getApiKey(provider === 'gemini' ? 'gemini' : 'anthropic')
}
const CONVO_CAP = 60

/* ------------------------------ error/retry ------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errStatus(err: unknown): number {
  const e = err as { status?: number; statusCode?: number }
  return Number(e?.status ?? e?.statusCode ?? 0)
}

function isAbortErr(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  return name === 'APIUserAbortError' || /abort/i.test(err instanceof Error ? err.message : String(err))
}

/** Transient API conditions worth retrying (overloaded, rate-limit, 5xx, network). */
function isTransientErr(err: unknown): boolean {
  const s = errStatus(err)
  if (s === 408 || s === 409 || s === 429 || s >= 500) return true
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /overload|rate.?limit|timeout|temporarily|econnreset|etimedout|fetch failed|network/.test(m)
}

/** A readable message for the user instead of a raw SDK/JSON error body. */
function friendlyErr(err: unknown): string {
  const s = errStatus(err)
  const raw = err instanceof Error ? err.message : String(err)
  const m = raw.toLowerCase()
  if (s === 529 || /overload/.test(m))
    return 'Claude is temporarily overloaded. I retried a few times without luck — please send your message again in a moment.'
  if (s === 429 || /rate.?limit/.test(m)) return 'Hit the API rate limit. Wait a few seconds and try again.'
  if (s === 401 || /invalid x-api-key|authentication|unauthorized/.test(m))
    return 'Your Anthropic API key was rejected. Check it in Settings → API Keys.'
  if (s >= 500) return 'The AI service had a temporary error. Please try again in a moment.'
  return `The AI request failed: ${raw.replace(/\s+/g, ' ').slice(0, 300)}`
}

/** Merge consecutive same-role messages so the API never sees two user (or two
 *  assistant) turns in a row — e.g. a chat left with a dangling user message from
 *  an earlier failed turn. */
function coalesceMessages(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  for (const m of msgs) {
    const last = out[out.length - 1]
    if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string')
      last.content = `${last.content}\n\n${m.content}`
    else out.push({ role: m.role, content: m.content })
  }
  return out
}

/* ------------------------------ persistence ------------------------------ */

function readAll(ctx: ModuleIpcContext): Conversation[] {
  const list = ctx.storeGet<Conversation[]>(KEY, [])
  return Array.isArray(list) ? list : []
}
function writeAll(ctx: ModuleIpcContext, convos: Conversation[]): void {
  ctx.storeSet(KEY, convos.slice(0, CONVO_CAP))
}
function sortConvos(convos: Conversation[]): Conversation[] {
  return [...convos].sort((a, b) => b.updatedAt - a.updatedAt)
}
function metaOf(c: Conversation): { id: string; title: string; updatedAt: number; count: number; archived: boolean } {
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length, archived: !!c.archived }
}

/* --------------------------- The Brain sync ------------------------------ *
 * Every conversation is mirrored into the app's local markdown vault (The
 * Brain) under Chats/AI Advisor/, updated as it grows and removed when deleted.
 * Failures are swallowed — the Brain is a nice-to-have, never a blocker.
 * ------------------------------------------------------------------------- */
const BRAIN_SOURCE = 'AI Advisor'

function convoToBrain(ctx: ModuleIpcContext, convo: Conversation): void {
  try {
    if (!convo.messages.length) return // don't clutter the vault with empty chats
    const messages: SimpleMsg[] = convo.messages.map((m) => {
      let sub: string | undefined
      if (m.role === 'assistant') {
        const bits: string[] = []
        const label = MODELS.find((x) => x.id === m.model)?.label
        if (label) bits.push(label)
        if (typeof m.costUsd === 'number') bits.push(`~$${m.costUsd.toFixed(m.costUsd < 0.01 ? 4 : 3)}`)
        if (m.tools && m.tools.length) bits.push(`${m.tools.length} tool${m.tools.length === 1 ? '' : 's'}`)
        sub = bits.join(' · ') || undefined
      }
      return { role: m.role, text: m.text, ts: m.ts, sub }
    })
    brainSaveChat(ctx.app, {
      source: BRAIN_SOURCE,
      id: convo.id,
      title: convo.title,
      messages,
      createdAt: convo.createdAt,
      updatedAt: convo.updatedAt
    })
  } catch {
    /* Brain is optional */
  }
}

function convoDeleteBrain(ctx: ModuleIpcContext, id: string): void {
  try {
    brainDeleteChat(ctx.app, BRAIN_SOURCE, id)
  } catch {
    /* Brain is optional */
  }
}

/** One-time backfill of every existing conversation into The Brain. */
function portConversationsToBrain(ctx: ModuleIpcContext): void {
  const flag = `${ID}.brainPorted`
  if (ctx.storeGet<boolean>(flag, false)) return
  try {
    for (const c of readAll(ctx)) convoToBrain(ctx, c)
  } catch {
    /* ignore */
  }
  ctx.storeSet(flag, true)
}

/* ---------------------------- system prompt ------------------------------ */

function systemPrompt(): string {
  return [
    'You are the AI Advisor inside WICKED, a desktop trading app. You are a sharp, candid trading co-pilot for ONE user.',
    '',
    "You have live tools that read the user's own Stocks tools and the market:",
    '- Journals & analytics: their Trade Journal (Webull executions), Trade Log entries, and Trade Review intraday candles.',
    '- Market data & research: quotes, fundamentals, earnings dates, screeners, IPO calendar, and multi-ticker compare.',
    '- Market news: market-wide and per-company headlines.',
    '- Screens: the Find Trades screener and its backtest / graded outcomes.',
    '- X/Twitter trend tools (PAID — see below).',
    '',
    'How to work:',
    "- When the user asks about THEIR trading, positions, performance, or a trade idea, USE the tools to pull real data first — journals, quotes, news, candles — then reason from what you actually got. Don't guess or rely on memory.",
    '- Be specific and quantitative. Cite the numbers, tickers and dates you pulled. If a tool errors or a data key is missing, say so plainly and continue with what you have.',
    '- Give clear, actionable takes with the reasoning AND the risks. You are an advisor, not a hype machine. Never fabricate data or prices.',
    "- You have READ access only. You cannot place trades or modify the user's journals — if they ask you to, explain that and tell them which tool to use.",
    '',
    'X/Twitter tools cost real money per use. You MAY call them when X sentiment genuinely adds value, but the app will ask the user to approve each X call. If the user declines, continue without X and note the gap. Do not spam X calls.',
    '',
    'Charts — you can render charts inline. Emit a fenced code block whose language is "wicked-chart" containing JSON on its own lines:',
    '- Price candles (the app fetches the data — you only give the symbol + date): ```wicked-chart {"kind":"candles","symbol":"NVDA","ymd":"2026-07-28","title":"NVDA — Jul 28"} ```',
    '- Your trading stats (compute the numbers yourself from the tool data and inline them): {"kind":"bar","title":"Realized P/L by symbol","unit":"$","data":[{"label":"NVDA","value":420},{"label":"TSLA","value":-130}]}',
    '- Also supported: {"kind":"line",...} and {"kind":"pie",...} using the same data:[{"label","value"}] shape.',
    'PROACTIVELY visualize: when you review performance or the trading archive, show a bar/line/pie of the key stats (P/L by symbol, P/L by day, win/loss counts, etc.). When you discuss a specific stock\'s price action, show its candles for the relevant day. Put each chart block on its own lines as valid JSON, and still explain it in words. Use "$" as the unit for dollar amounts.',
    '',
    `Today is ${new Date().toDateString()}. Keep answers focused and use markdown.`
  ].join('\n')
}

/* ------------------------------- x-gate ---------------------------------- */

const pendingGates = new Map<string, (approved: boolean) => void>()
let gateSeq = 0

function askXApproval(emit: (e: AdvisorEvent) => void, requestId: string, tool: AdvisorTool): Promise<boolean> {
  const gateId = `${requestId}:${gateSeq++}`
  emit({ requestId, type: 'x-confirm', gateId, name: tool.def.name, label: tool.label })
  return new Promise<boolean>((resolve) => {
    pendingGates.set(gateId, resolve)
  })
}

/* ------------------------------ agent loop ------------------------------- */

interface AgentOut {
  text: string
  tools: ToolTrace[]
  usage: { input: number; output: number }
}

const activeStreams = new Map<string, { abort: () => void }>()

/** Run one tool call (shared across providers): X-gate → execute → trace. */
async function handleToolCall(
  emit: (e: AdvisorEvent) => void,
  requestId: string,
  byName: Map<string, AdvisorTool>,
  name: string,
  input: unknown,
  traces: ToolTrace[]
): Promise<{ content: string; isError: boolean }> {
  const tool = byName.get(name)
  const label = tool?.label ?? name
  emit({ requestId, type: 'tool', name, label, phase: 'start' })
  if (!tool) {
    traces.push({ name, label, status: 'error', summary: 'unknown tool' })
    emit({ requestId, type: 'tool', name, label, phase: 'error' })
    return { content: `Unknown tool "${name}".`, isError: true }
  }
  if (tool.paidX) {
    const approved = await askXApproval(emit, requestId, tool)
    if (!approved) {
      traces.push({ name, label, status: 'declined', summary: 'user declined (paid X API)' })
      emit({ requestId, type: 'tool', name, label, phase: 'declined' })
      return {
        content:
          'The user DECLINED to use the paid X/Twitter API for this request. Do not retry X tools; answer using other data and note that X sentiment was not checked.',
        isError: false
      }
    }
  }
  const run = await runTool(tool, input)
  traces.push({ name, label, status: run.status, summary: run.status === 'error' ? run.text.slice(0, 140) : undefined })
  emit({ requestId, type: 'tool', name, label, phase: run.status })
  return { content: run.text, isError: run.status === 'error' }
}

/** Dispatch to the provider loop for the chosen model. */
async function runAgent(
  ctx: ModuleIpcContext,
  model: ModelDef,
  apiKey: string,
  requestId: string,
  prior: ChatMessage[],
  userText: string
): Promise<AgentOut> {
  const emit = (e: AdvisorEvent): void => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, e)
  }
  const tools = stocksTools()
  const byName = new Map(tools.map((t) => [t.def.name, t]))
  return model.provider === 'gemini'
    ? runGeminiAgent(emit, apiKey, model.id, requestId, tools, byName, prior, userText)
    : runAnthropicAgent(emit, apiKey, model.id, requestId, tools, byName, prior, userText)
}

async function runAnthropicAgent(
  emit: (e: AdvisorEvent) => void,
  apiKey: string,
  modelId: string,
  requestId: string,
  tools: AdvisorTool[],
  byName: Map<string, AdvisorTool>,
  prior: ChatMessage[],
  userText: string
): Promise<AgentOut> {
  const client = new Anthropic({ apiKey, maxRetries: 3 })
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.def.name,
    description: t.def.description,
    input_schema: t.jsonSchema as Anthropic.Tool['input_schema']
  }))

  const messages: Anthropic.MessageParam[] = coalesceMessages([
    ...prior.filter((m) => m.text.trim()).map((m) => ({ role: m.role, content: m.text }) as Anthropic.MessageParam),
    { role: 'user', content: userText }
  ])

  const traces: ToolTrace[] = []
  let assembled = ''
  let repairs = 0
  let usageIn = 0
  let usageOut = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Stream one round, retrying transient API errors (overloaded / rate-limit / 5xx).
    let final: Anthropic.Message | undefined
    for (let attempt = 0; ; attempt++) {
      const stream = client.messages.stream({
        model: modelId,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(),
        messages,
        ...(anthropicTools.length ? { tools: anthropicTools } : {})
      })
      activeStreams.set(requestId, { abort: () => stream.abort() })
      stream.on('text', (_delta, snapshot) => emit({ requestId, type: 'text', text: assembled + snapshot }))
      stream.on('error', () => {
        /* surfaced via finalMessage() rejection; listener prevents an unhandled 'error' */
      })
      try {
        final = await stream.finalMessage()
        break
      } catch (err) {
        activeStreams.delete(requestId)
        if (isAbortErr(err)) {
          if (assembled.trim()) return { text: assembled.trim(), tools: traces, usage: { input: usageIn, output: usageOut } }
          throw err
        }
        if (isTransientErr(err) && attempt < 3) {
          emit({ requestId, type: 'text', text: `${assembled}\n\n_Claude is busy — retrying (${attempt + 1}/3)…_` })
          await sleep(Math.min(8000, 800 * 2 ** attempt))
          continue
        }
        if (assembled.trim()) return { text: assembled.trim(), tools: traces, usage: { input: usageIn, output: usageOut } }
        throw err
      }
    }
    activeStreams.delete(requestId)
    if (!final) throw new Error('No response from Claude.')
    usageIn += final.usage?.input_tokens ?? 0
    usageOut += final.usage?.output_tokens ?? 0

    const textPart = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    if (toolUses.length === 0) {
      if (textPart.trim()) {
        assembled += textPart
        emit({ requestId, type: 'text', text: assembled })
        break
      }
      // Empty answer (no text, no tools). Retry the same context a couple of times —
      // occasional empty completions happen, especially right after tool results.
      if (repairs < 2) {
        repairs++
        console.warn(`[ai-advisor] empty completion (stop=${final.stop_reason}); retrying (${repairs}/2)`)
        continue
      }
      assembled += `_The model returned an empty response${final.stop_reason ? ` (stop reason: ${final.stop_reason})` : ''}. Please try asking again._`
      emit({ requestId, type: 'text', text: assembled })
      break
    }

    // model wants tools: commit any preamble text, then run each tool.
    // Drop empty text blocks so the follow-up request can't 400 on an empty block.
    if (textPart) assembled += `${textPart}\n\n`
    const assistantContent = final.content.filter((b) => !(b.type === 'text' && !b.text.trim()))
    messages.push({ role: 'assistant', content: assistantContent as Anthropic.ContentBlockParam[] })

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const { content, isError } = await handleToolCall(emit, requestId, byName, tu.name, tu.input, traces)
      results.push({ type: 'tool_result', tool_use_id: tu.id, content, ...(isError ? { is_error: true } : {}) })
    }
    messages.push({ role: 'user', content: results })

    if (round === MAX_ROUNDS - 1) {
      assembled += '\n\n_(Reached the tool-step limit for this turn — ask a follow-up if you need me to keep going.)_'
      emit({ requestId, type: 'text', text: assembled })
    }
  }

  return { text: assembled.trim() || '(no response)', tools: traces, usage: { input: usageIn, output: usageOut } }
}

/* -------------------------------- gemini --------------------------------- */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** JSON Schema → Gemini function-declaration parameter schema (OpenAPI subset). */
function sanitizeForGemini(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const s = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (s.type) out.type = String(s.type).toUpperCase()
  if (typeof s.description === 'string') out.description = s.description
  if (Array.isArray(s.enum)) out.enum = s.enum
  if (s.properties && typeof s.properties === 'object') {
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      const ps = sanitizeForGemini(v)
      if (ps) props[k] = ps
    }
    out.properties = props
  }
  if (Array.isArray(s.required)) out.required = s.required
  if (s.items) out.items = sanitizeForGemini(s.items)
  return out
}

async function geminiGenerate(
  apiKey: string,
  modelId: string,
  body: unknown,
  requestId: string,
  emit: (e: AdvisorEvent) => void,
  assembled: string
): Promise<{ content: GeminiContent; usage: { input: number; output: number } }> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response
    try {
      resp = await fetch(`${GEMINI_BASE}/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      if (isTransientErr(err) && attempt < 3) {
        emit({ requestId, type: 'text', text: `${assembled}\n\n_Model is busy — retrying (${attempt + 1}/3)…_` })
        await sleep(Math.min(8000, 800 * 2 ** attempt))
        continue
      }
      throw err
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '')
      const err = Object.assign(new Error(`Gemini ${resp.status}: ${t.slice(0, 300)}`), { status: resp.status })
      if (isTransientErr(err) && attempt < 3) {
        emit({ requestId, type: 'text', text: `${assembled}\n\n_Model is busy — retrying (${attempt + 1}/3)…_` })
        await sleep(Math.min(8000, 800 * 2 ** attempt))
        continue
      }
      throw err
    }
    const data = (await resp.json()) as {
      candidates?: { content?: GeminiContent }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    return {
      content: data.candidates?.[0]?.content ?? { role: 'model', parts: [] },
      usage: { input: data.usageMetadata?.promptTokenCount ?? 0, output: data.usageMetadata?.candidatesTokenCount ?? 0 }
    }
  }
}

async function runGeminiAgent(
  emit: (e: AdvisorEvent) => void,
  apiKey: string,
  modelId: string,
  requestId: string,
  tools: AdvisorTool[],
  byName: Map<string, AdvisorTool>,
  prior: ChatMessage[],
  userText: string
): Promise<AgentOut> {
  const functionDeclarations = tools.map((t) => {
    const params = sanitizeForGemini(t.jsonSchema)
    const decl: Record<string, unknown> = { name: t.def.name, description: t.def.description }
    if (params && params.properties && Object.keys(params.properties as object).length > 0) decl.parameters = params
    return decl
  })

  const contents: GeminiContent[] = []
  for (const m of prior)
    if (m.text.trim()) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })
  contents.push({ role: 'user', parts: [{ text: userText }] })

  const traces: ToolTrace[] = []
  let assembled = ''
  let repairs = 0
  let usageIn = 0
  let usageOut = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      generationConfig: { maxOutputTokens: MAX_TOKENS }
    }
    const res = await geminiGenerate(apiKey, modelId, body, requestId, emit, assembled)
    usageIn += res.usage.input
    usageOut += res.usage.output
    const parts = res.content.parts ?? []
    const textPart = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
    const calls = parts.filter((p): p is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } => !!p.functionCall)

    if (calls.length === 0) {
      if (textPart.trim()) {
        assembled += textPart
        emit({ requestId, type: 'text', text: assembled })
        break
      }
      if (repairs < 2) {
        repairs++
        continue
      }
      assembled += '_The model returned an empty response. Please try asking again._'
      emit({ requestId, type: 'text', text: assembled })
      break
    }

    if (textPart) {
      assembled += `${textPart}\n\n`
      emit({ requestId, type: 'text', text: assembled })
    }
    contents.push({ role: 'model', parts })
    const responseParts: GeminiPart[] = []
    for (const call of calls) {
      const { content: result } = await handleToolCall(emit, requestId, byName, call.functionCall.name, call.functionCall.args ?? {}, traces)
      responseParts.push({ functionResponse: { name: call.functionCall.name, response: { result } } })
    }
    contents.push({ role: 'user', parts: responseParts })

    if (round === MAX_ROUNDS - 1) {
      assembled += '\n\n_(Reached the tool-step limit for this turn — ask a follow-up if you need me to keep going.)_'
      emit({ requestId, type: 'text', text: assembled })
    }
  }
  return { text: assembled.trim() || '(no response)', tools: traces, usage: { input: usageIn, output: usageOut } }
}

/* --------------------------------- ipc ----------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  // Backfill existing conversations into The Brain once (no-op after the first run).
  portConversationsToBrain(ctx)

  ctx.ipcMain.handle(`${ID}:status`, () => {
    const m = getModel(ctx)
    return {
      ok: true,
      model: m.id,
      modelLabel: m.label,
      provider: m.provider,
      hasKey: providerKey(ctx, m.provider) !== null,
      toolCount: stocksTools().length,
      models: MODELS.map((x) => ({
        id: x.id,
        label: x.label,
        provider: x.provider,
        hint: x.hint,
        hasKey: providerKey(ctx, x.provider) !== null
      }))
    }
  })

  ctx.ipcMain.handle(`${ID}:set-model`, (_e, id: unknown) => {
    const found = MODELS.find((m) => m.id === String(id))
    if (found) ctx.storeSet(MODEL_KEY, found.id)
    const m = getModel(ctx)
    return { ok: !!found, model: m.id, modelLabel: m.label, provider: m.provider, hasKey: providerKey(ctx, m.provider) !== null }
  })

  ctx.ipcMain.handle(`${ID}:list`, () => ({ ok: true, conversations: sortConvos(readAll(ctx)).map(metaOf) }))

  ctx.ipcMain.handle(`${ID}:get`, (_e, id: unknown) => {
    const c = readAll(ctx).find((x) => x.id === String(id)) ?? null
    return { ok: !!c, conversation: c }
  })

  ctx.ipcMain.handle(`${ID}:new`, () => {
    const now = Date.now()
    const convo: Conversation = { id: randomUUID(), title: 'New chat', messages: [], createdAt: now, updatedAt: now }
    writeAll(ctx, [convo, ...readAll(ctx)])
    return { ok: true, conversation: convo }
  })

  ctx.ipcMain.handle(`${ID}:rename`, (_e, id: unknown, title: unknown) => {
    const convos = readAll(ctx)
    const i = convos.findIndex((x) => x.id === String(id))
    if (i === -1) return { ok: false, error: 'Not found.' }
    convos[i] = { ...convos[i], title: String(title ?? '').slice(0, 80) || convos[i].title, updatedAt: Date.now() }
    writeAll(ctx, convos)
    convoToBrain(ctx, convos[i]) // rename the note on disk to match
    return { ok: true, conversation: convos[i] }
  })

  ctx.ipcMain.handle(`${ID}:archive`, (_e, id: unknown, archived: unknown) => {
    const convos = readAll(ctx)
    const i = convos.findIndex((x) => x.id === String(id))
    if (i === -1) return { ok: false, error: 'Not found.' }
    convos[i] = { ...convos[i], archived: !!archived }
    writeAll(ctx, convos)
    return { ok: true, conversations: sortConvos(readAll(ctx)).map(metaOf) }
  })

  ctx.ipcMain.handle(`${ID}:delete`, (_e, id: unknown) => {
    writeAll(ctx, readAll(ctx).filter((x) => x.id !== String(id)))
    convoDeleteBrain(ctx, String(id)) // remove the note from The Brain too
    return { ok: true, conversations: sortConvos(readAll(ctx)).map(metaOf) }
  })

  ctx.ipcMain.handle(`${ID}:x-decision`, (_e, gateId: unknown, approved: unknown) => {
    const resolve = pendingGates.get(String(gateId))
    if (resolve) {
      pendingGates.delete(String(gateId))
      resolve(!!approved)
    }
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:stop`, (_e, requestId: unknown) => {
    activeStreams.get(String(requestId))?.abort()
    return { ok: true }
  })

  ctx.ipcMain.handle(`${ID}:send`, async (_e, requestId: unknown, conversationId: unknown, text: unknown) => {
    const rid = String(requestId)
    const emitErr = (error: string): { ok: false; error: string } => {
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, { requestId: rid, type: 'error', error } as AdvisorEvent)
      return { ok: false, error }
    }

    const userText = String(text ?? '').trim()
    if (!userText) return emitErr('Empty message.')
    const model = getModel(ctx)
    const apiKey = providerKey(ctx, model.provider)
    if (!apiKey)
      return emitErr(
        `No ${model.provider === 'gemini' ? 'Gemini' : 'Anthropic'} API key set for ${model.label}. Add one in Settings → API Keys, or switch models in the header.`
      )

    const convos = readAll(ctx)
    const i = convos.findIndex((x) => x.id === String(conversationId))
    if (i === -1) return emitErr('Conversation not found.')

    // append the user's message + auto-title a fresh chat
    const prior = convos[i].messages
    const userMsg: ChatMessage = { role: 'user', text: userText, ts: Date.now() }
    const title = convos[i].title === 'New chat' ? userText.slice(0, 48) : convos[i].title
    convos[i] = { ...convos[i], title, messages: [...prior, userMsg], updatedAt: Date.now() }
    writeAll(ctx, convos)

    try {
      const out = await runAgent(ctx, model, apiKey, rid, prior, userText)
      const costUsd = (out.usage.input / 1e6) * model.inPer + (out.usage.output / 1e6) * model.outPer
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        text: out.text,
        tools: out.tools,
        usage: out.usage,
        costUsd,
        model: model.id,
        ts: Date.now()
      }
      const after = readAll(ctx)
      const j = after.findIndex((x) => x.id === convos[i].id)
      if (j !== -1) {
        after[j] = { ...after[j], messages: [...after[j].messages, assistantMsg], updatedAt: Date.now() }
        writeAll(ctx, after)
        convoToBrain(ctx, after[j]) // mirror the completed turn into The Brain
      }
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, { requestId: rid, type: 'done' } as AdvisorEvent)
      return { ok: true, conversation: j !== -1 ? after[j] : null }
    } catch (err) {
      // Roll back the just-added user message so a failed turn can't leave a
      // dangling user turn (which would duplicate on retry and break role
      // alternation). Hand the text back so the composer can restore it.
      const back = readAll(ctx)
      const k = back.findIndex((x) => x.id === convos[i].id)
      if (k !== -1) {
        const msgs = back[k].messages
        if (msgs.length && msgs[msgs.length - 1].role === 'user' && msgs[msgs.length - 1].text === userText) {
          back[k] = { ...back[k], messages: msgs.slice(0, -1) }
          writeAll(ctx, back)
        }
      }
      const error = friendlyErr(err)
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, { requestId: rid, type: 'error', error } as AdvisorEvent)
      return { ok: false, error, conversation: k !== -1 ? back[k] : null, restore: userText }
    }
  })

  ctx.ipcMain.handle(`${ID}:data-paths`, (): ModuleDataPath[] => {
    let base = ''
    try {
      base = ctx.app.getPath('userData')
    } catch {
      /* not available */
    }
    return [
      {
        label: 'Saved conversations',
        path: base ? join(base, 'wicked-modules.json') : null,
        note: 'Stored under the "ai-advisor.conversations" key. Included in Backup & Cloud Sync.'
      }
    ]
  })
}

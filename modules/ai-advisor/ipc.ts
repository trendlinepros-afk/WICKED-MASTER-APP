import { randomUUID } from 'crypto'
import { join } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import type { ModuleDataPath } from '@shared/types'
import { AI_ADVISOR_EVENT, type AdvisorEvent, type ChatMessage, type Conversation, type ToolTrace } from './types'
import { stocksTools, runTool, type AdvisorTool } from './tools'

/**
 * AI Advisor — an agentic Claude chat that can read every stocks-folder tool.
 * The loop streams text, calls tools (find-trades/stock-planner/market-news/…),
 * and gates the paid X/Twitter tools behind a per-call user confirmation.
 */

const ID = 'ai-advisor'
const KEY = `${ID}.conversations`
const MODEL = 'claude-sonnet-5'
const MAX_TOKENS = 4096
const MAX_ROUNDS = 8
const CONVO_CAP = 60

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
function metaOf(c: Conversation): { id: string; title: string; updatedAt: number; count: number } {
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }
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
}

const activeStreams = new Map<string, { abort: () => void }>()

async function runAgent(
  ctx: ModuleIpcContext,
  apiKey: string,
  requestId: string,
  prior: ChatMessage[],
  userText: string
): Promise<AgentOut> {
  const emit = (e: AdvisorEvent): void => {
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, e)
  }

  const client = new Anthropic({ apiKey })
  const tools = stocksTools()
  const byName = new Map(tools.map((t) => [t.def.name, t]))
  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.def.name,
    description: t.def.description,
    input_schema: t.jsonSchema as Anthropic.Tool['input_schema']
  }))

  const messages: Anthropic.MessageParam[] = prior
    .filter((m) => m.text.trim())
    .map((m) => ({ role: m.role, content: m.text }))
  messages.push({ role: 'user', content: userText })

  const traces: ToolTrace[] = []
  let assembled = ''

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(),
      messages,
      ...(anthropicTools.length ? { tools: anthropicTools } : {})
    })
    activeStreams.set(requestId, { abort: () => stream.abort() })
    stream.on('text', (_delta, snapshot) => emit({ requestId, type: 'text', text: assembled + snapshot }))

    let final: Anthropic.Message
    try {
      final = await stream.finalMessage()
    } catch (err) {
      activeStreams.delete(requestId)
      // aborted by the user → return whatever we have so far
      if (assembled.trim()) return { text: assembled.trim(), tools: traces }
      throw err
    }
    activeStreams.delete(requestId)

    const textPart = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')

    if (toolUses.length === 0) {
      assembled += textPart
      emit({ requestId, type: 'text', text: assembled })
      break
    }

    // model wants tools: commit any preamble text, then run each tool
    if (textPart) assembled += `${textPart}\n\n`
    messages.push({ role: 'assistant', content: final.content as Anthropic.ContentBlockParam[] })

    const results: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const tool = byName.get(tu.name)
      const label = tool?.label ?? tu.name
      emit({ requestId, type: 'tool', name: tu.name, label, phase: 'start' })

      if (!tool) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool "${tu.name}".`, is_error: true })
        traces.push({ name: tu.name, label, status: 'error', summary: 'unknown tool' })
        emit({ requestId, type: 'tool', name: tu.name, label, phase: 'error' })
        continue
      }

      if (tool.paidX) {
        const approved = await askXApproval(emit, requestId, tool)
        if (!approved) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'The user DECLINED to use the paid X/Twitter API for this request. Do not retry X tools; answer using other data and note that X sentiment was not checked.'
          })
          traces.push({ name: tu.name, label, status: 'declined', summary: 'user declined (paid X API)' })
          emit({ requestId, type: 'tool', name: tu.name, label, phase: 'declined' })
          continue
        }
      }

      const run = await runTool(tool, tu.input)
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: run.text, ...(run.status === 'error' ? { is_error: true } : {}) })
      traces.push({ name: tu.name, label, status: run.status, summary: run.status === 'error' ? run.text.slice(0, 140) : undefined })
      emit({ requestId, type: 'tool', name: tu.name, label, phase: run.status })
    }
    messages.push({ role: 'user', content: results })

    if (round === MAX_ROUNDS - 1) {
      assembled += '\n\n_(Reached the tool-step limit for this turn — ask a follow-up if you need me to keep going.)_'
      emit({ requestId, type: 'text', text: assembled })
    }
  }

  return { text: assembled.trim() || '(no response)', tools: traces }
}

/* --------------------------------- ipc ----------------------------------- */

export default function register(ctx: ModuleIpcContext): void {
  ctx.ipcMain.handle(`${ID}:status`, () => ({
    ok: true,
    hasKey: ctx.getApiKey('anthropic') !== null,
    toolCount: stocksTools().length
  }))

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
    return { ok: true, conversation: convos[i] }
  })

  ctx.ipcMain.handle(`${ID}:delete`, (_e, id: unknown) => {
    writeAll(ctx, readAll(ctx).filter((x) => x.id !== String(id)))
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
    const apiKey = ctx.getApiKey('anthropic')
    if (!apiKey) return emitErr('No Anthropic API key set. Add one in Settings → API Keys to use the AI Advisor.')

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
      const out = await runAgent(ctx, apiKey, rid, prior, userText)
      const assistantMsg: ChatMessage = { role: 'assistant', text: out.text, tools: out.tools, ts: Date.now() }
      const after = readAll(ctx)
      const j = after.findIndex((x) => x.id === convos[i].id)
      if (j !== -1) {
        after[j] = { ...after[j], messages: [...after[j].messages, assistantMsg], updatedAt: Date.now() }
        writeAll(ctx, after)
      }
      const win = ctx.getMainWindow()
      if (win && !win.isDestroyed()) win.webContents.send(AI_ADVISOR_EVENT, { requestId: rid, type: 'done' } as AdvisorEvent)
      return { ok: true, conversation: j !== -1 ? after[j] : null }
    } catch (err) {
      return emitErr(err instanceof Error ? err.message : String(err))
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

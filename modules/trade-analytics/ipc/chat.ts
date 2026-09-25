/**
 * AI Coach chat transport (main process): multi-turn, streamed, across the
 * same providers as the one-shot analysis. No Electron imports, so it can be
 * exercised headless with a stubbed fetch.
 */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

/** Output budget per reply — long enough that a detailed answer isn't cut mid-sentence. */
export const CHAT_MAX_TOKENS = 8192

/**
 * Read a server-sent-event stream, handing each `data:` JSON payload to
 * `pick`, which returns the text delta in it (or null), and to `stopOf`,
 * which reports a finish reason when the payload carries one. Returns the
 * full text and the last finish reason seen.
 */
export async function readSse(
  resp: Response,
  pick: (json: Record<string, unknown>) => string | null,
  onDelta: (t: string) => void,
  stopOf: (json: Record<string, unknown>) => string | null = () => null
): Promise<{ text: string; stop: string | null }> {
  if (!resp.body) throw new Error('No response stream')
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let full = ''
  let stop: string | null = null
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    let json: Record<string, unknown>
    try {
      json = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    const err = json.error as { message?: string } | undefined
    if (err) throw new Error(err.message ?? 'stream error')
    const t = pick(json)
    if (t) {
      full += t
      onDelta(t)
    }
    stop = stopOf(json) ?? stop
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      handle(line)
    }
  }
  handle((buf + dec.decode()).trim())
  return { text: full, stop }
}

async function errorText(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { error?: { message?: string } | string }
    return typeof j.error === 'string' ? j.error : (j.error?.message ?? String(resp.status))
  } catch {
    return String(resp.status)
  }
}

/** Fold repeated roles together (providers want strict user/assistant turns). */
export function normalizeChat(raw: unknown[]): ChatMsg[] {
  const messages = raw
    .map((m) => (typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {}))
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role as ChatMsg['role'], content: String(m.content).slice(0, 12_000) }))
    .slice(-40)
    .reduce<ChatMsg[]>((acc, m) => {
      const last = acc[acc.length - 1]
      if (last && last.role === m.role) last.content += `\n\n${m.content}`
      else acc.push({ ...m })
      return acc
    }, [])
  while (messages.length && messages[0].role !== 'user') messages.shift()
  return messages
}

/**
 * Multi-turn coach chat, streamed. Same provider order as the one-shot
 * analysis (first key that works wins); a provider that fails before sending
 * any text falls through to the next one.
 */
export async function callAiChat(
  getApiKey: (provider: string) => string | null,
  system: string,
  messages: ChatMsg[],
  signal: AbortSignal,
  onDelta: (t: string) => void
): Promise<{ provider: string; model: string; text: string; truncated: boolean } | { error: string; partial?: string }> {
  const attempts: string[] = []
  let streamed = ''
  const tap = (t: string): void => {
    streamed += t
    onDelta(t)
  }
  const fail = (name: string, err: unknown): { error: string; partial: string } | null => {
    if (signal.aborted) return { error: 'Stopped.', partial: streamed }
    // once text has reached the user, don't silently switch providers mid-answer
    if (streamed) return { error: `${name}: ${errMsg(err)}`, partial: streamed }
    attempts.push(`${name}: ${errMsg(err)}`)
    return null
  }

  const anthropic = getApiKey('anthropic')
  if (anthropic) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropic, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: CHAT_MAX_TOKENS, system, messages, stream: true }),
        signal
      })
      if (!resp.ok) throw new Error(await errorText(resp))
      const { text, stop } = await readSse(
        resp,
        (j) => (j.type === 'content_block_delta' ? ((j.delta as { text?: string } | undefined)?.text ?? null) : null),
        tap,
        (j) => (j.type === 'message_delta' ? ((j.delta as { stop_reason?: string } | undefined)?.stop_reason ?? null) : null)
      )
      if (text.trim()) return { provider: 'Anthropic (Claude)', model: 'claude-sonnet-5', text, truncated: stop === 'max_tokens' }
      throw new Error('empty reply')
    } catch (err) {
      const r = fail('Anthropic', err)
      if (r) return r
    }
  }

  const openAiLike = async (
    name: string,
    url: string,
    key: string,
    model: string,
    maxTokens: number
  ): Promise<{ provider: string; model: string; text: string; truncated: boolean }> => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages], stream: true }),
      signal
    })
    if (!resp.ok) throw new Error(await errorText(resp))
    const { text, stop } = await readSse(
      resp,
      (j) => (j.choices as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? null,
      tap,
      (j) => (j.choices as { finish_reason?: string | null }[] | undefined)?.[0]?.finish_reason ?? null
    )
    if (text.trim()) return { provider: name, model, text, truncated: stop === 'length' }
    throw new Error('empty reply')
  }

  const openai = getApiKey('openai')
  if (openai) {
    try {
      return await openAiLike('OpenAI (GPT-4o)', 'https://api.openai.com/v1/chat/completions', openai, 'gpt-4o', CHAT_MAX_TOKENS)
    } catch (err) {
      const r = fail('OpenAI', err)
      if (r) return r
    }
  }

  const gemini = getApiKey('gemini')
  if (gemini) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${encodeURIComponent(gemini)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            generationConfig: { maxOutputTokens: 16384 },
            contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
          }),
          signal
        }
      )
      if (!resp.ok) throw new Error(await errorText(resp))
      const { text, stop } = await readSse(
        resp,
        (j) =>
          (j.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts
            ?.map((p) => p.text ?? '')
            .join('') || null,
        tap,
        (j) => (j.candidates as { finishReason?: string }[] | undefined)?.[0]?.finishReason ?? null
      )
      if (text.trim()) return { provider: 'Google Gemini', model: 'gemini-2.5-flash', text, truncated: stop === 'MAX_TOKENS' }
      throw new Error('empty reply')
    } catch (err) {
      const r = fail('Gemini', err)
      if (r) return r
    }
  }

  const deepseek = getApiKey('deepseek')
  if (deepseek) {
    try {
      return await openAiLike('DeepSeek', 'https://api.deepseek.com/chat/completions', deepseek, 'deepseek-chat', CHAT_MAX_TOKENS)
    } catch (err) {
      const r = fail('DeepSeek', err)
      if (r) return r
    }
  }

  if (attempts.length === 0) return { error: 'No AI key set. Add an Anthropic, OpenAI, Gemini or DeepSeek key in Settings → API Keys.' }
  return { error: 'AI request failed — ' + attempts.join(' | ') }
}

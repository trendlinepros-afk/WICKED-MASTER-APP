/**
 * Shared LLM layer for the stock tools. "AUTO" preference: Gemini -> DeepSeek
 * -> OpenAI, trying the next provider when one fails. Ported quirk: structured
 * JSON calls pin Gemini to a NON-thinking model (default gemini-2.5-flash),
 * because thinking models burn the output budget and truncate the JSON.
 * Vision (chart screenshots) uses Gemini or OpenAI; DeepSeek is skipped when
 * images are attached.
 */

const TIMEOUT_MS = 90_000
const MAX_TOKENS = 8192

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  text: string
  /** data: URLs (image/png or image/jpeg) */
  images?: string[]
}

export interface AiKeys {
  gemini: string | null
  deepseek: string | null
  openai: string | null
}

export interface AiOptions {
  json?: boolean
  tier?: 'lite' | 'pro'
  /** Gemini model override (STOCK_REPORT_MODEL equivalent) */
  geminiModel?: string
}

export type AiResult = { ok: true; text: string; provider: string } | { ok: false; error: string }

function dataUrlParts(url: string): { mime: string; data: string } | null {
  const m = url.match(/^data:([\w/+.-]+);base64,(.+)$/)
  return m ? { mime: m[1], data: m[2] } : null
}

async function callGemini(key: string, messages: AiMessage[], opts: AiOptions): Promise<string> {
  const hasImages = messages.some((m) => (m.images?.length ?? 0) > 0)
  const model =
    opts.geminiModel ||
    (opts.json || hasImages ? 'gemini-2.5-flash' : opts.tier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash-lite')
  const system = messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n\n')
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        { text: m.text },
        ...(m.images ?? [])
          .map(dataUrlParts)
          .filter((p): p is { mime: string; data: string } => p !== null)
          .map((p) => ({ inline_data: { mime_type: p.mime, data: p.data } }))
      ]
    }))
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      ...(opts.json ? { responseMimeType: 'application/json' } : {})
    }
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  )
  const j = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
    error?: { message?: string }
  }
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${j.error?.message ?? ''}`)
  const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
  if (!text) throw new Error('Gemini returned an empty response.')
  return text
}

async function callOpenAiCompat(
  url: string,
  key: string,
  model: string,
  messages: AiMessage[],
  opts: AiOptions,
  allowImages: boolean
): Promise<string> {
  const msgs = messages.map((m) => {
    const images = allowImages ? (m.images ?? []) : []
    if (images.length === 0) return { role: m.role, content: m.text }
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.text },
        ...images.map((u) => ({ type: 'image_url', image_url: { url: u } }))
      ]
    }
  })
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: msgs,
      max_tokens: MAX_TOKENS,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {})
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const j = (await resp.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
  if (!resp.ok) throw new Error(`${resp.status}: ${j.error?.message ?? ''}`)
  const text = j.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('Empty response.')
  return text
}

export async function callAi(keys: AiKeys, messages: AiMessage[], opts: AiOptions = {}): Promise<AiResult> {
  const hasImages = messages.some((m) => (m.images?.length ?? 0) > 0)
  const attempts: string[] = []

  if (keys.gemini) {
    try {
      return { ok: true, text: await callGemini(keys.gemini, messages, opts), provider: 'Gemini' }
    } catch (err) {
      attempts.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (keys.deepseek && !hasImages) {
    try {
      return {
        ok: true,
        text: await callOpenAiCompat('https://api.deepseek.com/chat/completions', keys.deepseek, 'deepseek-chat', messages, opts, false),
        provider: 'DeepSeek'
      }
    } catch (err) {
      attempts.push('DeepSeek ' + (err instanceof Error ? err.message : String(err)))
    }
  }
  if (keys.openai) {
    try {
      return {
        ok: true,
        text: await callOpenAiCompat('https://api.openai.com/v1/chat/completions', keys.openai, 'gpt-4o', messages, opts, true),
        provider: 'OpenAI'
      }
    } catch (err) {
      attempts.push('OpenAI ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  if (attempts.length === 0)
    return { ok: false, error: 'No AI key set. Add a Gemini, DeepSeek or OpenAI key in Settings → API Keys.' }
  return { ok: false, error: 'AI request failed — ' + attempts.join(' | ').slice(0, 500) }
}

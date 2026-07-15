import axios from 'axios'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { configStore } from './config-persistence'
import {
  PROVIDER_PRICING,
  type ProviderId,
  type AppConfig
} from '../../shared/config'
import type { ProviderStatus, Role } from '../../shared/types'
import { getApiKey } from './keys'

/**
 * Cloud provider chat: OpenAI, DeepSeek (both OpenAI-compatible), Anthropic,
 * and Google Gemini. Provides streaming chat, key validation, and a rough
 * token estimator used for pre-send cost confirmation. API keys come from the
 * WICKED shell's central vault (Settings → API Keys), read at call time.
 */
export class ApiProviderService {
  private cfg(): AppConfig {
    return configStore.load()
  }

  private key(provider: ProviderId): string {
    return getApiKey(provider)
  }

  /** Rough token estimate (~4 chars/token). */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /** Validate a provider's key with a cheap request. */
  async testProvider(provider: ProviderId): Promise<ProviderStatus> {
    const key = this.key(provider)
    if (!key) {
      return { provider, status: 'unconfigured', message: 'No API key set.' }
    }
    try {
      switch (provider) {
        case 'openai':
          await axios.get('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 10000
          })
          break
        case 'deepseek':
          await axios.get('https://api.deepseek.com/models', {
            headers: { Authorization: `Bearer ${key}` },
            timeout: 10000
          })
          break
        case 'anthropic':
          await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
              model: this.cfg().api.anthropic.model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }]
            },
            {
              headers: {
                'x-api-key': key,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
              },
              timeout: 15000
            }
          )
          break
        case 'gemini': {
          const genai = new GoogleGenerativeAI(key)
          const model = genai.getGenerativeModel({
            model: this.cfg().api.gemini.model
          })
          await model.generateContent('ping')
          break
        }
      }
      return { provider, status: 'valid', message: 'Key is valid.' }
    } catch (err) {
      return {
        provider,
        status: 'invalid',
        message: describeApiError(err)
      }
    }
  }

  /**
   * Stream a chat completion from a cloud provider. `onToken` fires per token;
   * resolves with the full text. Abort via `signal`.
   */
  async streamChat(
    provider: ProviderId,
    model: string,
    messages: { role: Role; content: string }[],
    opts: { temperature: number; maxTokens: number; signal: AbortSignal },
    onToken: (t: string) => void
  ): Promise<string> {
    const key = this.key(provider)
    if (!key) throw new Error(`No API key configured for ${provider}.`)

    if (provider === 'gemini') {
      return this.streamGemini(key, model, messages, opts, onToken)
    }
    if (provider === 'anthropic') {
      return this.streamAnthropic(key, model, messages, opts, onToken)
    }
    // OpenAI + DeepSeek share the OpenAI-compatible SSE format.
    const baseUrl =
      provider === 'deepseek'
        ? 'https://api.deepseek.com/v1'
        : 'https://api.openai.com/v1'
    return this.streamOpenAiCompatible(
      baseUrl,
      key,
      model,
      messages,
      opts,
      onToken
    )
  }

  private async streamOpenAiCompatible(
    baseUrl: string,
    key: string,
    model: string,
    messages: { role: Role; content: string }[],
    opts: { temperature: number; maxTokens: number; signal: AbortSignal },
    onToken: (t: string) => void
  ): Promise<string> {
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        stream: true
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'content-type': 'application/json'
        },
        responseType: 'stream',
        signal: opts.signal
      }
    )
    return consumeSse(res.data, (data) => {
      if (data === '[DONE]') return ''
      try {
        const obj = JSON.parse(data)
        return obj.choices?.[0]?.delta?.content ?? ''
      } catch {
        return ''
      }
    }, onToken)
  }

  private async streamAnthropic(
    key: string,
    model: string,
    messages: { role: Role; content: string }[],
    opts: { temperature: number; maxTokens: number; signal: AbortSignal },
    onToken: (t: string) => void
  ): Promise<string> {
    // Anthropic requires system prompts as a top-level field.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    const convo = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        system: system || undefined,
        messages: convo,
        stream: true
      },
      {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        responseType: 'stream',
        signal: opts.signal
      }
    )
    return consumeSse(res.data, (data) => {
      try {
        const obj = JSON.parse(data)
        if (obj.type === 'content_block_delta') {
          return obj.delta?.text ?? ''
        }
        return ''
      } catch {
        return ''
      }
    }, onToken)
  }

  private async streamGemini(
    key: string,
    model: string,
    messages: { role: Role; content: string }[],
    opts: { temperature: number; maxTokens: number; signal: AbortSignal },
    onToken: (t: string) => void
  ): Promise<string> {
    const genai = new GoogleGenerativeAI(key)
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    const gm = genai.getGenerativeModel({
      model,
      systemInstruction: system || undefined,
      generationConfig: {
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens
      }
    })
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
    const result = await gm.generateContentStream({ contents })
    let full = ''
    for await (const chunk of result.stream) {
      if (opts.signal.aborted) break
      const text = chunk.text()
      if (text) {
        full += text
        onToken(text)
      }
    }
    return full
  }
}

/**
 * Consume an SSE (`text/event-stream`) node stream, extracting token deltas
 * via `extract`. Resolves with the accumulated text.
 */
function consumeSse(
  stream: NodeJS.ReadableStream,
  extract: (data: string) => string,
  onToken: (t: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    let full = ''
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        const token = extract(data)
        if (token) {
          full += token
          onToken(token)
        }
      }
    })
    stream.on('end', () => resolve(full))
    stream.on('error', (e: Error) => reject(e))
  })
}

function describeApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    if (status === 401) return 'Invalid API key (401 Unauthorized).'
    if (status === 429) return 'Rate limited (429).'
    const apiMsg =
      (err.response?.data as { error?: { message?: string } })?.error?.message
    return apiMsg ?? err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export function priceFor(model: string): {
  inputPer1k: number
  outputPer1k: number
} {
  return PROVIDER_PRICING[model] ?? { inputPer1k: 0, outputPer1k: 0 }
}

export const apiProviderService = new ApiProviderService()

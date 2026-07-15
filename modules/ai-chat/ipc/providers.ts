import OpenAI, { toFile } from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content } from '@google/generative-ai';
import type { ContentPart, Message, Provider } from '../types';
import * as db from './db';
import * as mcp from './mcp';

// All provider calls for the ai-chat module, running in the MAIN process.
// Port note: in the standalone app these lived in the renderer (useChat.ts /
// voice.ts / models.ts) with keys read from sqlite settings. In the WICKED
// suite keys come from the shell's central vault via ctx.getApiKey — handed in
// through initKeyResolver at registration — and never transit IPC.

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type KeyResolver = (provider: string) => string | null;

let resolver: KeyResolver | null = null;

export function initKeyResolver(fn: KeyResolver): void {
  resolver = fn;
}

/** Decrypted key for a provider ('' when unset). Read at call time. */
export function getApiKey(provider: string): string {
  return resolver?.(provider)?.trim() ?? '';
}

export function keyStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of ['openai', 'gemini', 'deepseek', 'anthropic']) out[p] = !!getApiKey(p);
  return out;
}

function requireKey(provider: Provider): string {
  if (provider === 'ollama') return 'ollama'; // local — the SDK just wants a non-empty string
  const key = getApiKey(provider);
  if (!key) {
    throw new Error(
      `No API key set for ${provider}. Set one in WICKED Settings → API Keys.`
    );
  }
  return key;
}

function ollamaOpenAIBase(): string {
  const url = db.getSettings().ollamaBaseUrl || 'http://localhost:11434';
  return `${url.replace(/\/+$/, '')}/v1`;
}

function openAICompatClient(provider: Provider): OpenAI {
  const apiKey = requireKey(provider);
  const baseURL =
    provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : provider === 'ollama'
        ? ollamaOpenAIBase()
        : undefined;
  return new OpenAI({ apiKey, baseURL });
}

// ---------- Retry (transient errors) ----------

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransient(err)) throw err;
      const delay = baseMs * 2 ** attempt + Math.floor((attempt * 137) % 250);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  if (e?.status === 429) return true;
  if (typeof e?.status === 'number' && e.status >= 500) return true;
  const msg = (e?.message || '').toLowerCase();
  return (
    e?.code === 'ECONNRESET' ||
    e?.code === 'ETIMEDOUT' ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded')
  );
}

// ---------- Message format adapters ----------

function partsToText(parts: ContentPart[]): string {
  return parts
    .map((p) => {
      if (p.type === 'text' && p.text) return p.text;
      // Include extracted text from attached documents so the model can read them.
      if (p.type === 'file' && p.text) return `\n[Attached file: ${p.name ?? 'file'}]\n${p.text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatForOpenAI(messages: Message[]): ChatMsg[] {
  return messages.map((m) => {
    if (m.role === 'system') {
      return { role: 'system', content: partsToText(m.content) } as ChatMsg;
    }
    if (m.role === 'assistant') {
      return { role: 'assistant', content: partsToText(m.content) } as ChatMsg;
    }
    // user — may include images
    const hasImage = m.content.some((p) => p.type === 'image_url' && p.image_url?.url);
    if (!hasImage) {
      return { role: 'user', content: partsToText(m.content) } as ChatMsg;
    }
    const content = m.content
      .map((p) => {
        if (p.type === 'text' && p.text) {
          return { type: 'text' as const, text: p.text };
        }
        if (p.type === 'file' && p.text) {
          return { type: 'text' as const, text: `[Attached file: ${p.name ?? 'file'}]\n${p.text}` };
        }
        if (p.type === 'image_url' && p.image_url?.url) {
          return { type: 'image_url' as const, image_url: { url: p.image_url.url } };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { role: 'user', content } as ChatMsg;
  });
}

function dataUrlToInline(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function formatForGemini(messages: Message[]): { system?: string; contents: Content[] } {
  let system: string | undefined;
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? system + '\n\n' : '') + partsToText(m.content);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Content['parts'] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ text: p.text });
      if (p.type === 'file' && p.text) {
        parts.push({ text: `[Attached file: ${p.name ?? 'file'}]\n${p.text}` });
      }
      if (p.type === 'image_url' && p.image_url?.url) {
        const inline = dataUrlToInline(p.image_url.url);
        if (inline) parts.push({ inlineData: inline });
      }
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role, parts });
  }
  return { system, contents };
}

// ---------- Streaming chat (with the MCP tool loop) ----------

export interface StreamOpts {
  provider: Provider;
  modelVersion: string;
  messages: Message[];
  onToken: (full: string) => void;
  signal: AbortSignal;
}

// In-flight streams by requestId so the renderer's Stop button (or a
// superseding send) can cancel the provider request.
const streams = new Map<string, AbortController>();

export function beginStream(requestId: string): AbortController {
  const controller = new AbortController();
  streams.set(requestId, controller);
  return controller;
}

export function endStream(requestId: string): void {
  streams.delete(requestId);
}

export function abortStream(requestId: string): void {
  streams.get(requestId)?.abort();
  streams.delete(requestId);
}

export function abortAllStreams(): void {
  for (const c of streams.values()) c.abort();
  streams.clear();
}

export async function streamChat(opts: StreamOpts): Promise<string> {
  if (opts.provider === 'gemini') return streamGemini(opts);
  return streamOpenAICompatible(opts);
}

async function streamOpenAICompatible(opts: StreamOpts): Promise<string> {
  const client = openAICompatClient(opts.provider);

  // Pull any MCP tools the user has configured. When present we run a
  // (non-streaming) tool-calling loop so the model can drive external tools
  // — e.g. a Godot editor MCP server — before producing its final answer.
  let mcpTools: mcp.McpToolInfo[] = [];
  try {
    mcpTools = await mcp.listAllTools();
  } catch {
    mcpTools = [];
  }

  if (mcpTools.length > 0) {
    return runToolLoop(client, opts, mcpTools);
  }

  const stream = await withRetry(() =>
    client.chat.completions.create(
      {
        model: opts.modelVersion,
        messages: formatForOpenAI(opts.messages),
        stream: true,
      },
      { signal: opts.signal }
    )
  );
  let full = '';
  for await (const chunk of stream) {
    if (opts.signal.aborted) break;
    full += chunk.choices[0]?.delta?.content || '';
    opts.onToken(full);
  }
  return full;
}

async function runToolLoop(
  client: OpenAI,
  opts: StreamOpts,
  mcpTools: mcp.McpToolInfo[]
): Promise<string> {
  const tools = mcpTools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.qualifiedName,
      description: `[${t.serverName}] ${t.description}`,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));

  const messages = formatForOpenAI(opts.messages);
  const MAX_ROUNDS = 6;
  let lastText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal.aborted) break;
    const res = await withRetry(() =>
      client.chat.completions.create(
        {
          model: opts.modelVersion,
          messages,
          tools,
          tool_choice: 'auto',
        },
        { signal: opts.signal }
      )
    );
    const choice = res.choices[0]?.message;
    if (!choice) break;

    // The model may emit prose alongside tool calls — keep the latest non-empty text.
    if (choice.content) lastText = choice.content;

    if (choice.tool_calls && choice.tool_calls.length > 0) {
      messages.push(choice);
      const note = `${lastText ? lastText + '\n\n' : ''}🛠️ Running ${choice.tool_calls.length} tool call(s)…`;
      opts.onToken(note);
      for (const call of choice.tool_calls) {
        if (call.type !== 'function') continue;
        let result: string;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await mcp.callTool(call.function.name, args);
        } catch (err) {
          result = `Error calling tool: ${(err as Error).message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      continue; // let the model react to the tool results
    }

    const text = choice.content ?? '';
    opts.onToken(text);
    return text;
  }
  // Ran out of rounds (or aborted) — return whatever prose we last saw.
  return lastText || 'Tool loop ended without a final response.';
}

async function streamGemini(opts: StreamOpts): Promise<string> {
  const genAI = new GoogleGenerativeAI(requireKey('gemini'));
  const { system, contents } = formatForGemini(opts.messages);
  const model = genAI.getGenerativeModel({
    model: opts.modelVersion,
    ...(system ? { systemInstruction: system } : {}),
  });
  const result = await withRetry(() =>
    model.generateContentStream({ contents }, { signal: opts.signal })
  );
  let full = '';
  for await (const chunk of result.stream) {
    if (opts.signal.aborted) break;
    full += chunk.text();
    opts.onToken(full);
  }
  return full;
}

// Lightweight non-streaming completion for summaries / titles / categories.
export async function completeText(
  provider: Provider,
  modelVersion: string,
  prompt: string
): Promise<string> {
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(requireKey('gemini'));
    const model = genAI.getGenerativeModel({ model: modelVersion });
    const result = await withRetry(() => model.generateContent(prompt));
    return result.response.text();
  }
  const client = openAICompatClient(provider);
  const res = await withRetry(() =>
    client.chat.completions.create({
      model: modelVersion,
      messages: [{ role: 'user', content: prompt }],
    })
  );
  return res.choices[0]?.message?.content ?? '';
}

// ---------- Embeddings (Brain semantic index) ----------

const EMBED_MODEL = 'text-embedding-3-small';

export async function embedText(text: string): Promise<number[]> {
  const apiKey = getApiKey('openai');
  if (!apiKey) {
    throw new Error('Embeddings need an OpenAI API key — set one in WICKED Settings → API Keys.');
  }
  const client = new OpenAI({ apiKey });
  const res = await client.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),
  });
  return res.data[0].embedding;
}

// ---------- Voice (STT / TTS) ----------

export async function voiceTranscribe(base64: string, mime: string): Promise<string> {
  const apiKey = getApiKey('openai');
  if (!apiKey) {
    throw new Error('Voice needs an OpenAI API key — set one in WICKED Settings → API Keys.');
  }
  const settings = db.getSettings();
  const client = new OpenAI({ apiKey });
  const ext = (mime.split('/')[1] || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
  const file = await toFile(Buffer.from(base64, 'base64'), `speech.${ext}`, { type: mime });
  const res = await withRetry(
    () => client.audio.transcriptions.create({ file, model: settings.sttModel }),
    { retries: 1 }
  );
  return (res.text ?? '').trim();
}

export async function voiceSpeak(text: string, voice: string): Promise<string> {
  const apiKey = getApiKey('openai');
  if (!apiKey) {
    throw new Error('Voice needs an OpenAI API key — set one in WICKED Settings → API Keys.');
  }
  const settings = db.getSettings();
  const client = new OpenAI({ apiKey });
  const res = await client.audio.speech.create({
    model: settings.ttsModel,
    voice: (voice || settings.ttsVoice) as 'alloy',
    input: text,
    response_format: 'mp3',
  });
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ---------- Gemini image generation ----------

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface ApiModel {
  name: string; // e.g. "models/imagen-3.0-generate-002"
  displayName?: string;
  supportedGenerationMethods?: string[];
}

// Cache the model list per key (it doesn't change within a session).
let modelCache: { key: string; models: ApiModel[] } | null = null;

async function fetchGeminiModels(apiKey: string): Promise<ApiModel[]> {
  if (modelCache?.key === apiKey) return modelCache.models;
  const res = await fetch(`${GEMINI_BASE}?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) {
    throw new Error(
      `Couldn't list models (${res.status}): ${(await errorDetail(res)).slice(0, 160)}`
    );
  }
  const data = (await res.json()) as { models?: ApiModel[] };
  const models = data.models ?? [];
  modelCache = { key: apiKey, models };
  return models;
}

const bareName = (m: ApiModel): string => m.name.replace(/^models\//, '');

async function errorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    return j?.error?.message || '';
  } catch {
    return (await res.text().catch(() => '')) || '';
  }
}

// Gemini-native image generation via generateContent (responseModalities: IMAGE).
async function geminiGenerateImage(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`${model} (${res.status}): ${(await errorDetail(res)).slice(0, 160)}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error(`${model}: no image in response`);
  return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
}

// Imagen via the :predict endpoint.
async function imagenPredict(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${GEMINI_BASE}/${model}:predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }),
  });
  if (!res.ok) throw new Error(`${model} (${res.status}): ${(await errorDetail(res)).slice(0, 160)}`);
  const data = (await res.json()) as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] };
  const pred = data.predictions?.[0];
  if (!pred?.bytesBase64Encoded) throw new Error(`${model}: no image returned`);
  return `data:${pred.mimeType || 'image/png'};base64,${pred.bytesBase64Encoded}`;
}

// An image-capable model discovered on the key, plus the method to call it with.
interface ImageModel {
  name: string;
  method: 'predict' | 'generateContent';
}

// Ask the key which models it actually exposes and keep the image-capable ones.
// Imagen models use :predict; Gemini "image"/"image-generation" models use
// :generateContent with responseModalities. Hardcoded ids 404 on many keys
// because availability varies by key/region/billing — discovery avoids that.
function imageModelsFrom(models: ApiModel[]): ImageModel[] {
  const out: ImageModel[] = [];
  for (const m of models) {
    const name = bareName(m);
    const methods = m.supportedGenerationMethods ?? [];
    if (name.includes('imagen') && methods.includes('predict')) {
      out.push({ name, method: 'predict' });
    } else if (
      /image/.test(name) &&
      methods.includes('generateContent') &&
      // Skip vision/understanding models that merely accept images as input.
      !/vision/.test(name)
    ) {
      out.push({ name, method: 'generateContent' });
    }
  }
  // Prefer Gemini-native image generation (cheaper, faster) over Imagen.
  out.sort((a, b) => {
    if (a.method !== b.method) return a.method === 'generateContent' ? -1 : 1;
    return 0;
  });
  return out;
}

// Discover an image-capable model on the user's key and generate. Tries the
// preferred model first (if it's image-capable), then every other discovered
// candidate. Returns the data URL and the model that actually worked.
export async function generateImage(
  preferredModel: string,
  prompt: string
): Promise<{ url: string; model: string }> {
  const apiKey = getApiKey('gemini');
  if (!apiKey) {
    throw new Error('No Gemini API key set. Add one in WICKED Settings → API Keys.');
  }

  const models = await fetchGeminiModels(apiKey);
  const candidates = imageModelsFrom(models);

  if (candidates.length === 0) {
    throw new Error(
      'This Gemini key exposes no image-generation models. Image generation needs a paid/billing-enabled key (and image models enabled for your region).'
    );
  }

  // Try the preferred model first if it's actually image-capable on this key.
  const preferred = candidates.find((c) => c.name === preferredModel);
  const order = preferred ? [preferred, ...candidates.filter((c) => c !== preferred)] : candidates;

  const errors: string[] = [];
  for (const { name, method } of order) {
    try {
      const url =
        method === 'predict'
          ? await imagenPredict(apiKey, name, prompt)
          : await geminiGenerateImage(apiKey, name, prompt);
      return { url, model: name };
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(
    `Tried ${order.length} image model(s) on this key but all failed: ${errors.join(' | ')}`
  );
}

// ---------- Model discovery (for the model dropdowns) ----------

export interface ModelVersion {
  id: string;
  label: string;
}

// Numeric-aware descending sort so newer versions float to the top
// (e.g. "gemini-2.5-pro" before "gemini-1.5-flash").
function byNewest(a: ModelVersion, b: ModelVersion): number {
  return b.id.localeCompare(a.id, undefined, { numeric: true, sensitivity: 'base' });
}

// List the chat-capable models the given provider's key can actually call.
// Returns [] when the key is missing (renderer falls back to defaults).
export async function listChatModels(provider: Provider): Promise<ModelVersion[]> {
  if (provider === 'ollama') return []; // local models are listed by the renderer
  const apiKey = getApiKey(provider);
  if (!apiKey) return [];

  if (provider === 'gemini') {
    const models = await fetchGeminiModels(apiKey);
    const out: ModelVersion[] = [];
    for (const m of models) {
      const methods = m.supportedGenerationMethods ?? [];
      if (!methods.includes('generateContent')) continue;
      const id = bareName(m);
      // Drop non-chat models: embeddings, image generation, answer-quality, tts.
      if (/embedding|imagen|aqa|-tts|image-generation|-image-preview|-image$/i.test(id)) continue;
      out.push({ id, label: m.displayName || id });
    }
    return out.sort(byNewest);
  }

  // OpenAI-compatible (OpenAI + DeepSeek): GET /models, keep the chat models,
  // drop embeddings / audio / image / moderation / legacy completions.
  const baseUrl =
    provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Model list failed (${res.status})`);
  const data = (await res.json()) as { data?: { id?: string }[] };
  const out: ModelVersion[] = [];
  for (const m of data.data ?? []) {
    const id = m.id;
    if (!id) continue;
    if (
      /embed|whisper|tts|dall-e|audio|image|realtime|moderation|transcrib|search|similarity|\bedit\b|babbage|davinci|ada|curie|instruct/i.test(
        id
      )
    ) {
      continue;
    }
    out.push({ id, label: id });
  }
  return out.sort(byNewest);
}

// List the image-generation models the Gemini key can actually call.
export async function listImageModels(): Promise<ModelVersion[]> {
  const apiKey = getApiKey('gemini');
  if (!apiKey) return [];
  const models = await fetchGeminiModels(apiKey);
  const out: ModelVersion[] = [];
  for (const m of models) {
    const id = bareName(m);
    const methods = m.supportedGenerationMethods ?? [];
    const isImagen = /imagen/.test(id) && methods.includes('predict');
    const isGeminiImage =
      /image/.test(id) && methods.includes('generateContent') && !/vision/.test(id);
    if (isImagen || isGeminiImage) out.push({ id, label: m.displayName || id });
  }
  return out;
}

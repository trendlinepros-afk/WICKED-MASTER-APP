/**
 * Pikzels v2 API client (main only; `fetch` is injectable for tests).
 *
 *   POST /v2/thumbnail/text    prompt, model, format, support_image_*, persona, style
 *   POST /v2/thumbnail/image   image_url|image_base64 (YouTube watch links OK), model,
 *                              format, prompt, image_weight (pkz_2), support_image_*, persona, style
 *   POST /v2/thumbnail/edit    prompt, image_*, format, mask_*, support_image_*
 *   POST /v2/thumbnail/score   image_*, title → main_score, subscores, suggestion
 *   POST /v2/title/text        prompt | support_image_* → outputs[], reasoning
 *   POST /v2/pikzonality/persona|style   name + exactly 3 image_urls | image_base64s → { id } (async)
 *   GET/PATCH/DELETE /v2/pikzonality/{id}
 *
 * Auth: X-Api-Key. 429/5xx retried with exponential backoff. Output URLs
 * expire after ~24 h, so callers download immediately.
 */

export const PIKZELS_BASE = 'https://api.pikzels.com'
const MAX_RETRIES = 4
const TIMEOUT_MS = 180_000

export class PikzelsError extends Error {
  status: number
  /** request fields a VALIDATION_ERROR complained about (e.g. ['name']) */
  fields: string[]
  constructor(status: number, message: string, fields: string[] = []) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

type FieldIssue = { field: string; message: string }

/** `details: [{field, message}]` wherever the error body nests it ({details} or {error: {details}}). */
export function validationIssues(text: string): FieldIssue[] {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return []
  }
  const out: FieldIssue[] = []
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 3) return
    if (Array.isArray(v)) {
      for (const d of v) {
        const o = d as Record<string, unknown>
        if (o && typeof o === 'object' && (typeof o.field === 'string' || Array.isArray(o.loc))) {
          const field = typeof o.field === 'string' ? o.field : String((o.loc as unknown[]).at(-1) ?? '')
          out.push({ field, message: String(o.message ?? o.msg ?? '') })
        }
      }
      return
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^(details|errors|detail|error)$/.test(k)) visit(x, depth + 1)
  }
  visit(j, 0)
  return out
}

/**
 * Names to try when Pikzels rejects one with a bare "Provide a valid name" (its
 * rules aren't published): as typed, then camelCase split + symbols dropped,
 * then shorter at word boundaries.
 */
export function nameCandidates(name: string): string[] {
  const out: string[] = []
  const add = (v: string): void => {
    const t = v.replace(/\s+/g, ' ').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  const cut = (v: string, max: number): string => (v.length <= max ? v : v.slice(0, max + 1).replace(/\s+\S*$/, '').trim() || v.slice(0, max))
  add(name)
  const clean = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  add(clean)
  for (const max of [32, 24, 20, 16, 12]) add(cut(clean, max))
  return out
}

export interface ThumbnailOut {
  output: string
  model: string
  prompt_compacted: string
  request_id: string
  /** any credit figure the response carried (heuristic) */
  credits: CreditInfo
  raw: Record<string, unknown>
}

export interface CreditInfo {
  used: number | null
  remaining: number | null
}

export interface ScoreOut {
  main_score: number
  subscores: Record<string, number>
  suggestion: string
  request_id: string
  credits: CreditInfo
}

export interface TitleOut {
  outputs: string[]
  reasoning: string
  prompt_compacted: string
  request_id: string
  credits: CreditInfo
}

export interface PikzonalityStatus {
  id: string
  status: 'processing' | 'completed' | 'failed'
  progress: number
  name?: string
  type?: string
  error?: string
  raw: Record<string, unknown>
}

export interface KeyCheck {
  state: 'ok' | 'rejected' | 'unreachable'
  status: number
  message: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Find credit figures wherever a response puts them (body keys or headers). */
export function creditInfo(body: Record<string, unknown> | null, headers?: Headers): CreditInfo {
  const out: CreditInfo = { used: null, remaining: null }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null)
  const scan = (obj: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase()
      if (/credit/.test(key)) {
        if (/remain|balance|left/.test(key)) out.remaining ??= num(v)
        else if (/used|cost|spent|charged|consumed/.test(key)) out.used ??= num(v)
        else if (typeof v === 'number') out.used ??= v
        else if (v && typeof v === 'object' && depth < 2) scan(v as Record<string, unknown>, depth + 1)
      } else if (/^(cost|usage)$/.test(key) && v && typeof v === 'object' && depth < 2) scan(v as Record<string, unknown>, depth + 1)
    }
  }
  if (body) scan(body, 0)
  headers?.forEach((v, k) => {
    const key = k.toLowerCase()
    if (/credit/.test(key)) {
      if (/remain|balance|left/.test(key)) out.remaining ??= num(v)
      else if (/used|cost|spent/.test(key)) out.used ??= num(v)
    }
  })
  return out
}

function errorMessage(status: number, text: string): string {
  const issues = validationIssues(text)
  if (issues.length) return `Pikzels rejected the request (HTTP ${status}): ${issues.map((i) => `${i.field || 'request'} — ${i.message || 'invalid'}`).join('; ')}`
  let msg = ''
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const pick = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : '')
    msg = pick(j.error) || pick(j.message) || pick(j.detail) || pick(j.errors) || ''
  } catch {
    msg = text.slice(0, 300)
  }
  if (status === 401 || status === 403) return `Pikzels rejected the API key (HTTP ${status})${msg ? `: ${msg}` : ''}. Check Settings → API Keys → Pikzels.`
  if (status === 402) return `Not enough Pikzels credits${msg ? `: ${msg}` : ''}.`
  if (status === 429) return `Pikzels rate limit hit${msg ? `: ${msg}` : ''} — try again in a moment.`
  return `Pikzels error (HTTP ${status})${msg ? `: ${msg}` : ''}`
}

export class PikzelsClient {
  constructor(
    private apiKey: string,
    private fetchFn: Fetch = fetch,
    private base = PIKZELS_BASE
  ) {}

  private async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<{ json: Record<string, unknown>; headers: Headers }> {
    let attempt = 0
    for (;;) {
      let resp: Response
      try {
        resp = await this.fetchFn(`${this.base}${path}`, {
          method,
          headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
        })
      } catch (err) {
        if (signal?.aborted) throw new PikzelsError(0, 'Cancelled')
        if (attempt++ >= MAX_RETRIES) throw new PikzelsError(0, `Could not reach Pikzels: ${err instanceof Error ? err.message : String(err)}`)
        await sleep(1000 * 2 ** attempt + Math.random() * 500)
        continue
      }
      const text = await resp.text()
      if (resp.ok) {
        let json: Record<string, unknown> = {}
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
        } catch {
          throw new PikzelsError(resp.status, 'Pikzels returned a non-JSON response')
        }
        return { json, headers: resp.headers }
      }
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        attempt++
        const ra = Number(resp.headers.get('retry-after'))
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt + Math.random() * 500)
        continue
      }
      throw new PikzelsError(resp.status, errorMessage(resp.status, text), validationIssues(text).map((i) => i.field))
    }
  }

  /**
   * POST with base64 images. Whether Pikzels wants bare base64 or a data URI
   * isn't pinned down in the docs we could reach, so a 4xx on bare base64 is
   * retried once with `data:` URIs before giving up.
   */
  private async postImages(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ json: Record<string, unknown>; headers: Headers }> {
    const b64Keys = Object.keys(body).filter((k) => /base64/.test(k) && body[k] != null)
    try {
      return await this.call('POST', path, body, signal)
    } catch (err) {
      if (!(err instanceof PikzelsError) || err.status < 400 || err.status >= 500 || err.status === 401 || err.status === 403 || err.status === 402 || err.status === 429 || !b64Keys.length) throw err
      // a complaint about a non-image field (e.g. the name) won't be fixed by re-encoding the images
      if (err.fields.length && !err.fields.some((f) => /image|base64/i.test(f))) throw err
      const alt: Record<string, unknown> = { ...body }
      const toUri = (v: string): string => (v.startsWith('data:') ? v : `data:image/jpeg;base64,${v}`)
      for (const k of b64Keys) alt[k] = Array.isArray(body[k]) ? (body[k] as string[]).map(toUri) : toUri(String(body[k]))
      return this.call('POST', path, alt, signal)
    }
  }

  private thumb(json: Record<string, unknown>, headers: Headers): ThumbnailOut {
    const output = String(json.output ?? json.url ?? json.image_url ?? '')
    if (!output) throw new PikzelsError(200, 'Pikzels returned no image URL')
    return { output, model: String(json.model ?? ''), prompt_compacted: String(json.prompt_compacted ?? ''), request_id: String(json.request_id ?? ''), credits: creditInfo(json, headers), raw: json }
  }

  thumbnailText(o: { prompt: string; model: string; format: string; support_image_url?: string; support_image_base64?: string; persona?: string; style?: string }, signal?: AbortSignal): Promise<ThumbnailOut> {
    return this.postImages('/v2/thumbnail/text', strip(o), signal).then(({ json, headers }) => this.thumb(json, headers))
  }

  thumbnailImage(
    o: { image_url?: string; image_base64?: string; model: string; format: string; prompt?: string; image_weight?: string; support_image_url?: string; support_image_base64?: string; persona?: string; style?: string },
    signal?: AbortSignal
  ): Promise<ThumbnailOut> {
    return this.postImages('/v2/thumbnail/image', strip(o), signal).then(({ json, headers }) => this.thumb(json, headers))
  }

  thumbnailEdit(o: { prompt: string; image_url?: string; image_base64?: string; format?: string; mask_url?: string; mask_base64?: string; support_image_url?: string; support_image_base64?: string }, signal?: AbortSignal): Promise<ThumbnailOut> {
    return this.postImages('/v2/thumbnail/edit', strip(o), signal).then(({ json, headers }) => this.thumb(json, headers))
  }

  async thumbnailScore(o: { image_url?: string; image_base64?: string; title?: string }): Promise<ScoreOut> {
    const { json, headers } = await this.postImages('/v2/thumbnail/score', strip(o))
    const subs: Record<string, number> = {}
    const raw = json.subscores
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number') subs[k] = v
    if (Array.isArray(raw)) for (const s of raw as { name?: string; score?: number }[]) if (s?.name && typeof s.score === 'number') subs[s.name] = s.score
    return { main_score: Number(json.main_score ?? json.score ?? 0), subscores: subs, suggestion: String(json.suggestion ?? ''), request_id: String(json.request_id ?? ''), credits: creditInfo(json, headers) }
  }

  async titleText(o: { prompt?: string; support_image_url?: string; support_image_base64?: string }): Promise<TitleOut> {
    const { json, headers } = await this.postImages('/v2/title/text', strip(o))
    const outputs = Array.isArray(json.outputs) ? (json.outputs as unknown[]).map(String) : typeof json.output === 'string' ? [json.output] : []
    return { outputs, reasoning: String(json.reasoning ?? ''), prompt_compacted: String(json.prompt_compacted ?? ''), request_id: String(json.request_id ?? ''), credits: creditInfo(json, headers) }
  }

  /**
   * Train a persona/style. If Pikzels rejects the name (a validation error, no
   * credits spent) the next of `nameCandidates` is tried; `name` in the result
   * is the one it accepted.
   */
  async createPikzonality(kind: 'persona' | 'style', name: string, images: { urls?: string[]; base64s?: string[] }): Promise<{ id: string; credits: CreditInfo; name: string }> {
    const imgs = images.urls?.length ? images.urls : (images.base64s ?? [])
    if (imgs.length !== 3) throw new PikzelsError(400, `Pikzels needs exactly 3 images to train a ${kind} (got ${imgs.length}).`)
    const tries = nameCandidates(name)
    for (let i = 0; ; i++) {
      const body: Record<string, unknown> = { name: tries[i], ...(images.urls?.length ? { image_urls: images.urls } : { image_base64s: images.base64s }) }
      try {
        const { json, headers } = await this.postImages(`/v2/pikzonality/${kind}`, body)
        const id = String(json.id ?? json.pikzonality_id ?? (json.data as { id?: string } | undefined)?.id ?? '')
        if (!id) throw new PikzelsError(200, `Pikzels accepted the ${kind} but returned no id`)
        return { id, credits: creditInfo(json, headers), name: tries[i] }
      } catch (err) {
        const badName = err instanceof PikzelsError && (err.status === 400 || err.status === 422) && err.fields.includes('name')
        if (!badName) throw err
        if (i + 1 >= tries.length)
          throw new PikzelsError(err.status, `Pikzels didn’t accept the name “${name}” (shorter versions were tried too). Use a short name — letters, numbers and spaces, about 20 characters or fewer.`, err.fields)
      }
    }
  }

  /**
   * Is the key accepted? One GET for a persona id that can't exist — free (no
   * generation), no retries. 401/403 = rejected; any other HTTP answer (404 for
   * the made-up id) means Pikzels authenticated the request.
   */
  async checkKey(): Promise<KeyCheck> {
    let resp: Response
    try {
      resp = await this.fetchFn(`${this.base}/v2/pikzonality/00000000-0000-0000-0000-000000000000`, {
        method: 'GET',
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })
    } catch (err) {
      return { state: 'unreachable', status: 0, message: `Couldn’t reach Pikzels: ${err instanceof Error ? err.message : String(err)}` }
    }
    const text = await resp.text().catch(() => '')
    if (resp.status === 401 || resp.status === 403) return { state: 'rejected', status: resp.status, message: errorMessage(resp.status, text) }
    if (resp.status === 429) return { state: 'ok', status: resp.status, message: 'Pikzels accepted the key (it’s rate-limiting right now — wait a moment before generating).' }
    if (resp.status >= 500) return { state: 'unreachable', status: resp.status, message: `Pikzels is having trouble right now (HTTP ${resp.status}) — try again in a minute.` }
    return { state: 'ok', status: resp.status, message: 'Pikzels accepted the key.' }
  }

  async getPikzonality(id: string): Promise<PikzonalityStatus> {
    const { json } = await this.call('GET', `/v2/pikzonality/${encodeURIComponent(id)}`)
    const status = String(json.status ?? '').toLowerCase()
    return {
      id,
      status: status === 'completed' || status === 'ready' || status === 'succeeded' ? 'completed' : status === 'failed' || status === 'error' ? 'failed' : 'processing',
      progress: Math.max(0, Math.min(100, Number(json.progress ?? 0) || 0)),
      name: typeof json.name === 'string' ? json.name : undefined,
      type: typeof json.type === 'string' ? json.type : undefined,
      error: typeof json.error === 'string' ? json.error : typeof json.message === 'string' && status === 'failed' ? json.message : undefined,
      raw: json
    }
  }

  async patchPikzonality(id: string, special_instructions: string): Promise<void> {
    await this.call('PATCH', `/v2/pikzonality/${encodeURIComponent(id)}`, { special_instructions })
  }

  async deletePikzonality(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/v2/pikzonality/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof PikzelsError && err.status === 404) return
      throw err
    }
  }
}

/** drop undefined / empty-string keys so the API only sees what we mean */
function strip<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v
  return out
}

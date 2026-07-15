import axios from 'axios'
import { spawn, spawnSync } from 'child_process'
import { configStore } from './config-persistence'
import { logger } from './logger'
import { MODEL_VRAM, type AppConfig } from '../../shared/config'
import type {
  OllamaModelInfo,
  OllamaStatus,
  Role
} from '../../shared/types'

interface OllamaTagsResponse {
  models: { name: string; size: number }[]
}
interface OllamaPsResponse {
  models: { name?: string; model?: string; size_vram?: number; size?: number }[]
}

/**
 * Manages the local Ollama service: lifecycle (auto-start), model inventory,
 * loading models into memory, pulling missing models (with streamed progress),
 * and streaming chat completions.
 */
export class OllamaService {
  private activePulls = new Map<string, AbortController>()

  private get endpoint(): string {
    return configStore.load().ollamaEndpoint.replace(/\/$/, '')
  }

  /**
   * keep_alive value for requests: the configured inactivity timeout (seconds)
   * when the "Local LLM timeout" setting is on, otherwise -1 which tells Ollama
   * to keep the model resident until it is explicitly unloaded.
   */
  private keepAlive(): number {
    const cfg = configStore.load()
    return cfg.llmTimeoutEnabled ? Math.max(0, cfg.llmKeepAliveSeconds) : -1
  }

  async status(): Promise<OllamaStatus> {
    const endpoint = this.endpoint
    try {
      const [tags, ps] = await Promise.all([
        axios.get<OllamaTagsResponse>(`${endpoint}/api/tags`, {
          timeout: 3000
        }),
        axios
          .get<OllamaPsResponse>(`${endpoint}/api/ps`, { timeout: 5000 })
          .catch((e) => {
            logger.warn('/api/ps failed', errMessage(e))
            return { data: { models: [] } as OllamaPsResponse }
          })
      ])
      // /api/ps names the running model under either `name` or `model` across
      // Ollama versions — accept both so loaded-state detection is reliable.
      const psModels = ps.data.models ?? []
      const loadedNames = new Set(
        psModels
          .map((m) => m.model ?? m.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0)
      )
      const models: OllamaModelInfo[] = tags.data.models.map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        loaded: loadedNames.has(m.name)
      }))
      // Sum of VRAM actually occupied by loaded models (size_vram from /api/ps).
      const vramInUseBytes = psModels.reduce(
        (sum, m) => sum + (m.size_vram ?? m.size ?? 0),
        0
      )
      return {
        connected: true,
        endpoint,
        models,
        vramInUseGb: Math.round((vramInUseBytes / 1024 ** 3) * 10) / 10,
        loadedModels: [...loadedNames]
      }
    } catch (err) {
      return {
        connected: false,
        endpoint,
        error: errMessage(err),
        models: [],
        vramInUseGb: 0,
        loadedModels: []
      }
    }
  }

  /** Whether the `ollama` binary is resolvable on PATH. */
  isInstalled(): boolean {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which'
      const res = spawnSync(finder, ['ollama'], { windowsHide: true })
      return res.status === 0
    } catch {
      return false
    }
  }

  /**
   * Attempt to start the local `ollama serve` process if it is not reachable.
   * On Windows the `ollama` binary is expected on PATH (installed separately).
   * If Ollama is not installed this returns a friendly status instead of
   * throwing — the ENOENT from spawn arrives asynchronously as an 'error'
   * event, so it must be handled on the child (not just via try/catch) or it
   * becomes an uncaught exception that crashes the main process.
   */
  async start(): Promise<OllamaStatus> {
    const current = await this.status()
    if (current.connected) return current
    if (!this.isInstalled()) {
      return {
        connected: false,
        endpoint: this.endpoint,
        error: 'Ollama is not installed. Install it to use local models.',
        models: [],
        vramInUseGb: 0,
        loadedModels: []
      }
    }
    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      // Must handle the async 'error' event (e.g. ENOENT) or Node turns it into
      // an uncaught exception.
      child.on('error', (err) => {
        logger.error('ollama serve process error', errMessage(err))
      })
      child.unref()
      logger.info('Spawned `ollama serve`')
    } catch (err) {
      logger.error('Failed to spawn ollama serve', err)
      return {
        connected: false,
        endpoint: this.endpoint,
        error:
          'Could not launch Ollama. Ensure it is installed and on PATH. ' +
          errMessage(err),
        models: [],
        vramInUseGb: 0,
        loadedModels: []
      }
    }
    // Poll for readiness up to ~10s.
    for (let i = 0; i < 20; i++) {
      await delay(500)
      const s = await this.status()
      if (s.connected) return s
    }
    return this.status()
  }

  /** Load a model into memory by issuing an empty generate request. */
  async loadModel(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await axios.post(
        `${this.endpoint}/api/generate`,
        { model: name, prompt: '', stream: false, keep_alive: this.keepAlive() },
        { timeout: 120000 }
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
  }

  /** Unload a model from memory (frees VRAM) via keep_alive: 0. */
  async unloadModel(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await axios.post(
        `${this.endpoint}/api/generate`,
        { model: name, keep_alive: 0 },
        { timeout: 15000 }
      )
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
  }

  /** Pull a model, streaming progress to `onProgress`. Cancellable. */
  async pullModel(
    name: string,
    onProgress: (status: string, percent: number) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController()
    this.activePulls.set(name, controller)
    try {
      const res = await axios.post(
        `${this.endpoint}/api/pull`,
        { model: name, stream: true },
        { responseType: 'stream', signal: controller.signal }
      )
      await new Promise<void>((resolve, reject) => {
        let buffer = ''
        res.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const obj = JSON.parse(line) as {
                status?: string
                total?: number
                completed?: number
                error?: string
              }
              if (obj.error) {
                reject(new Error(obj.error))
                return
              }
              const percent =
                obj.total && obj.completed
                  ? Math.round((obj.completed / obj.total) * 100)
                  : 0
              onProgress(obj.status ?? 'pulling', percent)
            } catch {
              // ignore partial JSON lines
            }
          }
        })
        res.data.on('end', () => resolve())
        res.data.on('error', (e: Error) => reject(e))
      })
      return { ok: true }
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: 'cancelled' }
      return { ok: false, error: errMessage(err) }
    } finally {
      this.activePulls.delete(name)
    }
  }

  cancelPull(name: string): void {
    this.activePulls.get(name)?.abort()
    this.activePulls.delete(name)
  }

  /**
   * Stream a chat completion. `onToken` fires per token; resolves with the
   * full text. Abort via the provided AbortSignal.
   */
  async streamChat(
    model: string,
    messages: { role: Role; content: string }[],
    opts: { temperature: number; maxTokens: number; signal: AbortSignal },
    onToken: (t: string) => void
  ): Promise<string> {
    const res = await axios.post(
      `${this.endpoint}/api/chat`,
      {
        model,
        messages,
        stream: true,
        keep_alive: this.keepAlive(),
        options: {
          temperature: opts.temperature,
          num_predict: opts.maxTokens
        }
      },
      { responseType: 'stream', signal: opts.signal }
    )
    let full = ''
    let buffer = ''
    await new Promise<void>((resolve, reject) => {
      res.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as {
              message?: { content?: string }
              done?: boolean
            }
            const token = obj.message?.content ?? ''
            if (token) {
              full += token
              onToken(token)
            }
          } catch {
            // ignore partial JSON
          }
        }
      })
      res.data.on('end', () => resolve())
      res.data.on('error', (e: Error) => reject(e))
    })
    return full
  }
}

/**
 * Estimate VRAM (GB) for an Ollama model. Priority:
 *  1. An explicit user override in customModels.
 *  2. The model's actual on-disk size from Ollama (bytes) — the weight size
 *     closely tracks real VRAM use and is accurate for ANY model, so this is
 *     preferred over guesses whenever Ollama reports a size.
 *  3. A hardcoded fallback table (only if size is unavailable).
 */
export function vramForModel(
  name: string,
  cfg: AppConfig,
  sizeBytes?: number
): number | null {
  const custom = cfg.customModels.find((m) => m.name === name)
  if (custom) return custom.vramGb
  if (sizeBytes && sizeBytes > 0) {
    return Math.round((sizeBytes / 1024 ** 3) * 10) / 10
  }
  if (MODEL_VRAM[name] != null) return MODEL_VRAM[name]
  const base = name.replace(/:latest$/, '')
  if (MODEL_VRAM[base] != null) return MODEL_VRAM[base]
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function errMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNREFUSED') return 'Ollama is not running.'
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export const ollamaService = new OllamaService()

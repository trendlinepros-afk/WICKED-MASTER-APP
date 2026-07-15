import { configStore } from './config-persistence'
import { ollamaService } from './ollama'
import { apiProviderService, priceFor } from './api-providers'
import { parseModelId } from './models'
import { logger } from './logger'
import type {
  ChatRequest,
  ChatStreamEvent,
  CostEstimate
} from '../../shared/types'
import type { ProviderId } from '../../shared/config'

/**
 * Routes a chat request to the appropriate backend (Ollama vs cloud provider),
 * streams tokens back via `emit`, and tracks in-flight requests so they can be
 * stopped mid-generation.
 */
export class ChatOrchestrator {
  private inFlight = new Map<string, AbortController>()
  private counter = 0

  newRequestId(): string {
    this.counter += 1
    return `req-${Date.now()}-${this.counter}`
  }

  async run(
    requestId: string,
    req: ChatRequest,
    emit: (e: ChatStreamEvent) => void
  ): Promise<void> {
    const controller = new AbortController()
    this.inFlight.set(requestId, controller)
    const { provider, model } = parseModelId(req.modelId)
    const onToken = (token: string): void =>
      emit({ type: 'token', requestId, token })

    try {
      let content: string
      if (provider === 'ollama') {
        content = await ollamaService.streamChat(
          model,
          req.messages,
          {
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            signal: controller.signal
          },
          onToken
        )
      } else {
        content = await apiProviderService.streamChat(
          provider as ProviderId,
          model,
          req.messages,
          {
            temperature: req.temperature,
            maxTokens: req.maxTokens,
            signal: controller.signal
          },
          onToken
        )
      }
      emit({ type: 'done', requestId, content })
    } catch (err) {
      if (controller.signal.aborted) {
        // Deliver whatever streamed so far as a graceful stop.
        emit({ type: 'done', requestId, content: '' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('Chat request failed', req.modelId, message)
        emit({ type: 'error', requestId, error: message })
      }
    } finally {
      this.inFlight.delete(requestId)
    }
  }

  stop(requestId: string): void {
    this.inFlight.get(requestId)?.abort()
  }

  /** Estimate token usage and cost for a request (local models are free). */
  estimateCost(req: ChatRequest): CostEstimate {
    const { provider, model } = parseModelId(req.modelId)
    const inputText = req.messages.map((m) => m.content).join('\n')
    const inputTokens = apiProviderService.estimateTokens(inputText)
    if (provider === 'ollama') {
      return {
        modelId: req.modelId,
        isLocal: true,
        inputTokens,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0
      }
    }
    const estimatedOutputTokens = configStore.load().maxTokens
    const price = priceFor(model)
    const cost =
      (inputTokens / 1000) * price.inputPer1k +
      (estimatedOutputTokens / 1000) * price.outputPer1k
    return {
      modelId: req.modelId,
      isLocal: false,
      inputTokens,
      estimatedOutputTokens,
      estimatedCostUsd: Math.round(cost * 10000) / 10000
    }
  }
}

export const chatOrchestrator = new ChatOrchestrator()

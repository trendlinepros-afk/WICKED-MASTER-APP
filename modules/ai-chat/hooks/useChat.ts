import { useCallback, useState } from 'react';
import type { Message, Provider, Settings } from '../types';
import { api, onStreamToken } from '../lib/bridge';
import { useStreamStore, beginStream, endStream, abortCurrentStream } from '../store/streamStore';

// Port note: the actual provider calls (OpenAI/DeepSeek/Ollama streaming,
// Gemini streaming, the MCP tool loop, image generation and non-streaming
// completions) moved to the MAIN process (ipc/providers.ts) so API keys never
// reach the renderer. This hook is now a thin IPC client: it starts a stream
// with a requestId, mirrors cumulative text pushed on `ai-chat:stream-token`,
// and resolves with the final text. Abort maps to `ai-chat:chat-abort`.

export interface SendOptions {
  provider: Provider;
  modelVersion: string;
  settings: Settings;
  // Full assembled history: brain context + linked context + chat history + new user message.
  messages: Message[];
  onToken: (full: string) => void;
  signal?: AbortSignal;
}

export function useChat() {
  const [error, setError] = useState<string | null>(null);
  // Streaming state + abort live in a shared store so the input box and
  // per-message regenerate/edit all reflect the same in-flight request.
  const isStreaming = useStreamStore((s) => s.isStreaming);

  const stop = useCallback(() => {
    abortCurrentStream();
  }, []);

  const sendMessage = useCallback(async (opts: SendOptions): Promise<string> => {
    setError(null);
    const controller = beginStream();
    const requestId = crypto.randomUUID();

    // Relay cumulative stream text for this request into the caller's buffer.
    const unsubscribe = onStreamToken((e) => {
      if (e.requestId === requestId) opts.onToken(e.text);
    });
    // The renderer-side abort (Stop button / a new send superseding this one)
    // tells the main process to cancel the provider request.
    const onAbort = () => void api.chatAbort(requestId).catch(() => {});
    controller.signal.addEventListener('abort', onAbort);

    try {
      const full = await api.chatStream(requestId, {
        provider: opts.provider,
        modelVersion: opts.modelVersion,
        messages: opts.messages,
      });
      opts.onToken(full);
      return full;
    } catch (err) {
      const message = (err as Error).message || 'Request failed';
      setError(message);
      throw err;
    } finally {
      unsubscribe();
      controller.signal.removeEventListener('abort', onAbort);
      endStream(controller);
    }
  }, []);

  return { sendMessage, stop, isStreaming, error };
}

// Lightweight non-streaming completion for summaries / category / idea
// detection. Runs in the main process; `settings` is kept for call-site
// compatibility (keys and the Ollama URL are resolved there).
export async function completeText(
  provider: Provider,
  modelVersion: string,
  _settings: Settings,
  prompt: string
): Promise<string> {
  return api.completeText(provider, modelVersion, prompt);
}

// Discover an image-capable model on the user's Gemini key and generate.
// Returns the data URL and the model that actually worked.
export async function generateImage(
  preferredModel: string,
  prompt: string
): Promise<{ url: string; model: string }> {
  return api.generateImage(preferredModel, prompt);
}

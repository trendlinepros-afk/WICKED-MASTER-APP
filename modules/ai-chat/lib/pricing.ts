import type { Message, Provider } from '../types';

// Rough USD price per 1M tokens (input/output). Used only for a local estimate;
// providers bill exactly, this is a ballpark to keep an eye on spend.
const PRICES: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4-turbo': { in: 10, out: 30 },
  o1: { in: 15, out: 60 },
  'o1-mini': { in: 1.1, out: 4.4 },
  'gpt-3.5-turbo': { in: 0.5, out: 1.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};

// ~4 characters per token is a decent cross-model approximation.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const TOKENS_PER_IMAGE = 85; // rough flat cost for a vision image part

function messageTokens(m: Message): number {
  let tokens = 0;
  for (const p of m.content) {
    if (p.type === 'image_url') tokens += TOKENS_PER_IMAGE;
    else if (p.text) tokens += estimateTokens(p.text);
  }
  return tokens;
}

export interface UsageEstimate {
  tokens: number;
  cost: number; // USD (0 for local)
  local: boolean; // true for Ollama
  priced: boolean; // false when we have no price for this model
}

// Estimate cumulative usage for a chat's messages under a given model.
export function estimateUsage(
  messages: Message[],
  provider: Provider,
  modelVersion: string
): UsageEstimate {
  let inTokens = 0;
  let outTokens = 0;
  for (const m of messages) {
    if (m.role === 'assistant') outTokens += messageTokens(m);
    else inTokens += messageTokens(m);
  }
  const tokens = inTokens + outTokens;
  if (provider === 'ollama') return { tokens, cost: 0, local: true, priced: true };
  const price = PRICES[modelVersion];
  if (!price) return { tokens, cost: 0, local: false, priced: false };
  const cost = (inTokens / 1_000_000) * price.in + (outTokens / 1_000_000) * price.out;
  return { tokens, cost, local: false, priced: true };
}

export function formatCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

// Retry a thunk on transient errors (HTTP 429 / 5xx / network) with exponential
// backoff. Non-transient errors (e.g. 400/401) throw immediately.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; onRetry?: (attempt: number, delayMs: number) => void } = {}
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
      const delay = baseMs * 2 ** attempt + Math.floor(((attempt * 137) % 250));
      opts.onRetry?.(attempt + 1, delay);
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

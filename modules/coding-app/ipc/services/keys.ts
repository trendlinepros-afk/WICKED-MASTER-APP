/**
 * Access to the WICKED shell's central API key vault from module services.
 *
 * The vault getter (`ctx.getApiKey`) is only available inside `register(ctx)`,
 * but the provider/chat/analyzer services are plain singletons — so ipc.ts
 * hands the getter to this tiny holder at registration time and services read
 * keys at call time via `getApiKey(provider)`. Key values stay in the main
 * process; they are never forwarded to the renderer.
 */

type KeyResolver = (provider: string) => string | null

let resolver: KeyResolver | null = null

export function initKeyResolver(fn: KeyResolver): void {
  resolver = fn
}

/** Decrypted key for a provider ('' when unset or before registration). */
export function getApiKey(provider: string): string {
  return resolver?.(provider)?.trim() ?? ''
}

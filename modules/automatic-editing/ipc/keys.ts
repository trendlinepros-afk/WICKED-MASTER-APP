/**
 * Bridge to the WICKED central API key vault (Settings → API Keys).
 *
 * The standalone app kept its own safeStorage-encrypted secrets.json; in the
 * WICKED suite provider keys live in the shell vault and module main-process
 * code reads them at call time via ctx.getApiKey. register() injects the
 * getter here so the rest of the pipeline code stays decoupled from the
 * ModuleIpcContext. Key values NEVER cross to the renderer — only presence
 * booleans (computed in settings.ts) do.
 *
 * Vault provider ids map 1:1 onto the app's secret names:
 * gemini, openai, deepseek, anthropic, opusclip, s3-access, s3-secret.
 */
import type { SecretName } from '../shared/types'

let getKey: (provider: string) => string | null = () => null

export function setApiKeyGetter(fn: (provider: string) => string | null): void {
  getKey = fn
}

/** Decrypted key from the shell vault, or null when unset. */
export function getSecret(name: SecretName): string | null {
  return getKey(name)
}

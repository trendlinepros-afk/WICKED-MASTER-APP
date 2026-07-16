import type { ConfirmationWithhold, CredentialWithhold } from '@shared/mcp'

/**
 * Shared MCP safety gates. Every module's mcp.ts uses these (via the module
 * context) so the confirmation and credential flows are identical everywhere
 * instead of each module inventing its own.
 */

/**
 * Destructive-action gate. Returns a confirmation object to hand back to the
 * agent unless the caller re-invoked with `confirm: true`.
 */
export function requiresConfirmation(
  confirm: boolean | undefined,
  summary: string
): ConfirmationWithhold | null {
  if (confirm === true) return null
  return {
    status: 'confirmation-required',
    summary,
    hint: 'To execute, call this tool again with the same arguments plus "confirm": true.'
  }
}

/**
 * Credential gate. Returns a withhold naming (never echoing) the credential
 * unless the caller supplied a non-empty value in this call. Stored vault
 * secrets are deliberately NOT consulted here — MCP tool calls must never
 * silently use a stored credential and proceed.
 */
export function requiresCredential(
  name: string,
  provided: string | undefined
): CredentialWithhold | null {
  if (typeof provided === 'string' && provided.trim().length > 0) return null
  return {
    status: 'credential-required',
    credential: name,
    message:
      `This action requires the ${name}. Provide it explicitly in the tool call to proceed. ` +
      'Stored credentials are not used automatically for MCP tool calls.'
  }
}

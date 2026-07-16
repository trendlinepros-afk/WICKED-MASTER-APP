import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for MFA TOOL. Each tool delegates to the SAME main-process channel
 * the module UI calls (see ipc.ts) — no logic is duplicated here.
 *
 * Only READ-ONLY, secret-free operations are exposed:
 *  - `vault-status`   -> mfa-tool:status          (existence/paths, no secrets)
 *  - `self-test`      -> mfa-tool:self-test-vault (encryption round-trip on a
 *                                                  throwaway temp vault)
 *
 * DELIBERATELY OMITTED — unlock / create / save / import-legacy. Those channels
 * require the master passphrase and read or write TOTP secrets. Neither the
 * passphrase nor the decrypted secrets should ever flow through the MCP boundary
 * (they would be echoed back to, and logged by, an MCP client). If an unlock tool
 * were ever added it would have to gate on
 *   ctx.credential('the MFA vault passphrase', args.passphrase)
 * and never echo the passphrase or the returned accounts — but the safer choice
 * is to keep secret handling entirely inside the app UI, so it is omitted here.
 *
 * Note: the RFC 6238 TOTP verification portion of the self-test runs renderer-side
 * (lib/selftest.ts) and is not reachable over IPC; the main-process channel below
 * exercises the vault's AES-256-GCM encrypt/decrypt round-trip.
 */
const ID = 'mfa-tool'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__vault-status`,
      description:
        'Report whether the MFA vault exists (and whether a legacy Python-tool vault exists) plus ' +
        'their file paths. Never unlocks the vault or returns any secret. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__self-test`,
      description:
        'Run the vault self-test: encrypt then decrypt a throwaway temp vault to prove ' +
        'AES-256-GCM save/load works and that a wrong password is rejected. Uses fixed test data, ' +
        'touches no real vault, and returns no user secrets. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:self-test-vault`)
    }
  ]
}

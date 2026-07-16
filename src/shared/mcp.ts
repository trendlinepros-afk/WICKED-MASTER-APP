import type { ZodRawShape } from 'zod'

/**
 * WICKED MCP contract — the shape every module's mcp.ts produces, and the
 * context the shell hands it. See modules/README.md for the authoring rules.
 */

/** Result returned when a destructive tool needs a second, confirming call. */
export interface ConfirmationWithhold {
  status: 'confirmation-required'
  /** exactly what will happen if confirmed (files/settings/systems affected) */
  summary: string
  hint: string
}

/** Result returned when a tool needs a credential the caller hasn't supplied. */
export interface CredentialWithhold {
  status: 'credential-required'
  /** the NAME of the credential needed — never its value */
  credential: string
  message: string
}

/** Context passed to each module's mcp.ts register() function. */
export interface McpModuleContext {
  /** this module's id (e.g. "robocopy-gui") */
  moduleId: string
  /**
   * Call the SAME main-process handler the UI button calls. `channel` is the
   * module's own IPC channel (`<module-id>:<action>`). This is how MCP tools
   * reuse existing logic instead of duplicating it.
   */
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  /** Whether a central-vault key is set (presence only — never the value). */
  hasApiKey: (provider: string) => boolean
  /**
   * Destructive-action gate. Returns a ConfirmationWithhold to return to the
   * caller when `confirm` is not true; returns null when it is safe to proceed.
   * Every destructive tool MUST route through this.
   */
  confirm: (confirm: boolean | undefined, summary: string) => ConfirmationWithhold | null
  /**
   * Credential gate. Returns a CredentialWithhold (naming, never echoing, the
   * credential) unless the caller supplied a non-empty `provided` value in this
   * call. MCP tools MUST NOT auto-use vault secrets — pass the caller-supplied
   * value here and thread it into the operation.
   */
  credential: (name: string, provided: string | undefined) => CredentialWithhold | null
}

/** One MCP tool exported by a module. */
export interface McpToolDef {
  /** MUST be `<module-id>__<action>` (double underscore) to avoid collisions. */
  name: string
  /** Clear enough that an agent knows what it does and what it needs. */
  description: string
  /**
   * Zod raw shape for the tool's inputs. This is the schema the agent sees; the
   * authoritative business validation stays in the delegated IPC handler (do not
   * build a second validation path — shape here, delegate for the rest).
   */
  inputSchema: ZodRawShape
  /** True if the tool performs an irreversible/destructive action. */
  destructive?: boolean
  /** Handler: return a withhold object, or the tool result. */
  handler: (args: Record<string, unknown>, ctx: McpModuleContext) => Promise<unknown> | unknown
}

export type McpRegister = (ctx: McpModuleContext) => McpToolDef[]

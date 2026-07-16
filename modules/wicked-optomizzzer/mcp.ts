import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for WICKED OPTOMIZZZER. Each tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no launch logic is duplicated here.
 *
 * `launch` is marked destructive: the native optimizer's manifest requests
 * administrator rights, so ShellExecute raises a UAC prompt and the tool then
 * modifies system settings. The user should consciously confirm before an agent
 * opens an elevated system-modification tool, hence the shared confirmation gate.
 */
const ID = 'wicked-optomizzzer'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report the resolved WickedOptimizer.exe path and whether that file exists on disk. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__launch`,
      description:
        'Launch the native Wicked Optimizer. It requests administrator rights (a Windows UAC ' +
        'prompt appears) and then opens a system-modification tool — destructive. WICKED itself ' +
        'stays unelevated; only this launched process is elevated.',
      destructive: true,
      inputSchema: {
        confirm: z.boolean().optional().describe('Set true to actually launch (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Launch the native Wicked Optimizer. It elevates via a Windows UAC prompt and opens an ' +
            'admin system-optimization tool that can change system settings.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:launch`)
      }
    }
  ]
}

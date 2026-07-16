import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for WICKED OPTOMIZZZER. Every tool delegates to the SAME main-process
 * channel the module UI calls (see ipc.ts) — no logic is duplicated here.
 *
 * Read tools (dashboard / scans / listings) run unelevated and are non-destructive.
 * System-changing tools (clean, service change, startup toggle, uninstall, apply
 * updates) fire a Windows UAC prompt for that one action and are gated through the
 * shared confirmation gate. WICKED itself never runs elevated.
 */
const ID = 'wicked-optomizzzer'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    /* ------------------------------ read tools ----------------------------- */
    {
      name: `${ID}__dashboard`,
      description:
        'Report live system status: CPU load %, memory used/total, uptime, OS name and fixed-disk usage. Read-only, unelevated.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:dashboard`)
    },
    {
      name: `${ID}__clean-scan`,
      description:
        'Scan cleanup categories (temp files, prefetch, Windows Update cache, recycle bin, caches, crash dumps, thumbnails) and report the reclaimable size and file count of each. Read-only, changes nothing.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:clean-scan`)
    },
    {
      name: `${ID}__list-services`,
      description:
        'List Windows services with display name, state (Running/Stopped), start mode, account and whether each is a protected core service. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-services`)
    },
    {
      name: `${ID}__list-startup`,
      description:
        'List startup entries (registry Run keys + startup folders) with command, scope, source and enabled state. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-startup`)
    },
    {
      name: `${ID}__list-apps`,
      description:
        'List installed applications from the registry uninstall keys with version, publisher, size and uninstall command. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-apps`)
    },
    {
      name: `${ID}__list-updates`,
      description:
        'List available application upgrades via `winget upgrade` (name, id, current version, available version). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:list-updates`)
    },

    /* --------------------------- destructive tools ------------------------- */
    {
      name: `${ID}__clean`,
      description:
        'Permanently delete files in the given cleanup categories (and empty the recycle bin if selected). Elevated: a Windows UAC prompt appears for this action. Destructive — deleted files are not recoverable. Category keys come from clean-scan (e.g. recyclebin, usertemp, wintemp, prefetch, wupdate, inetcache, crashdumps, thumbs).',
      destructive: true,
      inputSchema: {
        keys: z.array(z.string()).describe('Category keys to clean, from clean-scan.'),
        confirm: z.boolean().optional().describe('Set true to actually clean (see confirmation).')
      },
      handler: (args) => {
        const keys = Array.isArray(args.keys) ? (args.keys as string[]) : []
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Permanently delete files in these cleanup categories: ${keys.join(', ') || '(none)'}. ` +
            'This empties the recycle bin if selected and cannot be undone. Fires a UAC prompt.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:clean`, keys)
      }
    },
    {
      name: `${ID}__set-service`,
      description:
        'Change a Windows service start type and/or stop it. Elevated (sc.exe config / Stop-Service) — fires a UAC prompt. Destructive: can disable services the system relies on. Protected core services are rejected. Use startType "auto" | "demand" | "disabled".',
      destructive: true,
      inputSchema: {
        name: z.string().describe('Service short name (from list-services).'),
        startType: z
          .enum(['auto', 'demand', 'disabled', ''])
          .optional()
          .describe('New start type, or "" to leave unchanged.'),
        stop: z.boolean().optional().describe('Also stop the service now.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const name = String(args.name ?? '')
        const startType = String(args.startType ?? '')
        const stop = args.stop === true
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Change service "${name}"${startType ? ` — start type "${startType}"` : ''}${stop ? ' and stop it now' : ''}. ` +
            'Elevated system change; fires a UAC prompt.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:set-service`, { name, startType, stop })
      }
    },
    {
      name: `${ID}__set-startup`,
      description:
        'Enable or disable a startup entry by writing the Explorer StartupApproved flag. Elevated — fires a UAC prompt. Provide the entry fields from list-startup.',
      destructive: true,
      inputSchema: {
        scope: z.enum(['Machine', 'User']).describe('Entry scope (from list-startup).'),
        approvedSubkey: z.string().describe('approvedSubkey from list-startup (e.g. "Run" or "StartupFolder").'),
        approvedValueName: z.string().describe('approvedValueName from list-startup.'),
        enabled: z.boolean().describe('true = enable, false = disable.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `${args.enabled ? 'Enable' : 'Disable'} startup entry "${String(args.approvedValueName ?? '')}" ` +
            `(${String(args.scope ?? '')}). Elevated change; fires a UAC prompt.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:set-startup`, {
          scope: args.scope,
          approvedSubkey: args.approvedSubkey,
          approvedValueName: args.approvedValueName,
          enabled: args.enabled
        })
      }
    },
    {
      name: `${ID}__uninstall-app`,
      description:
        "Uninstall an application by running its registered uninstaller (msiexec /x for MSI products). Elevated — fires a UAC prompt. Destructive: removes the app. Pass the app's uninstall strings from list-apps.",
      destructive: true,
      inputSchema: {
        name: z.string().describe('App display name (from list-apps).'),
        uninstallString: z.string().optional().describe('UninstallString from list-apps.'),
        quietUninstallString: z.string().optional().describe('QuietUninstallString from list-apps (preferred).'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Uninstall "${String(args.name ?? 'this app')}". Elevated action; fires a UAC prompt and removes the app.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:uninstall-app`, {
          name: args.name,
          uninstallString: args.uninstallString ?? '',
          quietUninstallString: args.quietUninstallString ?? ''
        })
      }
    },
    {
      name: `${ID}__apply-updates`,
      description:
        'Apply one winget upgrade by id, or all available upgrades when `all` is true. Elevated — fires a UAC prompt. Destructive: changes installed software versions.',
      destructive: true,
      inputSchema: {
        id: z.string().optional().describe('winget package id to upgrade (from list-updates). Omit to upgrade all.'),
        all: z.boolean().optional().describe('Set true to upgrade everything (winget upgrade --all).'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const id = String(args.id ?? '')
        const all = args.all === true || id === ''
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          all
            ? 'Apply ALL available winget upgrades. Elevated; fires a UAC prompt and changes installed software.'
            : `Upgrade "${id}" via winget. Elevated; fires a UAC prompt.`
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:apply-updates`, all ? { all: true } : { id })
      }
    }
  ]
}

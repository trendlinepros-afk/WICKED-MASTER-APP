import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for WEB BROWSER. Every tool delegates to the same main-process
 * channel the module UI calls (see ipc.ts) — nothing is duplicated here.
 *
 * "Full Chrome" is the user's real Google Chrome, launched with a dedicated
 * WICKED profile and a localhost-only DevTools automation port. Chrome
 * extensions (e.g. Claude in Chrome) and Chrome-sync bookmarks live THERE —
 * not in the embedded in-app browser — so automation tools target Full Chrome.
 */
const ID = 'web-browser'

const targetIdInput = z
  .string()
  .optional()
  .describe(
    'Tab to operate on, from web-browser__tabs. Omit to use the first open tab.'
  )

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description:
        'Report Full Chrome state: whether Chrome is installed (and where), whether the automated WICKED-profile Chrome is currently running, its DevTools port, profile directory and open tab count. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__launch-chrome`,
      description:
        'Launch Full Chrome (the user\'s real Chrome with the dedicated WICKED profile and localhost automation port) and wait until it is controllable. Opens a visible Chrome window on the user\'s desktop; if it is already running, just opens/raises a window there. Optionally pass a URL to open. The user\'s Chrome extensions and synced bookmarks work in this Chrome.',
      inputSchema: {
        url: z.string().optional().describe('Optional http(s):// URL to open on launch.')
      },
      handler: (args) => ctx.invoke(`${ID}:launch`, { url: args.url })
    },
    {
      name: `${ID}__tabs`,
      description:
        'List the open tabs in Full Chrome: targetId, title and URL for each. Read-only. Requires Full Chrome to be running (launch-chrome).',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:tabs`)
    },
    {
      name: `${ID}__open`,
      description:
        'Open a URL in a NEW Full Chrome tab. If Full Chrome is not running yet it is launched first (a visible Chrome window appears). Returns the new tab\'s targetId when available.',
      inputSchema: {
        url: z.string().describe('Full URL to open (http(s)://, about:, or chrome://).')
      },
      handler: (args) => ctx.invoke(`${ID}:open`, { url: args.url })
    },
    {
      name: `${ID}__navigate`,
      description:
        'Navigate an EXISTING Full Chrome tab to a URL (the tab\'s current page is replaced).',
      inputSchema: {
        url: z.string().describe('Full URL to navigate to (http(s)://, about:, or chrome://).'),
        targetId: targetIdInput
      },
      handler: (args) => ctx.invoke(`${ID}:navigate`, { url: args.url, targetId: args.targetId })
    },
    {
      name: `${ID}__page-content`,
      description:
        'Read a Full Chrome tab\'s current page: title, URL and its visible text (default) or full HTML. Read-only; long pages are truncated (the result says so).',
      inputSchema: {
        targetId: targetIdInput,
        format: z
          .enum(['text', 'html'])
          .optional()
          .describe('"text" (default) = visible text; "html" = full outerHTML.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:page`, { targetId: args.targetId, format: args.format })
    },
    {
      name: `${ID}__screenshot`,
      description:
        'Capture a PNG screenshot of a Full Chrome tab (the tab is brought to the front first) and save it under the module\'s screenshots folder. Returns the file path.',
      inputSchema: { targetId: targetIdInput },
      handler: (args) => ctx.invoke(`${ID}:screenshot`, { targetId: args.targetId })
    },
    {
      name: `${ID}__eval`,
      description:
        'Run arbitrary JavaScript in a Full Chrome tab and return its JSON result. DESTRUCTIVE: the script runs with full access to the page and the user\'s logged-in session there (it can click, submit forms, change account data), so it requires confirmation.',
      destructive: true,
      inputSchema: {
        expression: z.string().describe('JavaScript to evaluate in the page. Promises are awaited.'),
        targetId: targetIdInput,
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Run JavaScript inside a Full Chrome tab. The script acts as the user on that page (their cookies/logins) and its effects may not be undoable.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:eval`, { expression: args.expression, targetId: args.targetId })
      }
    },
    {
      name: `${ID}__activate-tab`,
      description: 'Bring a Full Chrome tab to the foreground.',
      inputSchema: {
        targetId: z.string().describe('Tab to activate, from web-browser__tabs.')
      },
      handler: (args) => ctx.invoke(`${ID}:activate-tab`, { targetId: args.targetId })
    },
    {
      name: `${ID}__close-tab`,
      description:
        'Close a Full Chrome tab. DESTRUCTIVE: any unsaved state in that tab (form input, in-progress work) is lost, so it requires confirmation.',
      destructive: true,
      inputSchema: {
        targetId: z.string().describe('Tab to close, from web-browser__tabs.'),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          'Close a Full Chrome tab. Unsaved page state in that tab will be lost.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:close-tab`, { targetId: args.targetId })
      }
    },
    {
      name: `${ID}__bookmarks`,
      description: 'List the in-app browser\'s saved bookmarks (title + URL). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:bookmarks-get`)
    },
    {
      name: `${ID}__bookmark-add`,
      description:
        'Save a bookmark in the in-app browser. (Full Chrome bookmarks are managed by Chrome sync, not here.) Trivially undone with bookmark-remove.',
      inputSchema: {
        url: z.string().describe('Full http(s):// URL to bookmark.'),
        title: z.string().optional().describe('Display title; defaults to the URL.')
      },
      handler: (args) => ctx.invoke(`${ID}:bookmark-add`, { url: args.url, title: args.title })
    },
    {
      name: `${ID}__bookmark-remove`,
      description:
        'Remove an in-app browser bookmark by exact URL. Trivially undone with bookmark-add.',
      inputSchema: { url: z.string().describe('Exact URL of the bookmark to remove.') },
      handler: (args) => ctx.invoke(`${ID}:bookmark-remove`, { url: args.url })
    },
    {
      name: `${ID}__open-in-app`,
      description:
        'Open a URL as a new tab in the EMBEDDED in-app browser (inside the WICKED window). Fire-and-forget: the tab appears when the Web Browser module is open there. For automation (read/screenshot/eval), prefer the Full Chrome tools.',
      inputSchema: { url: z.string().describe('Full http(s):// URL to open in the in-app browser.') },
      handler: (args) => ctx.invoke(`${ID}:ui-open`, { url: args.url })
    }
  ]
}

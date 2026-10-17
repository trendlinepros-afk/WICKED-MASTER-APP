import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for the Webpage Downloader — same channels as the UI (ipc.ts).
 * Saving only writes a new folder (never overwrites); deleting a saved copy
 * moves it to the Recycle Bin and is confirm-gated.
 */
const ID = 'page-downloader'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__save`,
      description:
        'Download a whole web page — text, images, styles, fonts, frames, as it looks after its scripts run — into a new folder (index.html + assets/, optionally screenshot.png and a single-file page.mhtml) in the save folder (Downloads by default). Opened in a hidden, private browser window with no cookies; returns the folder and file counts. Takes up to ~1–2 minutes for heavy pages.',
      inputSchema: {
        url: z.string().describe('The page address, e.g. https://example.com/page (https:// is added if missing).'),
        screenshot: z.boolean().optional().describe('Also save a full-page picture (default: the app setting, on).'),
        keepMhtml: z.boolean().optional().describe('Also keep the single-file .mhtml copy (default: the app setting, on).')
      },
      handler: (args) => ctx.invoke(`${ID}:save`, { url: args.url, screenshot: args.screenshot, keepMhtml: args.keepMhtml })
    },
    {
      name: `${ID}__saved-pages`,
      description: 'The pages saved so far (title, address, folder, when, size) and the save folder. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__delete`,
      description: 'Delete a saved page: its folder goes to the Recycle Bin and it leaves the list. Ids come from __saved-pages. Destructive. Requires confirmation.',
      destructive: true,
      inputSchema: { id: z.string(), confirm: z.boolean().optional() },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, 'Move this saved web page’s folder to the Recycle Bin and remove it from the list.')
        if (gate) return gate
        return ctx.invoke(`${ID}:delete`, { id: args.id })
      }
    }
  ]
}

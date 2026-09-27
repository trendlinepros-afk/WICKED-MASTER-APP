import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for THUMBNAIL GENERATOR. Each delegates to the same main-process
 * channel the UI uses (ipc.ts). Generating and training spend Pikzels credits,
 * so those go through the confirmation gate; the key comes from the vault.
 */
const ID = 'thumbnail-generator'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__library`,
      description: 'List trained personas (faces) and themes (visual styles) with ids and training status. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:library`)
    },
    {
      name: `${ID}__history`,
      description: 'Recent generations: prompt, model, format, saved file path, score. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:history`)
    },
    {
      name: `${ID}__settings`,
      description: 'Download folder and credit prices used for cost estimates. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:settings`)
    },
    {
      name: `${ID}__generate`,
      description:
        'Generate thumbnails with Pikzels and save them to the download folder. mode "text" uses the prompt; mode "image" recreates a YouTube watch link or image URL (optionally guided by the prompt). Personas/themes need model pkz_4 or pkz_4_5. Spends credits — requires confirm:true.',
      destructive: true,
      inputSchema: {
        mode: z.enum(['text', 'image']).optional(),
        prompt: z.string().optional(),
        imageUrl: z.string().optional().describe('YouTube watch link or image URL (image mode)'),
        model: z.enum(['pkz_2', 'pkz_3', 'pkz_4', 'pkz_4_5']).optional(),
        format: z.enum(['16:9', '9:16', '1:1']).optional(),
        count: z.number().int().min(1).max(10).optional(),
        personaId: z.string().optional(),
        styleId: z.string().optional(),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const count = Number(args.count ?? 1)
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Generate ${count} thumbnail(s) with Pikzels (${String(args.model ?? 'pkz_4_5')}) — this spends credits — and save them to the download folder.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:generate`, {
          mode: args.mode ?? (args.imageUrl ? 'image' : 'text'),
          prompt: args.prompt ?? '',
          model: args.model ?? 'pkz_4_5',
          format: args.format ?? '16:9',
          count,
          image: args.imageUrl ? { url: args.imageUrl, label: args.imageUrl } : undefined,
          personaId: args.personaId,
          styleId: args.styleId
        })
      }
    },
    {
      name: `${ID}__titles`,
      description: 'Suggest video titles from a topic (spends a few credits).',
      inputSchema: { prompt: z.string() },
      handler: (args) => ctx.invoke(`${ID}:titles`, { prompt: args.prompt })
    },
    {
      name: `${ID}__youtube-thumbnails`,
      description: 'List thumbnails of a YouTube channel or video (public pages, no credits) — e.g. to pick three for training a theme.',
      inputSchema: { url: z.string() },
      handler: (args) => ctx.invoke(`${ID}:youtube`, { url: args.url })
    },
    {
      name: `${ID}__train`,
      description: 'Train a persona (kind "persona", 3 face photos) or theme (kind "style", 3 thumbnails) from image URLs. Spends credits — requires confirm:true.',
      destructive: true,
      inputSchema: {
        kind: z.enum(['persona', 'style']),
        name: z.string(),
        imageUrls: z.array(z.string()).length(3),
        specialInstructions: z.string().optional(),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Train a Pikzels ${String(args.kind)} named "${String(args.name)}" from 3 images — this spends training credits.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:train`, { kind: args.kind, name: args.name, images: (args.imageUrls as string[]).map((url) => ({ url })), specialInstructions: args.specialInstructions })
      }
    }
  ]
}

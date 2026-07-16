import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for AI CHAT. Every tool delegates to the SAME main-process channel
 * the module UI calls (see shared/rpc.ts + ipc.ts) — no chat/vault/board logic
 * is duplicated here. `inputSchema` only describes the shape the agent sees; the
 * authoritative validation stays in the delegated IPC handler.
 *
 * This module exposes ~100 channels; this file CURATES a small, high-value,
 * safe subset. Deliberately NOT exposed (see the module README + report):
 *  - Provider-key-consuming calls other than send-message (image-generate,
 *    embed-text, voice-transcribe/speak, chat-completeText): they read the
 *    shell vault key with no caller-credential path, i.e. they would auto-use a
 *    vault secret on the MCP surface — forbidden by the module contract.
 *  - Settings / data-root / web-portal / MCP-server-config channels: they
 *    reconfigure the app or overwrite settings (config-overwrite surface).
 *  - Native desktop channels (file/vault dialogs, PDF/markdown export,
 *    openExternal, pb import): they need a focused desktop window, not an agent.
 *  - ComfyUI, FluxGym, portal, dataRoot internals: heavy local-service plumbing
 *    with no clean single-shot agent action.
 *  - Trash surface (getDeleted/restore/purge) and settings save: no meaningful
 *    read-only or safely-gated single action for an agent.
 *  - Ollama load/unload/model-list: these are done in the RENDERER via direct
 *    HTTP to the local Ollama server (lib/ollama.ts) — there is NO ai-chat IPC
 *    channel to delegate to, so they cannot be exposed here.
 */
const ID = 'ai-chat'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    // ---------- Chats (read) ----------
    {
      name: `${ID}__list-chats`,
      description: 'List all chats (id, title, folder, provider, model, timestamps). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:chats-getAll`)
    },
    {
      name: `${ID}__get-messages`,
      description:
        'Get every message (role + content parts) in a chat, oldest first. Read-only. Use list-chats to find the chat id.',
      inputSchema: {
        chatId: z.string().describe('Chat id from list-chats.')
      },
      handler: (args) => ctx.invoke(`${ID}:messages-getAll`, args.chatId)
    },

    // ---------- Chats (write) ----------
    {
      name: `${ID}__create-chat`,
      description:
        'Create a new empty chat bound to a provider + model. Returns the created chat (with its new id).',
      inputSchema: {
        provider: z
          .enum(['openai', 'gemini', 'deepseek', 'ollama'])
          .describe('Which provider this chat talks to.'),
        modelVersion: z.string().describe('Model id, e.g. "gpt-4o" or "gemini-2.5-pro".'),
        title: z.string().optional().describe('Chat title. Defaults to "New Chat".'),
        folderId: z
          .string()
          .nullable()
          .optional()
          .describe('Folder id to file it under (from list-folders); null/omit = uncategorized.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:chats-create`, {
          provider: args.provider,
          modelVersion: args.modelVersion,
          title: args.title,
          folderId: (args.folderId as string | null | undefined) ?? null
        })
    },
    {
      name: `${ID}__rename-chat`,
      description: 'Rename an existing chat.',
      inputSchema: {
        id: z.string().describe('Chat id from list-chats.'),
        title: z.string().describe('New title.')
      },
      handler: (args) => ctx.invoke(`${ID}:chats-updateTitle`, args.id, args.title)
    },
    {
      name: `${ID}__delete-chat`,
      description:
        'Delete a chat. This moves it to the trash (recoverable in the app), not a permanent purge. Destructive — requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Chat id from list-chats.'),
        confirm: z.boolean().optional().describe('Set true to actually delete (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Delete chat "${String(args.id)}" — it is moved to the trash and hidden from the chat list ` +
            '(recoverable from the app UI until purged).'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:chats-delete`, args.id)
      }
    },

    // ---------- Send message (cloud provider key required) ----------
    {
      name: `${ID}__send-message`,
      description:
        'Send a one-shot chat request to a CLOUD model (OpenAI / Anthropic / Gemini / DeepSeek) ' +
        'and return the assistant text. This does NOT persist to a saved chat — for a full ongoing ' +
        'conversation use the app UI. Local Ollama chat is not intended for this path — use the app UI ' +
        'for Ollama. Requires the selected provider API key: pass `credential` to proceed (the value ' +
        'is never stored or echoed; the module never auto-uses a vault secret on the MCP path).',
      inputSchema: {
        provider: z
          .enum(['openai', 'gemini', 'deepseek', 'ollama'])
          .describe('Provider to call. Cloud providers require `credential`.'),
        modelVersion: z.string().describe('Model id, e.g. "gpt-4o", "gemini-2.5-pro".'),
        messages: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant', 'system']),
              content: z
                .array(
                  z.object({
                    type: z.enum(['text', 'image_url', 'file']),
                    text: z.string().optional(),
                    image_url: z.object({ url: z.string() }).optional(),
                    name: z.string().optional(),
                    mime: z.string().optional(),
                    data: z.string().optional()
                  })
                )
                .describe('Content parts. For plain text use a single { type: "text", text } part.')
            })
          )
          .describe('Full conversation history to send (system + user/assistant turns).'),
        credential: z
          .string()
          .optional()
          .describe('The selected chat provider API key. Required to actually send.')
      },
      handler: (args) => {
        const cred = ctx.credential(
          'the selected chat provider API key',
          args.credential as string | undefined
        )
        if (cred) return cred
        const requestId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
        return ctx.invoke(`${ID}:chat-stream`, requestId, {
          provider: args.provider,
          modelVersion: args.modelVersion,
          messages: args.messages
        })
      }
    },

    // ---------- Folders ----------
    {
      name: `${ID}__list-folders`,
      description: 'List chat folders (id, name, parentId). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:folders-getAll`)
    },
    {
      name: `${ID}__delete-folder`,
      description:
        'Delete a folder and all of its sub-folders. Chats inside are NOT deleted — they fall back to ' +
        'Uncategorized. Destructive — requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Folder id from list-folders.'),
        confirm: z.boolean().optional().describe('Set true to actually delete (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Delete folder "${String(args.id)}" and every sub-folder under it. ` +
            'Chats inside are kept but moved to Uncategorized. The folder structure cannot be restored.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:folders-delete`, args.id)
      }
    },

    // ---------- Search ----------
    {
      name: `${ID}__search-messages`,
      description:
        'Full-text search across all chat messages. Returns hits (chat title, snippet, role, timestamp). Read-only.',
      inputSchema: {
        query: z.string().describe('Search text.')
      },
      handler: (args) => ctx.invoke(`${ID}:search-messages`, args.query)
    },
    {
      name: `${ID}__search-vault`,
      description:
        'Search the WICKED Brain vault (Obsidian-style markdown notes) and return matching notes. Read-only.',
      inputSchema: {
        query: z.string().describe('Search text.')
      },
      handler: (args) => ctx.invoke(`${ID}:vault-search`, args.query)
    },

    // ---------- Brain vault (read) ----------
    {
      name: `${ID}__list-vault-notes`,
      description:
        'List every note in the WICKED Brain vault (path, title, category, tags, date, body). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:vault-readAll`)
    },
    {
      name: `${ID}__read-vault-note`,
      description: 'Read the raw markdown of one vault note by its vault-relative path. Read-only.',
      inputSchema: {
        path: z.string().describe('Vault-relative note path (from list-vault-notes or search-vault).')
      },
      handler: (args) => ctx.invoke(`${ID}:vault-readNote`, args.path)
    },

    // ---------- Agent personas ("brains") ----------
    {
      name: `${ID}__list-personas`,
      description:
        'List vault-backed agent personas / "brains" (id, name, avatar, systemPrompt, vaultPath). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:agent-getPersonas`)
    },
    {
      name: `${ID}__search-brain-folder`,
      description:
        "Search the markdown docs inside a brain folder (e.g. a persona's vaultPath) and return matching docs. Read-only.",
      inputSchema: {
        folderPath: z.string().describe("Absolute folder path (e.g. a persona's vaultPath)."),
        query: z.string().describe('Search text.'),
        limit: z.number().optional().describe('Max docs to return.')
      },
      handler: (args) =>
        ctx.invoke(`${ID}:brain-folderSearch`, args.folderPath, args.query, args.limit)
    },

    // ---------- Project Board ----------
    {
      name: `${ID}__list-project-boards`,
      description: 'List Project Board projects (id, name, icon, timestamps). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:pb-getProjects`)
    },
    {
      name: `${ID}__delete-project`,
      description:
        'Permanently delete a Project Board project and ALL of its board data — notes, ink strokes and ' +
        'imported images are removed from disk. Irreversible. Destructive — requires confirmation.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Project id from list-project-boards.'),
        confirm: z.boolean().optional().describe('Set true to actually delete (see confirmation).')
      },
      handler: (args) => {
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Permanently delete Project Board project "${String(args.id)}" and its entire board folder ` +
            '(all notes, strokes and imported images). This cannot be undone.'
        )
        if (gate) return gate
        return ctx.invoke(`${ID}:pb-deleteProject`, args.id)
      }
    },

    // ---------- Model discovery ----------
    {
      name: `${ID}__list-chat-models`,
      description:
        'List the chat-capable models a provider key can actually call. Returns [] when the key is unset. Read-only.',
      inputSchema: {
        provider: z
          .enum(['openai', 'gemini', 'deepseek', 'ollama'])
          .describe('Provider to enumerate models for.')
      },
      handler: (args) => ctx.invoke(`${ID}:models-listChat`, args.provider)
    }
  ]
}

import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'fs'
import { configStore } from './config-persistence'
import { logger } from './logger'
import type {
  Conversation,
  ConversationSummary,
  ChatMessage
} from '../../shared/types'

const SUBFOLDER = 'chat-conversations'

/**
 * Persists conversations as Markdown into the user's Obsidian vault, one file
 * per conversation under `<vault>/chat-conversations/`. A small JSON sidecar
 * (`.<id>.json`) alongside each markdown file stores the structured data so we
 * can faithfully restore a conversation (including Gemini analyses) into the UI
 * while the `.md` remains human-readable inside Obsidian.
 */
export class ConversationStore {
  private get vault(): string {
    return configStore.load().obsidianVaultPath
  }

  private dir(): string {
    if (!this.vault) throw new Error('Obsidian vault path is not set in Settings.')
    const d = join(this.vault, SUBFOLDER)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  private mdPath(conv: Conversation): string {
    return join(this.dir(), conv.vaultRelativePath)
  }

  private jsonPath(id: string): string {
    return join(this.dir(), `.${id}.json`)
  }

  list(): ConversationSummary[] {
    if (!this.vault) return []
    let dir: string
    try {
      dir = this.dir()
    } catch {
      return []
    }
    const summaries: ConversationSummary[] = []
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('.') || !f.endsWith('.json')) continue
      try {
        const conv = JSON.parse(
          readFileSync(join(dir, f), 'utf-8')
        ) as Conversation
        summaries.push({
          id: conv.id,
          title: conv.title,
          updatedAt: conv.updatedAt,
          preview: firstUserText(conv).slice(0, 120),
          vaultRelativePath: conv.vaultRelativePath
        })
      } catch (err) {
        logger.warn('Skipping unreadable conversation sidecar', f, err)
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  load(id: string): Conversation | null {
    try {
      const raw = readFileSync(this.jsonPath(id), 'utf-8')
      return JSON.parse(raw) as Conversation
    } catch {
      return null
    }
  }

  save(conv: Conversation): Conversation {
    const dir = this.dir()
    if (!conv.vaultRelativePath) {
      conv.vaultRelativePath = buildFileName(conv)
    }
    conv.updatedAt = new Date().toISOString()
    // Structured sidecar (source of truth for the UI).
    writeFileSync(this.jsonPath(conv.id), JSON.stringify(conv, null, 2), 'utf-8')
    // Human-readable markdown for Obsidian.
    writeFileSync(join(dir, conv.vaultRelativePath), toMarkdown(conv), 'utf-8')
    return conv
  }

  delete(id: string): void {
    const conv = this.load(id)
    try {
      rmSync(this.jsonPath(id), { force: true })
      if (conv) rmSync(join(this.dir(), conv.vaultRelativePath), { force: true })
    } catch (err) {
      logger.warn('Failed to delete conversation', id, err)
    }
  }
}

function firstUserText(conv: Conversation): string {
  return conv.messages.find((m) => m.role === 'user')?.content ?? conv.title
}

function buildFileName(conv: Conversation): string {
  const ts = conv.createdAt.replace(/[:.]/g, '-')
  const words = firstUserText(conv)
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
  const slug = words || 'conversation'
  return `${ts} - ${slug}.md`
}

/** Render a conversation to Markdown, including embedded Gemini analyses. */
function toMarkdown(conv: Conversation): string {
  const lines: string[] = []
  lines.push(`# ${conv.title}`, '')
  lines.push(`- **Date:** ${conv.createdAt}`)
  lines.push(`- **Model:** ${conv.model}`)
  if (conv.projectName) lines.push(`- **Project:** ${conv.projectName}`)
  lines.push('')
  for (const m of conv.messages) {
    lines.push(...messageToMarkdown(m), '')
  }
  return lines.join('\n')
}

function messageToMarkdown(m: ChatMessage): string[] {
  if (m.kind === 'gemini-analysis' && m.gemini) {
    const g = m.gemini
    return [
      `### Gemini Analysis - ${m.createdAt}`,
      `**Screenshot:** ![screenshot](data:image/png;base64,${g.screenshotBase64})`,
      '',
      `**Analysis:** ${g.analysis}`,
      '',
      `**Action Taken:** ${g.actionTaken ?? 'Pending'}`,
      '',
      '**Changes Applied:**',
      ...(g.changes.length
        ? g.changes.map((c) => `- ${c.path}: ${c.action}${c.description ? ` — ${c.description}` : ''}`)
        : ['- (none)'])
    ]
  }
  const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'
  const model = m.role === 'assistant' && m.model ? ` (${m.model})` : ''
  return [`### ${who}${model} - ${m.createdAt}`, '', m.content]
}

export const conversationStore = new ConversationStore()

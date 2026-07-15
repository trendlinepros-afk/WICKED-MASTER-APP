import { useCallback, useState } from 'react';
import type { Chat, MemoryReview, Message, Settings } from '../types';
import { completeText } from './useChat';
import { embedText } from './useVaultSearch';
import { api } from '../lib/bridge';
import { useKeysStore } from '../store/keysStore';

const SUMMARY_PROMPT = `Summarize this conversation. Extract:
1. A 2-3 sentence summary
2. Key decisions or conclusions (bullet list)
3. Any future project ideas or things the user wants to do someday (flag these clearly). Be conservative — only include something here if the user explicitly describes a future project or thing they want to build or do someday.
4. Open questions remaining
5. Suggested tags (3-5 keywords)
6. Suggested category, exactly one of: Ideas | Projects | Workflows | Decisions | People | Reference | Uncategorized

Return ONLY valid JSON (no markdown fence) with keys: summary (string), keyPoints (string[]), ideas (string[]), openQuestions (string[]), tags (string[]), category (string).

Conversation transcript:
`;

function transcript(messages: Message[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const text = m.content
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('\n');
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    })
    .join('\n\n');
}

function parseReviewJson(raw: string): MemoryReview {
  let text = raw.trim();
  // Strip code fences if the model added them.
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  // Grab the first {...} block.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1);
  const parsed = JSON.parse(text);
  return {
    summary: String(parsed.summary ?? ''),
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(String) : [],
    ideas: Array.isArray(parsed.ideas) ? parsed.ideas.map(String) : [],
    openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions.map(String) : [],
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    category: String(parsed.category ?? 'Uncategorized'),
  };
}

function frontmatter(fields: Record<string, string>): string {
  // Collapse newlines so a value can't break out of the YAML block.
  const lines = Object.entries(fields).map(
    ([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ').trim()}`
  );
  return `---\n${lines.join('\n')}\n---\n`;
}

function buildNoteMarkdown(title: string, review: MemoryReview, chatId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const fm = frontmatter({
    title,
    date,
    category: review.category,
    source_chat_id: chatId,
    tags: `[${review.tags.join(', ')}]`,
  });
  let body = `\n## Summary\n\n${review.summary}\n`;
  if (review.keyPoints.length) {
    body += `\n## Key Points\n\n${review.keyPoints.map((p) => `- ${p}`).join('\n')}\n`;
  }
  if (review.openQuestions.length) {
    body += `\n## Open Questions\n\n${review.openQuestions.map((q) => `- ${q}`).join('\n')}\n`;
  }
  return fm + body;
}

function buildIdeaMarkdown(idea: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const title = `Idea: ${idea.slice(0, 60)}`;
  const fm = frontmatter({ title, date, category: 'Ideas', status: 'backlog' });
  return `${fm}\n## Idea Summary\n\n${idea}\n\n## Why It's Interesting\n\n_Captured automatically from a conversation._\n\n## When To Revisit\n\nSomeday / maybe.\n`;
}

export function useMemoryReview() {
  const [generating, setGenerating] = useState(false);

  const generateReview = useCallback(
    async (chat: Chat, messages: Message[], settings: Settings): Promise<MemoryReview> => {
      setGenerating(true);
      try {
        const raw = await completeText(
          chat.provider,
          chat.modelVersion,
          settings,
          SUMMARY_PROMPT + transcript(messages)
        );
        return parseReviewJson(raw);
      } finally {
        setGenerating(false);
      }
    },
    []
  );

  const saveReview = useCallback(
    async (
      chat: Chat,
      review: MemoryReview,
      settings: Settings
    ): Promise<{ notePath: string; ideaPaths: string[] }> => {
      const title = chat.title && chat.title !== 'New Chat' ? chat.title : review.summary.slice(0, 40);
      const noteMd = buildNoteMarkdown(title, review, chat.id);
      // Overwrite this chat's existing note (matched by source_chat_id) so
      // re-commits update in place instead of creating duplicates.
      const notePath = await api.vaultWriteNoteForChat(
        review.category,
        title,
        noteMd,
        chat.id
      );

      // Write a separate idea note for each detected idea.
      const ideaPaths: string[] = [];
      for (const idea of review.ideas) {
        if (!idea.trim()) continue;
        const ideaMd = buildIdeaMarkdown(idea);
        const p = await api.vaultWriteNote('Ideas', `idea-${idea.slice(0, 40)}`, ideaMd);
        ideaPaths.push(p);
      }

      await api.vaultRegenerateIndex();

      // Generate + store an embedding for the new note when possible (the
      // OpenAI key check + call happen in the main process).
      if (useKeysStore.getState().status['openai'] === true && settings.semanticIndexingEnabled) {
        try {
          const embedding = await embedText(review.summary + '\n' + noteMd);
          await api.vaultSaveEmbedding(notePath, embedding);
        } catch (err) {
          console.warn('Failed to embed new note:', err);
        }
      }

      return { notePath, ideaPaths };
    },
    []
  );

  return { generateReview, saveReview, generating };
}

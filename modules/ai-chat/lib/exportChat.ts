import { marked } from 'marked';
import type { Chat, Message } from '../types';
import { versionLabel } from '../components/ModelSelector/modelConfig';
import { api } from './bridge';

function partsToText(content: Message['content']): string {
  return content
    .map((p) => {
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'image_url') return '![image](attachment)';
      if (p.type === 'file') return `📎 ${p.name ?? 'file'}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function roleLabel(chat: Chat, role: Message['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return versionLabel(chat.provider, chat.modelVersion);
  return 'System';
}

export function chatToMarkdown(chat: Chat, messages: Message[]): string {
  const date = new Date(chat.createdAt).toISOString().slice(0, 10);
  const model = versionLabel(chat.provider, chat.modelVersion);
  let md = `# ${chat.title}\n**Date:** ${date}  \n**Model:** ${model}\n\n---\n\n`;
  for (const m of messages) {
    if (m.role === 'system') continue;
    md += `**${roleLabel(chat, m.role)}:** ${partsToText(m.content)}\n\n`;
  }
  return md;
}

function chatToHtml(chat: Chat, messages: Message[]): string {
  const body = marked.parse(chatToMarkdown(chat, messages)) as string;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 720px; margin: 40px auto; line-height: 1.6; color: #1a1a1a; }
    h1 { font-size: 24px; } strong { color: #4338ca; }
    code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; font-family: monospace; }
    pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow-x: auto; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  </style></head><body>${body}</body></html>`;
}

export async function exportChat(chat: Chat, format: 'markdown' | 'pdf'): Promise<string | null> {
  const messages = await api.getMessages(chat.id);
  const safeName = chat.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'chat';
  if (format === 'markdown') {
    return api.exportMarkdown(safeName, chatToMarkdown(chat, messages));
  }
  return api.exportPDF(safeName, chatToHtml(chat, messages));
}

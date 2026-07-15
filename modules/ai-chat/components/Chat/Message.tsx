import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Chat, Message as MessageType } from '../../types';
import { versionLabel, providerColor } from '../ModelSelector/modelConfig';
import { ImageGenResult } from './ImageGenResult';
import { SpeakButton } from './SpeakButton';
import { useMessageActions } from '../../hooks/useMessageActions';

export function Message({ message, chat }: { message: MessageType; chat: Chat }) {
  const isUser = message.role === 'user';
  const text = message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const images = message.content.filter((p) => p.type === 'image_url' && p.image_url?.url);
  const files = message.content.filter((p) => p.type === 'file');

  // Tag the bubble with the model that actually produced THIS message, falling
  // back to the chat's current model for older messages without it recorded.
  const msgProvider = message.provider ?? chat.provider;
  const msgModel = message.modelVersion ?? chat.modelVersion;

  const { deleteMessage, regenerateFrom, editAndResend, branchFrom } = useMessageActions(chat);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  // Persisted (DB-backed) messages have non-temporary ids; actions need those.
  const persisted = !message.id.startsWith('local-');

  return (
    <div className={`group mb-5 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`mb-1 flex items-center gap-2 text-xs text-muted ${
            isUser ? 'justify-end' : 'justify-start'
          }`}
        >
          {isUser ? (
            <span>You</span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: providerColor(msgProvider) }}
              />
              {versionLabel(msgProvider, msgModel)}
            </span>
          )}
          {message.createdAt > 0 && (
            <span className="text-muted/70" title={new Date(message.createdAt).toLocaleString()}>
              {formatTimestamp(message.createdAt)}
            </span>
          )}
        </div>

        {editing ? (
          <div className="w-[60vw] max-w-2xl">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, Math.max(2, draft.split('\n').length))}
              className="w-full rounded-xl border border-accent bg-raised px-4 py-3 text-sm text-ink outline-none"
            />
            <div className="mt-1 flex justify-end gap-2 text-xs">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-edge px-2 py-1 text-muted hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  if (draft.trim()) editAndResend(message, draft.trim());
                }}
                className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:bg-accent/90"
              >
                Save &amp; resend
              </button>
            </div>
          </div>
        ) : (
          <div className={`rounded-xl px-4 py-3 ${isUser ? 'bg-accent/15' : 'bg-raised'}`}>
            {images.map((p, i) => (
              <ImageGenResult key={i} url={p.image_url!.url} />
            ))}
            {files.map((p, i) => (
              <div
                key={i}
                className="mb-2 inline-flex items-center gap-2 rounded-lg border border-edge bg-black/20 px-3 py-1.5 text-sm"
              >
                📎 {p.name}
              </div>
            ))}
            {text &&
              (isUser ? (
                <div className="whitespace-pre-wrap break-words text-ink">{text}</div>
              ) : (
                <AssistantMarkdown text={text} />
              ))}
            {!text && !images.length && !files.length && (
              <span className="text-muted">▍</span>
            )}
          </div>
        )}

        {!editing && persisted && (
          <div
            className={`mt-1 flex items-center gap-3 text-xs text-muted opacity-0 transition group-hover:opacity-100 ${
              isUser ? 'justify-end' : 'justify-start'
            }`}
          >
            {text && <SpeakButton text={text} />}
            {!isUser && text && <CopyButton text={text} />}
            {!isUser && (
              <ActionBtn label="↻ Regenerate" onClick={() => regenerateFrom(message)} />
            )}
            {isUser && text && (
              <ActionBtn
                label="✎ Edit"
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
              />
            )}
            <ActionBtn label="⑂ Branch" onClick={() => branchFrom(message)} />
            <ActionBtn label="🗑 Delete" onClick={() => deleteMessage(message)} />
          </div>
        )}
      </div>
    </div>
  );
}

// Compact bubble timestamp: just the time for today, "Mon D, h:mm AM" for
// older dates, and a full date for other years. Full value is in the title.
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

function ActionBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="hover:text-ink">
      {label}
    </button>
  );
}

function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown-body text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = className?.includes('language-');
            if (isBlock && match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ margin: 0, borderRadius: 8, fontSize: 13 }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="mt-1 text-xs text-muted hover:text-ink"
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}

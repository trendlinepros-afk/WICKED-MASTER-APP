import type { ChatMessage } from '../shared/types'
import { CodeBlock } from './CodeBlock'

interface MessageBubbleProps {
  message: ChatMessage
}

type Segment =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string; filename?: string }

/** Pull a file path out of a fence info string, if present. */
function pathFromInfo(info: string): string | undefined {
  const title = info.match(/title=["']([^"']+)["']/)
  if (title) return title[1]
  const fileEq = info.match(/(?:file|path)[:=]["']?([^\s"']+)/i)
  if (fileEq) return fileEq[1]
  for (const t of info.split(/\s+/)) {
    if (/[./\\]/.test(t) && /\.\w+$/.test(t)) return t
  }
  return undefined
}

function langFromInfo(info: string): string | undefined {
  const langToken = info.split(/\s+/)[0] ?? ''
  return langToken.split(/[/\\]/).pop() || undefined
}

/**
 * Minimal markdown parse: split content on triple-backtick fenced code blocks.
 * Everything outside fences is treated as plain text (line breaks preserved).
 * A trailing UNCLOSED fence (mid-stream, before the closing ``` arrives) is
 * still rendered as a code segment so the collapsible block appears while the
 * model is writing.
 */
function parseSegments(content: string): Segment[] {
  const segments: Segment[] = []
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = fence.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, match.index) })
    }
    const info = (match[1] ?? '').trim()
    segments.push({
      type: 'code',
      content: match[2].replace(/\n$/, ''),
      language: langFromInfo(info),
      filename: pathFromInfo(info)
    })
    lastIndex = fence.lastIndex
  }

  const rest = content.slice(lastIndex)
  const open = rest.match(/```([^\n`]*)\n?([\s\S]*)$/)
  if (open) {
    const before = rest.slice(0, open.index)
    if (before.trim()) segments.push({ type: 'text', content: before })
    const info = (open[1] ?? '').trim()
    segments.push({
      type: 'code',
      content: (open[2] ?? '').replace(/\n$/, ''),
      language: langFromInfo(info),
      filename: pathFromInfo(info)
    })
  } else if (rest.length > 0) {
    segments.push({ type: 'text', content: rest })
  }

  return segments
}

/** Renders a single non-Gemini chat message (user / assistant / system). */
export function MessageBubble({ message }: MessageBubbleProps): JSX.Element {
  const { role } = message

  if (role === 'system') {
    return (
      <div className="my-1 text-center text-xs italic text-muted">
        {message.content}
      </div>
    )
  }

  const isUser = role === 'user'
  const segments = parseSegments(message.content)

  return (
    <div className={`my-2 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`ca-prose rounded-lg px-3 py-2 text-sm ${
            isUser ? 'bg-accent text-accent-ink' : 'bg-raised text-ink'
          }`}
        >
          {segments.map((seg, idx) =>
            seg.type === 'code' ? (
              <CodeBlock
                key={idx}
                code={seg.content}
                language={seg.language}
                filename={seg.filename}
              />
            ) : (
              seg.content.trim().length > 0 && (
                <p key={idx} className="whitespace-pre-wrap break-words">
                  {seg.content.trim()}
                </p>
              )
            )
          )}
        </div>
        {!isUser && message.model && (
          <div className="mt-0.5 px-1 text-[10px] text-muted">
            {message.model}
          </div>
        )}
      </div>
    </div>
  )
}

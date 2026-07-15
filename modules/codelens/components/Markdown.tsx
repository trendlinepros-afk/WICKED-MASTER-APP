import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text]
  )
  return (
    <div
      className={`prose prose-sm max-w-none dark:prose-invert prose-headings:text-ink prose-p:text-ink/80 prose-li:text-ink/80 prose-strong:text-ink prose-code:text-accent prose-pre:bg-bg prose-pre:text-ink/80 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

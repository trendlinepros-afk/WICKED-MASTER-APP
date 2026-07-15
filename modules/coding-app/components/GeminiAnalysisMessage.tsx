import type { ChatMessage } from '../shared/types'
import { useStore } from '../store'

interface GeminiAnalysisMessageProps {
  message: ChatMessage
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Renders a Gemini vision analysis message with fix / skip controls. */
export function GeminiAnalysisMessage({
  message
}: GeminiAnalysisMessageProps): JSX.Element | null {
  const config = useStore((s) => s.config)
  const resolveGeminiAnalysis = useStore((s) => s.resolveGeminiAnalysis)

  const g = message.gemini
  if (!g) return null

  const autoFix = config?.autoFixFromGemini ?? false
  const showButtons = !autoFix && g.actionTaken === null

  const statusLabel = g.actionTaken ?? 'Pending'

  return (
    <div className="my-2 rounded-lg border border-edge bg-raised p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">Gemini Analysis</span>
        <span className="text-xs text-muted">{formatTime(message.createdAt)}</span>
      </div>

      {g.screenshotBase64 && (
        <img
          src={`data:image/png;base64,${g.screenshotBase64}`}
          alt="Analyzed preview screenshot"
          className="mb-2 max-h-[200px] w-auto rounded border border-edge object-contain"
        />
      )}

      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full bg-edge/60 px-2 py-0.5 text-xs text-muted">
          {g.issueCount} issue(s) detected
        </span>
      </div>

      {g.analysis && (
        <p className="mb-2 whitespace-pre-wrap break-words text-sm text-ink">
          {g.analysis}
        </p>
      )}

      {g.changes.length > 0 && (
        <ul className="mb-2 space-y-0.5 rounded bg-surface p-2 text-xs text-muted">
          {g.changes.map((c, idx) => (
            <li key={idx} className="flex justify-between gap-2">
              <span className="truncate font-mono">{c.path}</span>
              <span className="shrink-0 uppercase">{c.action}</span>
            </li>
          ))}
        </ul>
      )}

      {showButtons ? (
        <div className="flex gap-2">
          <button
            className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink hover:opacity-90"
            onClick={() => void resolveGeminiAnalysis(message.id, true)}
          >
            Fix
          </button>
          <button
            className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-edge/60"
            onClick={() => void resolveGeminiAnalysis(message.id, false)}
          >
            Don&apos;t Fix
          </button>
        </div>
      ) : (
        <div className="text-xs font-medium text-muted">
          Status: {statusLabel}
        </div>
      )}
    </div>
  )
}

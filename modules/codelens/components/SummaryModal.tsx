import { Download, FileText, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { codelensApi } from '../lib/bridge'
import { Markdown } from './Markdown'
import { Spinner } from './Spinner'

interface Props {
  projectName: string
  onClose(): void
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; markdown: string }

export function SummaryModal({ projectName, onClose }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [exportNote, setExportNote] = useState<string | null>(null)
  const requested = useRef(false)

  const generate = async () => {
    setState({ kind: 'loading' })
    const res = await codelensApi.summarizeProject()
    setState(res.ok ? { kind: 'ready', markdown: res.data } : { kind: 'error', message: res.error })
  }

  useEffect(() => {
    // Guard against React StrictMode double-mount firing two API calls.
    if (requested.current) return
    requested.current = true
    void generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doExport = async (format: 'md' | 'pdf') => {
    if (state.kind !== 'ready') return
    setExportNote(`Exporting ${format.toUpperCase()}…`)
    const res = await codelensApi.exportReport(state.markdown, format)
    if (!res.ok) setExportNote(`Export failed: ${res.error}`)
    else if (res.data === null) setExportNote(null) // user cancelled the save dialog
    else setExportNote(`Saved to ${res.data}`)
  }

  const btn =
    'inline-flex items-center gap-1.5 rounded-md border border-edge bg-raised px-2.5 py-1.5 text-xs text-ink/80 hover:bg-edge/60 disabled:opacity-40 transition-colors'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col rounded-xl border border-edge bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-edge px-5 py-3">
          <FileText size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-ink">Project Report — {projectName}</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              className={btn}
              onClick={() => void generate()}
              disabled={state.kind === 'loading'}
              title="Regenerate"
            >
              <RefreshCw size={13} />
            </button>
            <button className={btn} onClick={() => void doExport('md')} disabled={state.kind !== 'ready'}>
              <Download size={13} /> Markdown
            </button>
            <button className={btn} onClick={() => void doExport('pdf')} disabled={state.kind !== 'ready'}>
              <Download size={13} /> PDF
            </button>
            <button className="ml-1 text-muted/70 hover:text-ink" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {state.kind === 'loading' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
              <Spinner />
              <p className="text-sm">The AI is reading the key files and writing your report…</p>
              <p className="text-xs text-muted/70">This usually takes 15–40 seconds.</p>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="mx-auto mt-12 max-w-md rounded-lg border border-danger/40 bg-danger/10 p-4 text-center text-sm text-danger">
              <p>{state.message}</p>
              <button
                className="mt-3 underline-offset-2 hover:underline"
                onClick={() => void generate()}
              >
                Try again
              </button>
            </div>
          )}
          {state.kind === 'ready' && <Markdown text={state.markdown} />}
        </div>

        {exportNote && (
          <div className="shrink-0 border-t border-edge px-5 py-2 text-xs text-muted">
            {exportNote}
          </div>
        )}
      </div>
    </div>
  )
}

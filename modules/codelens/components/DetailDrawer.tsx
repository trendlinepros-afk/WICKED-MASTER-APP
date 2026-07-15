import {
  ArrowDownLeft,
  ArrowUpRight,
  KeyRound,
  Network,
  ShieldAlert,
  Sparkles,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { codelensApi } from '../lib/bridge'
import type { ExplainResult, ScanResult, VulnIssue } from '../shared/types'
import { formatBytes, LANG_META, SEVERITY_META } from '../utils/lang'
import { Markdown } from './Markdown'
import { Spinner } from './Spinner'

interface Props {
  scan: ScanResult
  relPath: string
  aiEnabled: boolean
  onClose(): void
  onSelect(relPath: string): void
  onOpenSettings(): void
}

interface AsyncText {
  loading: boolean
  text?: string
  error?: string
}

const sectionTitle =
  'mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted'
const aiButton =
  'inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs text-accent hover:bg-accent/20 disabled:opacity-40 transition-colors'
const chip =
  'inline-flex max-w-full cursor-pointer items-center truncate rounded bg-raised px-1.5 py-0.5 text-[11px] text-ink/80 hover:bg-edge/60 hover:text-accent'

function AiGate({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <div className="rounded-lg border border-edge bg-raised/60 p-3 text-xs text-muted">
      <p className="mb-2 flex items-center gap-1.5">
        <KeyRound size={13} className="text-muted/70" />
        AI explanations need an API key (Claude, OpenAI, Gemini, or DeepSeek).
      </p>
      <button className="text-accent underline-offset-2 hover:underline" onClick={onOpenSettings}>
        Add a key in Settings →
      </button>
    </div>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
      <p>{message}</p>
      <button className="mt-2 underline-offset-2 hover:underline" onClick={onRetry}>
        Try again
      </button>
    </div>
  )
}

export function DetailDrawer({
  scan,
  relPath,
  aiEnabled,
  onClose,
  onSelect,
  onOpenSettings
}: Props) {
  const file = scan.files.find((f) => f.relPath === relPath)
  const issues = scan.issues.filter((i) => i.file === relPath)
  const inbound = scan.edges.filter((e) => e.target === relPath).map((e) => e.source)
  const outbound = scan.edges.filter((e) => e.source === relPath).map((e) => e.target)

  const [explain, setExplain] = useState<{
    loading: boolean
    result?: ExplainResult
    error?: string
  }>({ loading: false })
  const [connections, setConnections] = useState<AsyncText>({ loading: false })
  const [issueExpl, setIssueExpl] = useState<Record<string, AsyncText>>({})
  const [code, setCode] = useState<AsyncText>({ loading: true })

  useEffect(() => {
    setExplain({ loading: false })
    setConnections({ loading: false })
    setIssueExpl({})
    setCode({ loading: true })
    let alive = true
    void codelensApi.readFile(relPath).then((res) => {
      if (!alive) return
      if (res.ok) setCode({ loading: false, text: res.data.content })
      else setCode({ loading: false, error: res.error })
    })
    return () => {
      alive = false
    }
  }, [relPath])

  if (!file) return null

  const runExplain = async () => {
    setExplain({ loading: true })
    const res = await codelensApi.explainFile(relPath)
    setExplain(res.ok ? { loading: false, result: res.data } : { loading: false, error: res.error })
  }

  const runConnections = async () => {
    setConnections({ loading: true })
    const res = await codelensApi.explainConnections(relPath)
    setConnections(res.ok ? { loading: false, text: res.data } : { loading: false, error: res.error })
  }

  const runIssue = async (issue: VulnIssue) => {
    setIssueExpl((p) => ({ ...p, [issue.id]: { loading: true } }))
    const res = await codelensApi.explainIssue(issue.id)
    setIssueExpl((p) => ({
      ...p,
      [issue.id]: res.ok ? { loading: false, text: res.data } : { loading: false, error: res.error }
    }))
  }

  const lang = LANG_META[file.language]

  return (
    <div className="flex w-[400px] shrink-0 flex-col border-l border-edge bg-surface">
      {/* header */}
      <div className="flex shrink-0 items-start gap-2 border-b border-edge p-3">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: lang.color }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{file.name}</div>
          <div className="truncate text-[11px] text-muted">{file.relPath}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted">
            <span className="rounded bg-raised px-1.5 py-0.5">{lang.label}</span>
            <span className="rounded bg-raised px-1.5 py-0.5">{file.lines} lines</span>
            <span className="rounded bg-raised px-1.5 py-0.5">{formatBytes(file.size)}</span>
            <span className="rounded bg-raised px-1.5 py-0.5">complexity {file.complexity}/10</span>
          </div>
        </div>
        <button className="text-muted/70 hover:text-ink" onClick={onClose} title="Close panel">
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {/* AI explanation */}
        <section>
          <div className={sectionTitle}>
            <Sparkles size={12} /> What does this file do?
          </div>
          {!aiEnabled ? (
            <AiGate onOpenSettings={onOpenSettings} />
          ) : explain.loading ? (
            <Spinner label="Asking the AI…" />
          ) : explain.error ? (
            <ErrorBox message={explain.error} onRetry={runExplain} />
          ) : explain.result ? (
            <div className="space-y-2">
              <p className="rounded-lg border border-accent/30 bg-accent/5 p-2.5 text-[13px] font-medium leading-snug text-ink">
                {explain.result.summary}
              </p>
              <p className="text-xs leading-relaxed text-ink/80">{explain.result.detail}</p>
            </div>
          ) : (
            <button className={aiButton} onClick={runExplain} disabled={!file.parsed}>
              <Sparkles size={13} />
              {file.parsed ? 'Explain this file' : 'File too large / binary to explain'}
            </button>
          )}
        </section>

        {/* connections */}
        <section>
          <div className={sectionTitle}>
            <Network size={12} /> Connections
          </div>
          <div className="space-y-2 text-xs">
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] text-muted">
                <ArrowUpRight size={11} /> Imports ({outbound.length})
                {file.externalImports.length > 0 && (
                  <span className="text-muted/70">+ {file.externalImports.length} external</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {outbound.length === 0 && <span className="text-muted/70">none in project</span>}
                {outbound.map((p) => (
                  <span key={p} className={chip} onClick={() => onSelect(p)} title={p}>
                    {p.split('/').pop()}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1 text-[11px] text-muted">
                <ArrowDownLeft size={11} /> Imported by ({inbound.length})
              </div>
              <div className="flex flex-wrap gap-1">
                {inbound.length === 0 && (
                  <span className="text-muted/70">nothing in project</span>
                )}
                {inbound.map((p) => (
                  <span key={p} className={chip} onClick={() => onSelect(p)} title={p}>
                    {p.split('/').pop()}
                  </span>
                ))}
              </div>
            </div>
            {aiEnabled &&
              (connections.loading ? (
                <Spinner label="Tracing connections…" />
              ) : connections.error ? (
                <ErrorBox message={connections.error} onRetry={runConnections} />
              ) : connections.text ? (
                <Markdown
                  text={connections.text}
                  className="rounded-lg border border-edge bg-raised/60 p-2.5"
                />
              ) : (
                <button className={aiButton} onClick={runConnections}>
                  <Network size={13} /> What does this connect to?
                </button>
              ))}
          </div>
        </section>

        {/* issues */}
        <section>
          <div className={sectionTitle}>
            <ShieldAlert size={12} /> Potential issues ({issues.length})
          </div>
          {issues.length === 0 ? (
            <p className="text-xs text-muted/70">Nothing flagged by the static scan.</p>
          ) : (
            <div className="space-y-2">
              {issues.map((issue) => {
                const meta = SEVERITY_META[issue.severity]
                const expl = issueExpl[issue.id]
                return (
                  <div key={issue.id} className="rounded-lg border border-edge bg-raised/60 p-2.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
                        style={{ background: meta.bg, color: meta.color }}
                      >
                        {issue.severity}
                      </span>
                      <span className="text-xs font-medium text-ink">{issue.title}</span>
                      <span className="ml-auto text-[10px] text-muted/70">line {issue.line}</span>
                    </div>
                    <pre className="mt-2 overflow-x-auto rounded bg-bg p-2 font-mono text-[10px] leading-relaxed text-ink/80">
                      {issue.snippet}
                    </pre>
                    <p className="mt-2 text-[11px] leading-relaxed text-muted">{issue.description}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink/80">
                      <span className="font-semibold text-ink">Fix: </span>
                      {issue.recommendation}
                    </p>
                    {aiEnabled &&
                      (expl?.loading ? (
                        <Spinner className="mt-2" label="Analyzing risk…" />
                      ) : expl?.error ? (
                        <div className="mt-2">
                          <ErrorBox message={expl.error} onRetry={() => runIssue(issue)} />
                        </div>
                      ) : expl?.text ? (
                        <Markdown text={expl.text} className="mt-2 border-t border-edge pt-2" />
                      ) : (
                        <button className={`${aiButton} mt-2`} onClick={() => runIssue(issue)}>
                          <Sparkles size={12} /> Explain risk & fix
                        </button>
                      ))}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* code preview */}
        <section>
          <div className={sectionTitle}>Code preview</div>
          {code.loading ? (
            <Spinner label="Loading file…" />
          ) : code.error ? (
            <p className="text-xs text-danger">{code.error}</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-lg border border-edge bg-bg p-2.5 font-mono text-[10.5px] leading-relaxed text-ink/80">
              {code.text?.split('\n').slice(0, 400).join('\n')}
              {(code.text?.split('\n').length ?? 0) > 400 && '\n… (preview truncated)'}
            </pre>
          )}
        </section>
      </div>
    </div>
  )
}

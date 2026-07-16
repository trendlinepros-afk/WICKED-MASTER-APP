import { useState } from 'react'
import { Check, Copy, PackagePlus } from 'lucide-react'
import {
  MODULE_FILE_ROLES,
  MODULE_FOLDER_STRUCTURE,
  MODULE_RULES,
  NAMING_CONVENTIONS,
  NEW_MODULE_TEMPLATE
} from '@shared/module-contract'

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export default function AddNewApp(): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copyTemplate = async (): Promise<void> => {
    await navigator.clipboard.writeText(NEW_MODULE_TEMPLATE)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="h-full overflow-y-auto p-10">
      <div className="max-w-3xl">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raised text-accent">
            <PackagePlus size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Add New App</h1>
            <p className="text-sm text-muted">
              How WICKED modules work, and a copy-ready template to start a new one.
            </p>
          </div>
        </div>

        <Section title="How it works">
          <p className="text-sm leading-relaxed text-muted">
            WICKED is one Electron + React <b className="text-ink">shell</b> that hosts
            self-contained <b className="text-ink">modules</b>. The shell owns navigation,
            theming, settings, auto-update, the central API-key vault, and the localhost MCP
            server. A module is just a folder under <code className="text-ink">/modules</code>{' '}
            that the shell discovers automatically at build time — dropping in a correctly-shaped
            folder needs <b className="text-ink">zero shell code changes</b>.
          </p>
        </Section>

        <Section title="Folder structure">
          <pre className="overflow-x-auto rounded-xl border border-edge bg-surface p-4 text-xs leading-relaxed text-ink">
            {MODULE_FOLDER_STRUCTURE}
          </pre>
        </Section>

        <Section title="What each file is for">
          <div className="overflow-hidden rounded-xl border border-edge bg-surface">
            {MODULE_FILE_ROLES.map((f, i) => (
              <div
                key={f.file}
                className={`flex gap-3 p-3 text-sm ${i > 0 ? 'border-t border-edge' : ''}`}
              >
                <code className="w-24 shrink-0 font-semibold text-accent">{f.file}</code>
                <span className="text-muted">{f.role}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Naming conventions">
          <ul className="space-y-1.5 text-sm text-muted">
            {NAMING_CONVENTIONS.map((n) => (
              <li key={n} className="flex gap-2">
                <span className="text-accent">•</span>
                <span dangerouslySetInnerHTML={{ __html: highlightCode(n) }} />
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Rules that must be followed">
          <ul className="space-y-1.5 text-sm text-muted">
            {MODULE_RULES.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span dangerouslySetInnerHTML={{ __html: highlightCode(r) }} />
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Copy-ready template">
          <p className="mb-3 text-sm text-muted">
            Paste this into a fresh Claude Code session to build a new module that fits the
            contract from day one.
          </p>
          <div className="relative">
            <button
              onClick={copyTemplate}
              className="absolute right-3 top-3 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink hover:opacity-90"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy template'}
            </button>
            <pre className="max-h-[420px] overflow-auto rounded-xl border border-edge bg-surface p-4 pt-14 text-xs leading-relaxed text-ink">
              {NEW_MODULE_TEMPLATE}
            </pre>
          </div>
        </Section>

        <p className="mt-8 pb-4 text-xs text-muted">
          This page is generated from the module contract in{' '}
          <code>src/shared/module-contract.ts</code>, the single source shared with{' '}
          <code>/modules/README.md</code> — it stays in sync with the real contract.
        </p>
      </div>
    </div>
  )
}

/** Wrap `code`-looking tokens (with backticks) in a styled span. */
function highlightCode(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped.replace(
    /`([^`]+)`/g,
    '<code class="rounded bg-raised px-1 py-0.5 text-ink">$1</code>'
  )
}

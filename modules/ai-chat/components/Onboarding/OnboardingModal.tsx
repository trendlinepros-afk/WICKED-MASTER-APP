import { useState } from 'react';
import { useOnboardingStore } from '../../store/onboardingStore';
import { useUIStore } from '../../store/uiStore';

interface Step {
  emoji: string;
  title: string;
  body: React.ReactNode;
}

const STEPS: Step[] = [
  {
    emoji: '🔮',
    title: 'Welcome to WICKED',
    body: (
      <>
        <p>
          One window, every model, one memory. Chat with <strong>OpenAI</strong>,{' '}
          <strong>Gemini</strong>, <strong>DeepSeek</strong>, or a <strong>local model</strong> —
          and everything you learn can be saved to a knowledge vault the AI reads from next time.
        </p>
        <p className="mt-2 text-muted">This quick tour covers the basics. ~1 minute.</p>
      </>
    ),
  },
  {
    emoji: '🔑',
    title: 'Add a model',
    body: (
      <>
        <p>Two ways to get a model talking:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Add an <strong>API key</strong> for OpenAI, Gemini, or DeepSeek in{' '}
            <strong>WICKED Settings → API Keys</strong> (the gear in the activity bar) — keys are
            stored once, encrypted, for the whole suite, or
          </li>
          <li>
            Run models <strong>free &amp; offline</strong> with <strong>Ollama</strong> — install it,
            then use <em>Manage models</em> in this module's Settings ⚙️ to download one.
          </li>
        </ul>
        <p className="mt-2 text-muted">
          Pick the provider &amp; model in the top bar; it saves per chat.
        </p>
      </>
    ),
  },
  {
    emoji: '🧠',
    title: 'Memory: Obsidian, or none',
    body: (
      <>
        <p>WICKED's long-term memory lives in an Obsidian vault. You have two choices:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>Use Obsidian</strong> (recommended) — point WICKED at an Obsidian vault and it
            remembers across sessions. Setup is on the next screen.
          </li>
          <li>
            <strong>No memory</strong> — leave the vault unset in Settings and WICKED is a plain
            multi-model chat; nothing is stored long-term.
          </li>
        </ul>
        <p className="mt-2">
          With memory on, the amber <strong>🧠 Brain</strong> toggle feeds relevant notes to the
          model before each message, and <strong>✓ End &amp; Review</strong> summarizes a chat back
          into the vault — so every session builds on the last.
        </p>
      </>
    ),
  },
  {
    emoji: '🟣',
    title: 'Set up Obsidian',
    body: (
      <>
        <p>To enable memory, set up an Obsidian vault and connect it:</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Install <strong>Obsidian</strong> from obsidian.md (free), open it, and{' '}
            <strong>“Create new vault”</strong> — pick a folder and name (e.g. <code>WICKED</code>).
          </li>
          <li>
            In WICKED, open <strong>Settings → Memory (Obsidian vault)</strong> and click{' '}
            <strong>Choose vault folder</strong>, selecting that same Obsidian vault folder.
          </li>
          <li>
            WICKED writes its notes there; back in Obsidian they appear live with backlinks and the
            graph. Any note's <strong>“Edit in Obsidian”</strong> button opens it directly.
          </li>
        </ol>
        <p className="mt-2 text-muted">Prefer no memory? Just skip this and leave it unset.</p>
      </>
    ),
  },
  {
    emoji: '🗺',
    title: 'Plan Mode',
    body: (
      <>
        <p>
          Click <strong>🗺 Plan</strong> to start a guided app-planning session. The model
          interviews you about your idea, then <strong>📦 Build Prompt</strong> compiles the whole
          plan into a copy-paste prompt you can hand to an AI coding agent — and saves it to your
          vault.
        </p>
      </>
    ),
  },
  {
    emoji: '🛠',
    title: 'Power features',
    body: (
      <>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>🎭 Persona</strong> — give a chat a custom system prompt or reusable template.
          </li>
          <li>
            <strong>MCP tools</strong> — connect a server (e.g. your Godot editor) so models can use
            real tools.
          </li>
          <li>
            Hover a message to <strong>regenerate, edit, branch, or delete</strong>.
          </li>
          <li>
            <strong>🔍 Search</strong> every chat, organize with folders, and restore deletes from
            the <strong>🗑 Recycle Bin</strong> (kept 30 days).
          </li>
          <li>
            Light/dark follows the WICKED shell theme, and the token/cost estimate lives in the
            header.
          </li>
        </ul>
      </>
    ),
  },
];

export function OnboardingModal() {
  const open = useOnboardingStore((s) => s.open);
  const finish = useOnboardingStore((s) => s.finish);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [step, setStep] = useState(0);

  if (!open) return null;

  const isLast = step === STEPS.length - 1;
  const s = STEPS[step];

  const close = () => {
    setStep(0);
    finish();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl">
        <div className="flex items-start justify-between px-6 pt-6">
          <div className="text-5xl">{s.emoji}</div>
          <button onClick={close} className="text-muted hover:text-ink" title="Skip">
            Skip
          </button>
        </div>

        <div className="px-6 py-4">
          <h2 className="text-xl font-semibold">{s.title}</h2>
          <div className="mt-2 text-sm leading-relaxed text-ink">{s.body}</div>
        </div>

        <div className="flex items-center justify-between border-t border-edge px-6 py-3">
          {/* Step dots */}
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === step ? 'bg-accent' : 'bg-edge'}`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((v) => v - 1)}
                className="rounded-lg border border-edge px-3 py-1.5 text-sm text-muted hover:text-ink"
              >
                Back
              </button>
            )}
            {/* Quick jump to Settings on the relevant steps */}
            {(step === 1 || step === 2) && (
              <button
                onClick={() => {
                  close();
                  setSettingsOpen(true);
                }}
                className="rounded-lg border border-accent/40 px-3 py-1.5 text-sm text-accent hover:bg-accent/10"
              >
                Open Settings
              </button>
            )}
            {isLast ? (
              <button
                onClick={close}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
              >
                Get started
              </button>
            ) : (
              <button
                onClick={() => setStep((v) => v + 1)}
                className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent/90"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

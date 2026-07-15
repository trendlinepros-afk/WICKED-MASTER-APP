import { useEffect, useRef, useState, type ReactNode } from 'react'

function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-5"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div className="w-[380px] max-w-full rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        {children}
      </div>
    </div>
  )
}

export function TextPrompt({
  title,
  placeholder,
  initial,
  hint,
  confirmLabel = 'OK',
  onDone
}: {
  title: string
  placeholder?: string
  initial?: string
  hint?: string
  confirmLabel?: string
  onDone: (value: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <Overlay onClose={() => onDone(null)}>
      <h3 className="text-base font-semibold">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone(value.trim())
          if (e.key === 'Escape') onDone(null)
        }}
        className="mt-3 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={() => onDone(null)}
          className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
        >
          Cancel
        </button>
        <button
          onClick={() => onDone(value.trim())}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  )
}

export function ConfirmModal({
  title,
  message,
  danger,
  onDone
}: {
  title: string
  message: string
  danger?: boolean
  onDone: (ok: boolean) => void
}): React.JSX.Element {
  return (
    <Overlay onClose={() => onDone(false)}>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={() => onDone(false)}
          className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
        >
          Cancel
        </button>
        <button
          onClick={() => onDone(true)}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            danger ? 'bg-danger text-white hover:opacity-90' : 'bg-accent text-accent-ink hover:opacity-90'
          }`}
        >
          {danger ? 'Delete' : 'OK'}
        </button>
      </div>
    </Overlay>
  )
}

export function SessionNotePrompt({
  onDone
}: {
  onDone: (note: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <Overlay>
      <h3 className="text-base font-semibold">Session logged</h3>
      <p className="mt-1 text-sm text-muted">What did you work on? (optional)</p>
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder="e.g. worked on combat AI"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone(value)
        }}
        className="mt-3 w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={() => onDone('')}
          className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
        >
          Skip
        </button>
        <button
          onClick={() => onDone(value)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          Save
        </button>
      </div>
    </Overlay>
  )
}

export function FolderMenu({
  name,
  onDone
}: {
  name: string
  onDone: (choice: 'rename' | 'delete' | null) => void
}): React.JSX.Element {
  return (
    <Overlay onClose={() => onDone(null)}>
      <h3 className="text-base font-semibold">{name}</h3>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          onClick={() => onDone('delete')}
          className="rounded-lg px-4 py-2 text-sm font-medium text-danger hover:bg-raised"
        >
          Delete folder
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => onDone(null)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:bg-raised"
          >
            Close
          </button>
          <button
            onClick={() => onDone('rename')}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
          >
            Rename
          </button>
        </div>
      </div>
    </Overlay>
  )
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/85 p-8"
      onClick={onClose}
    >
      <img src={url} className="max-h-full max-w-full rounded-lg" />
    </div>
  )
}

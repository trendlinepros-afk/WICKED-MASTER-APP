import { useEffect, useRef, useState } from 'react'
import { Check, FolderOpen, Image as ImageIcon, Plus, Trash2, X } from 'lucide-react'
import { imgUrl, useBoard, type Card } from './store'
import { ConfirmModal, Lightbox } from './Modals'

function useDebouncedPersist(cardId: string): () => void {
  const persistCard = useBoard((s) => s.persistCard)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      // flush on unmount so nothing is lost
      if (timer.current) {
        clearTimeout(timer.current)
        persistCard(cardId)
      }
    },
    [cardId, persistCard]
  )
  return () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      persistCard(cardId)
    }, 450)
  }
}

function AutoGrowTextarea({
  value,
  placeholder,
  onChange
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const t = ref.current
    if (t) {
      t.style.height = 'auto'
      t.style.height = t.scrollHeight + 'px'
    }
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-none overflow-hidden bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted/60"
    />
  )
}

function CardView({ card, autoFocus }: { card: Card; autoFocus: boolean }): React.JSX.Element {
  const { folders, activeCardId, setActiveCard, patchCard, persistCard, deleteCard, addImageToCard, removeImage } =
    useBoard()
  const schedulePersist = useDebouncedPersist(card.id)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) titleRef.current?.focus()
  }, [autoFocus])

  const active = activeCardId === card.id

  return (
    <div
      className={`flex flex-col gap-2.5 rounded-xl border bg-surface p-4 shadow-sm ${
        active ? 'border-accent' : 'border-edge'
      }`}
      onClick={() => setActiveCard(card.id)}
      onFocusCapture={() => setActiveCard(card.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault()
        for (const file of Array.from(e.dataTransfer.files)) {
          if (file.type.startsWith('image/')) await addImageToCard(card.id, file)
        }
      }}
    >
      <input
        ref={titleRef}
        type="text"
        value={card.title}
        placeholder="Idea title…"
        onChange={(e) => {
          patchCard(card.id, { title: e.target.value })
          schedulePersist()
        }}
        className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:text-muted/60"
      />
      <AutoGrowTextarea
        value={card.body}
        placeholder="Notes, details, what you have in mind…"
        onChange={(v) => {
          patchCard(card.id, { body: v })
          schedulePersist()
        }}
      />

      {/* images */}
      <div className="flex flex-wrap gap-2">
        {card.images.map((id) => {
          const url = imgUrl(id)
          return (
            <div key={id} className="group relative">
              <img
                src={url ?? ''}
                className="h-[60px] w-[84px] cursor-pointer rounded-lg border border-edge bg-raised object-cover"
                onClick={(e) => {
                  e.stopPropagation()
                  if (url) setLightboxUrl(url)
                }}
              />
              <button
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation()
                  removeImage(card.id, id)
                }}
                className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-danger text-white group-hover:flex"
              >
                <X size={10} strokeWidth={3} />
              </button>
            </div>
          )
        })}
        <button
          title="Paste with Ctrl+V, drop a file, or click to browse"
          onClick={(e) => {
            e.stopPropagation()
            setActiveCard(card.id)
            fileRef.current?.click()
          }}
          className="flex h-[60px] w-[84px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-edge text-[10.5px] text-muted hover:border-accent hover:text-accent"
        >
          <ImageIcon size={16} />
          add / paste
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={async (e) => {
            for (const file of Array.from(e.target.files ?? [])) await addImageToCard(card.id, file)
            e.target.value = ''
          }}
        />
      </div>

      {/* checklist */}
      <div className="flex flex-col gap-0.5">
        {card.checklist.map((item, i) => (
          <div key={i} className="group flex items-center gap-2">
            <button
              onClick={() => {
                const checklist = card.checklist.map((it, j) =>
                  j === i ? { ...it, done: !it.done } : it
                )
                patchCard(card.id, { checklist })
                persistCard(card.id)
              }}
              className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded border-[1.5px] ${
                item.done ? 'border-ok bg-ok text-white' : 'border-edge'
              }`}
            >
              {item.done && <Check size={11} strokeWidth={3} />}
            </button>
            <input
              type="text"
              value={item.text}
              placeholder="Task…"
              onChange={(e) => {
                const checklist = card.checklist.map((it, j) =>
                  j === i ? { ...it, text: e.target.value } : it
                )
                patchCard(card.id, { checklist })
                schedulePersist()
              }}
              className={`flex-1 bg-transparent py-0.5 text-[13px] outline-none placeholder:text-muted/60 ${
                item.done ? 'text-muted line-through' : ''
              }`}
            />
            <button
              title="Remove task"
              onClick={() => {
                patchCard(card.id, { checklist: card.checklist.filter((_, j) => j !== i) })
                persistCard(card.id)
              }}
              className="hidden h-5 w-5 shrink-0 items-center justify-center text-muted hover:text-danger group-hover:flex"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          onClick={() => {
            patchCard(card.id, { checklist: [...card.checklist, { text: '', done: false }] })
            persistCard(card.id)
          }}
          className="flex items-center gap-1.5 self-start py-0.5 text-xs text-muted hover:text-accent"
        >
          <Plus size={13} />
          Add task
        </button>
      </div>

      {/* footer */}
      <div className="mt-0.5 flex items-center justify-between border-t border-edge pt-2">
        <select
          value={card.folderId}
          onChange={async (e) => {
            patchCard(card.id, { folderId: e.target.value })
            await persistCard(card.id)
          }}
          className="max-w-[140px] rounded-md border border-edge bg-raised px-1.5 py-1 text-[11.5px] text-muted"
        >
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setConfirmDelete(true)}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-danger"
        >
          <Trash2 size={13} />
          Delete
        </button>
      </div>

      {confirmDelete && (
        <ConfirmModal
          title="Delete card?"
          message={`"${card.title || 'Untitled'}" will be removed.`}
          danger
          onDone={(ok) => {
            setConfirmDelete(false)
            if (ok) deleteCard(card.id)
          }}
        />
      )}
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  )
}

export default function Board({ onNewFolder }: { onNewFolder: () => void }): React.JSX.Element {
  const { folders, cards, settings, addCard } = useBoard()
  const [focusCardId, setFocusCardId] = useState<string | null>(null)

  const folder = folders.find((f) => f.id === settings.activeFolder) ?? folders[0]

  if (!folder) {
    return (
      <div className="px-5 py-16 text-center text-muted">
        <FolderOpen size={38} className="mx-auto mb-3 opacity-40" />
        <p>No folders yet.</p>
        <p>Create your first folder to start capturing ideas.</p>
        <button
          onClick={onNewFolder}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          <Plus size={15} />
          New folder
        </button>
      </div>
    )
  }

  const folderCards = cards
    .filter((c) => c.folderId === folder.id)
    .sort((a, b) => b.createdAt - a.createdAt)

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{folder.name}</h1>
        <button
          onClick={async () => {
            const c = await addCard(folder.id)
            setFocusCardId(c.id)
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90"
        >
          <Plus size={15} />
          New card
        </button>
      </div>

      {folderCards.length === 0 ? (
        <div className="px-5 py-16 text-center text-muted">
          <ImageIcon size={38} className="mx-auto mb-3 opacity-40" />
          <p>Nothing here yet.</p>
          <p>Add a card, then paste a screenshot with Ctrl+V.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] items-start gap-4">
          {folderCards.map((c) => (
            <CardView key={c.id} card={c} autoFocus={focusCardId === c.id} />
          ))}
        </div>
      )}
    </>
  )
}

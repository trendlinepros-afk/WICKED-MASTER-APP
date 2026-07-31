import { useEffect, useRef, useState } from 'react'
import { GripVertical, ImagePlus, Trash2, Type } from 'lucide-react'
import { imgUrl, useBoard, type CanvasItem } from './store'

/**
 * Freeform board: place text notes and images anywhere on a per-folder canvas
 * (the alternative to the stacked-card Board view). Items drag by their grip,
 * resize from the corner, text edits inline, images paste in with Ctrl+V. Every
 * move/resize/edit persists to IndexedDB. Cards are untouched — this is a second
 * way to use the same folder.
 */

const MIN_W = 90
const MIN_H = 50

export default function Freeform({ folderId }: { folderId: string }): React.JSX.Element {
  // Select the stable array reference, then filter in render. Filtering INSIDE
  // the selector returns a new array on every call, which makes zustand v5's
  // useSyncExternalStore see an ever-changing snapshot → infinite re-render
  // (React #185). Keep derived arrays out of the selector.
  const items = useBoard((s) => s.canvasItems).filter((i) => i.folderId === folderId)
  const addText = useBoard((s) => s.addCanvasText)
  const addImage = useBoard((s) => s.addCanvasImage)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // where the last click / paste landed, so new items appear near the cursor
  const lastPoint = useRef({ x: 60, y: 60 })
  // id of a freshly-created note to auto-focus so you can type immediately
  const [focusId, setFocusId] = useState<string | null>(null)

  // Click empty canvas → drop a note there and focus it (no "Add text" needed).
  const addNoteAt = (clientX: number, clientY: number): void => {
    const p = pointFromEvent(clientX, clientY)
    lastPoint.current = p
    void addText(folderId, p.x, p.y).then((it) => setFocusId(it.id))
  }

  const pointFromEvent = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = scrollRef.current
    if (!el) return { x: 60, y: 60 }
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, clientX - r.left + el.scrollLeft), y: Math.max(0, clientY - r.top + el.scrollTop) }
  }

  // paste an image straight onto the canvas
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent): Promise<void> => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      for (const it of Array.from(e.clipboardData?.items ?? [])) {
        if (it.type.startsWith('image/')) {
          const blob = it.getAsFile()
          if (!blob) continue
          e.preventDefault()
          const p = lastPoint.current
          await addImage(folderId, blob, p.x, p.y)
          return
        }
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [folderId, addImage])

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void addText(folderId, lastPoint.current.x, lastPoint.current.y)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink hover:opacity-90"
        >
          <Type size={14} /> Add text
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded-lg border border-edge bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent/60"
        >
          <ImagePlus size={14} /> Add image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            let { x, y } = lastPoint.current
            for (const f of files) {
              if (!f.type.startsWith('image/')) continue
              await addImage(folderId, f, x, y)
              x += 24
              y += 24
            }
          }}
        />
        <span className="text-xs text-muted">
          Click empty space to start a note · paste (Ctrl+V) an image anywhere · drag the grip · resize
          from the corner
        </span>
      </div>

      {/* canvas */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto rounded-xl border border-dashed border-edge bg-raised/20"
        style={{ backgroundImage: 'radial-gradient(rgb(var(--wk-edge)/0.35) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
      >
        {/* a big inner surface so items can live far out and the area scrolls.
            Clicking it (never a child note) drops a note at the cursor. */}
        <div
          className="relative min-h-full cursor-text"
          style={{ width: 3000, height: 2000 }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return // ignore clicks on notes
            addNoteAt(e.clientX, e.clientY)
          }}
        >
          {items.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-center text-sm text-muted">
              Empty canvas — click anywhere to start a note, or paste an image.
            </div>
          )}
          {items.map((it) => (
            <CanvasNode key={it.id} item={it} autoFocus={it.id === focusId} />
          ))}
        </div>
      </div>
    </div>
  )
}

function CanvasNode({ item, autoFocus }: { item: CanvasItem; autoFocus?: boolean }): React.JSX.Element {
  const patch = useBoard((s) => s.patchCanvasItem)
  const persist = useBoard((s) => s.persistCanvasItem)
  const front = useBoard((s) => s.bringCanvasItemFront)
  const del = useBoard((s) => s.deleteCanvasItem)
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null)
  const resize = useRef<{ px: number; py: number; w: number; h: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Focus a just-created note so the user can type immediately.
  useEffect(() => {
    if (autoFocus) taRef.current?.focus()
  }, [autoFocus])

  const onDragDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    void front(item.id)
    drag.current = { px: e.clientX, py: e.clientY, x: item.x, y: item.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    patch(item.id, { x: Math.max(0, d.x + (e.clientX - d.px)), y: Math.max(0, d.y + (e.clientY - d.py)) })
  }
  const onDragUp = (): void => {
    if (drag.current) {
      drag.current = null
      void persist(item.id)
    }
  }

  const onResizeDown = (e: React.PointerEvent): void => {
    e.stopPropagation()
    resize.current = { px: e.clientX, py: e.clientY, w: item.w, h: item.h }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resize.current
    if (!r) return
    patch(item.id, {
      w: Math.max(MIN_W, r.w + (e.clientX - r.px)),
      h: Math.max(MIN_H, r.h + (e.clientY - r.py))
    })
  }
  const onResizeUp = (): void => {
    if (resize.current) {
      resize.current = null
      void persist(item.id)
    }
  }

  const url = item.kind === 'image' && item.imageId ? imgUrl(item.imageId) : null

  return (
    <div
      className="group absolute overflow-hidden rounded-lg border border-edge bg-surface shadow-lg"
      style={{ left: item.x, top: item.y, width: item.w, height: item.h, zIndex: item.z }}
      onPointerDown={() => void front(item.id)}
    >
      {/* grip / header */}
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        className="flex h-6 cursor-grab items-center gap-1 border-b border-edge bg-raised/70 px-1.5 active:cursor-grabbing"
      >
        <GripVertical size={13} className="text-muted" />
        <span className="flex-1 text-[10px] uppercase tracking-wide text-muted">{item.kind}</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void del(item.id)}
          title="Delete"
          className="rounded p-0.5 text-muted opacity-0 hover:bg-danger/15 hover:text-danger group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* body */}
      <div className="h-[calc(100%-1.5rem)] w-full">
        {item.kind === 'text' ? (
          <textarea
            ref={taRef}
            defaultValue={item.text}
            onChange={(e) => patch(item.id, { text: e.target.value })}
            onBlur={() => void persist(item.id)}
            placeholder="Type anything…"
            className="h-full w-full resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none"
          />
        ) : url ? (
          <img src={url} alt="" className="h-full w-full select-none object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">image missing</div>
        )}
      </div>

      {/* resize handle */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        title="Resize"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 50%, rgb(var(--wk-muted)/0.55) 50% 60%, transparent 60% 70%, rgb(var(--wk-muted)/0.55) 70% 80%, transparent 80%)'
        }}
      />
    </div>
  )
}
